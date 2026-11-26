import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  addApprovedEndpoint,
  approvedEndpointsPath,
  isApprovableHost,
  operatorAllowPath,
  parseAllowEntry,
  readApprovedEndpoints,
  readOperatorAllow,
} from './approved-endpoints.js';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-approved-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('approved endpoint store', () => {
  it('is empty without a file, appends idempotently, and survives a re-read', () => {
    expect(readApprovedEndpoints(root, 'ag-1')).toEqual({ endpoints: [], rejected: [] });
    const at = new Date('2026-11-25T12:00:00.000Z');
    expect(addApprovedEndpoint(root, 'ag-1', { host: 'example.com', port: 443 }, at)).toBe(true);
    expect(addApprovedEndpoint(root, 'ag-1', { host: 'example.com', port: 443 }, at)).toBe(false);
    expect(addApprovedEndpoint(root, 'ag-1', { host: 'example.com', port: 8443 }, at)).toBe(true);
    expect(readApprovedEndpoints(root, 'ag-1').endpoints).toEqual([
      { host: 'example.com', port: 443, approvedAt: at.toISOString() },
      { host: 'example.com', port: 8443, approvedAt: at.toISOString() },
    ]);
    expect(fs.statSync(approvedEndpointsPath(root, 'ag-1')).mode & 0o777).toBe(0o600);
    expect(readApprovedEndpoints(root, 'ag-2').endpoints).toEqual([]);
  });

  it('skips (and reports) hand-edited entries that widen beyond one exact name and port', () => {
    const file = approvedEndpointsPath(root, 'ag-1');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        endpoints: [
          { host: 'ok.example.com', port: 443 },
          { host: '*.example.com', port: 443 },
          { host: '0.0.0.0', port: 443 },
          { host: 'ok.example.com', port: '443' },
        ],
      }),
    );
    const read = readApprovedEndpoints(root, 'ag-1');
    expect(read.endpoints.map((e) => e.host)).toEqual(['ok.example.com']);
    expect(read.rejected).toHaveLength(3);
  });

  it('throws on a malformed file and refuses to add what it would not merge', () => {
    const file = approvedEndpointsPath(root, 'ag-1');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"endpoints": 3}');
    expect(() => readApprovedEndpoints(root, 'ag-1')).toThrow(/expected/);
    expect(() => addApprovedEndpoint(root, 'ag-2', { host: '1.2.3.4', port: 443 })).toThrow(/not an approvable/);
  });

  it('keeps group ids inside the store directory', () => {
    expect(() => approvedEndpointsPath(root, '../etc')).toThrow(/invalid agent group id/);
    expect(() => approvedEndpointsPath(root, 'a/b')).toThrow(/invalid agent group id/);
  });

  it('accepts exact public DNS names only', () => {
    expect(isApprovableHost('api.example.co.uk')).toBe(true);
    for (const bad of [
      'example',
      'EXAMPLE.com',
      '*.x.com',
      'a..b.com',
      'host.docker.internal',
      'x.local',
      '1.2.3.4',
      '[::1]',
    ])
      expect(isApprovableHost(bad)).toBe(false);
  });
});

describe('operator allow-list', () => {
  it('parses host[:port], defaulting to 443, and allows two-label wildcards only', () => {
    expect(parseAllowEntry('*.untappd.com')).toEqual({ host: '*.untappd.com', port: 443 });
    expect(parseAllowEntry('Query1.Finance.Yahoo.com:443')).toEqual({ host: 'query1.finance.yahoo.com', port: 443 });
    expect(parseAllowEntry('example.com:8443')).toEqual({ host: 'example.com', port: 8443 });
    for (const bad of ['*.com', '*', '1.1.1.1', '*.printer.local', 'host.openshell.internal', 'a b', 'x.com:0', 42]) {
      expect(parseAllowEntry(bad)).toBeNull();
    }
  });

  it('reads the .allow.json beside the approvals, skipping bad entries and duplicates', () => {
    expect(readOperatorAllow(root, 'ag-1')).toEqual({ endpoints: [], rejected: [] });
    fs.mkdirSync(path.dirname(operatorAllowPath(root, 'ag-1')), { recursive: true });
    fs.writeFileSync(
      operatorAllowPath(root, 'ag-1'),
      JSON.stringify({ allow: ['*.untappd.com', '*.untappd.com:443', '*.com'] }),
    );
    expect(operatorAllowPath(root, 'ag-1')).toMatch(/openshell-policy\/ag-1\.allow\.json$/);
    expect(readOperatorAllow(root, 'ag-1')).toEqual({
      endpoints: [{ host: '*.untappd.com', port: 443 }],
      rejected: ['*.com'],
    });
  });
});
