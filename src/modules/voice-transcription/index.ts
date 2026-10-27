/**
 * Voice transcription module — transcribes inbound voice notes on the host
 * with whisper.cpp and prepends `[Voice: <transcript>]` to the message text,
 * so the agent reads what was said instead of an opaque audio file.
 *
 * Runs as a message interceptor that never claims the message: it rewrites
 * event.message.content in place and lets routing continue. The audio
 * attachment is left in place. Any failure leaves the message untouched.
 *
 * Config: WHISPER_BIN (default whisper-cli), WHISPER_MODEL
 * (default data/models/ggml-base.bin). Needs ffmpeg on PATH.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { DATA_DIR } from '../../config.js';
import { log } from '../../log.js';
import { registerMessageInterceptor } from '../../router.js';

const execFileAsync = promisify(execFile);

const WHISPER_BIN = process.env.WHISPER_BIN || 'whisper-cli';
const WHISPER_MODEL = process.env.WHISPER_MODEL || path.join(DATA_DIR, 'models', 'ggml-base.bin');
const FALLBACK = '[Voice message - transcription unavailable]';

interface Attachment {
  type?: string;
  mimeType?: string;
  data?: string;
}

function isAudio(att: Attachment): boolean {
  return att.type === 'audio' || (att.mimeType ?? '').startsWith('audio/');
}

async function transcribe(audio: Buffer): Promise<string | null> {
  const id = `nanoclaw-voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const src = path.join(os.tmpdir(), `${id}.audio`);
  const wav = path.join(os.tmpdir(), `${id}.wav`);
  try {
    fs.writeFileSync(src, audio);
    // whisper.cpp wants 16kHz mono WAV; Telegram voice notes are ogg/opus
    await execFileAsync('ffmpeg', ['-i', src, '-ar', '16000', '-ac', '1', '-f', 'wav', '-y', wav], {
      timeout: 30_000,
    });
    const { stdout } = await execFileAsync(WHISPER_BIN, ['-m', WHISPER_MODEL, '-f', wav, '-nt'], {
      timeout: 120_000,
    });
    return stdout.trim() || null;
  } catch (err) {
    log.warn('Voice transcription failed', { err });
    return null;
  } finally {
    for (const f of [src, wav]) fs.rmSync(f, { force: true });
  }
}

registerMessageInterceptor(async (event) => {
  let content: Record<string, unknown>;
  try {
    content = JSON.parse(event.message.content);
  } catch {
    return false;
  }
  const attachments = Array.isArray(content.attachments) ? (content.attachments as Attachment[]) : [];
  const audio = attachments.filter((a) => isAudio(a) && a.data);
  if (audio.length === 0) return false;

  const lines: string[] = [];
  for (const att of audio) {
    const transcript = await transcribe(Buffer.from(att.data!, 'base64'));
    lines.push(transcript ? `[Voice: ${transcript}]` : FALLBACK);
  }
  log.info('Voice note transcribed', { platformId: event.platformId, count: audio.length });

  const text = typeof content.text === 'string' ? content.text : '';
  content.text = text ? `${lines.join('\n')}\n\n${text}` : lines.join('\n');
  event.message.content = JSON.stringify(content);
  return false;
});
