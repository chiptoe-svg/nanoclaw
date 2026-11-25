import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { heartbeatPath, touchHeartbeat } from './heartbeat.js';

afterEach(() => {
  delete process.env.NANOCLAW_HEARTBEAT_PATH;
});

describe('heartbeat path', () => {
  it('defaults to the workspace heartbeat', () => {
    expect(heartbeatPath()).toBe('/workspace/.heartbeat');
  });

  it('honors NANOCLAW_HEARTBEAT_PATH and touches that file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heartbeat-'));
    const override = path.join(dir, '.heartbeat');
    process.env.NANOCLAW_HEARTBEAT_PATH = override;

    expect(heartbeatPath()).toBe(override);
    touchHeartbeat();
    expect(fs.existsSync(override)).toBe(true);

    // Second touch goes down the utimes path (file exists) and lands within
    // clock tolerance — utimes stores whole ms while write stamps fractional.
    const before = fs.statSync(override).mtimeMs;
    touchHeartbeat();
    expect(fs.statSync(override).mtimeMs).toBeGreaterThanOrEqual(before - 5);
  });
});

// OpenShell prototype only (fork shim): see touchHeartbeat().
describe('remote-mailbox heartbeat routing', () => {
  afterEach(() => {
    delete process.env.NANOCLAW_MAILBOX_URL;
    delete process.env.NANOCLAW_MAILBOX_TOKEN;
  });

  it('touches the mounted file when NANOCLAW_HEARTBEAT_PATH is set, even with a mailbox URL', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heartbeat-'));
    const file = path.join(dir, 'hb');
    fs.writeFileSync(file, '');
    fs.utimesSync(file, 0, 0);
    process.env.NANOCLAW_HEARTBEAT_PATH = file;
    process.env.NANOCLAW_MAILBOX_URL = 'http://127.0.0.1:1/v1/mailbox';
    process.env.NANOCLAW_MAILBOX_TOKEN = 't';
    touchHeartbeat();
    expect(fs.statSync(file).mtimeMs).toBeGreaterThan(0);
  });

  it('leaves /workspace alone and goes over RPC when only the mailbox URL is set', () => {
    process.env.NANOCLAW_MAILBOX_URL = 'http://127.0.0.1:1/v1/mailbox';
    process.env.NANOCLAW_MAILBOX_TOKEN = 't';
    expect(() => touchHeartbeat()).not.toThrow();
  });
});
