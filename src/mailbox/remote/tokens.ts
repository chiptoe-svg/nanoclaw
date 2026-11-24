/**
 * Per-session bearer tokens for the remote mailbox.
 *
 * Only sha256(token) is stored, in a file outside every session directory, so
 * no container can read it and verification is stateless across host restarts.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { isValidSessionKey, parseSessionHeader } from './ids.js';
import type { RemoteSessionKey } from './ids.js';

function tokensRoot(): string {
  return path.join(DATA_DIR, 'mailbox-tokens');
}

function tokenPath(key: RemoteSessionKey): string {
  return path.join(tokensRoot(), key.agentGroupId, key.sessionId);
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

const DUMMY_HASH = hashToken('nanoclaw-mailbox-dummy');

/** Issue (or replace) the token for one session. Returns the plaintext token; it is never stored. */
export function issueMailboxToken(key: RemoteSessionKey): string {
  if (!isValidSessionKey(key)) throw new Error('invalid mailbox session key');
  const token = crypto.randomBytes(32).toString('base64url');
  const file = tokenPath(key);
  const dir = path.dirname(file);
  fs.mkdirSync(tokensRoot(), { recursive: true, mode: 0o700 });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, hashToken(token), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  return token;
}

export function revokeMailboxToken(key: RemoteSessionKey): void {
  if (!isValidSessionKey(key)) return;
  fs.rmSync(tokenPath(key), { force: true });
}

/**
 * Verify an `authorization` header against the session named by
 * `x-nanoclaw-session`. Returns the session key, or null for any failure
 * (malformed header, unknown session, wrong token) without distinguishing them.
 */
export function verifyMailboxToken(authHeader: unknown, sessionHeader: unknown): RemoteSessionKey | null {
  const key = parseSessionHeader(sessionHeader);
  const match = typeof authHeader === 'string' ? /^Bearer ([A-Za-z0-9_-]{1,256})$/.exec(authHeader) : null;
  let stored: string | null = null;
  if (key) {
    try {
      const raw = fs.readFileSync(tokenPath(key), 'utf8').trim();
      if (/^[0-9a-f]{64}$/.test(raw)) stored = raw;
    } catch {
      stored = null;
    }
  }
  // Always hash and compare so a missing session costs the same as a wrong token.
  const presented = Buffer.from(hashToken(match ? match[1] : ''), 'hex');
  const expected = Buffer.from(stored ?? DUMMY_HASH, 'hex');
  const equal = crypto.timingSafeEqual(presented, expected);
  return key && match && stored && equal ? key : null;
}
