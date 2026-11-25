import { describe, expect, it } from 'vitest';

import { DEFAULT_EVICT_IDLE_SECONDS, parseEvictIdleSeconds, parseOpenShellSizes } from './config.js';

describe('parseOpenShellSizes', () => {
  it('reads <group>:<memoryMb>[:<cpus>] entries', () => {
    expect([...parseOpenShellSizes('ag-1:1024:1, ag-2:768,ag-3:2048:500m')]).toEqual([
      ['ag-1', { memoryMb: 1024, cpus: '1' }],
      ['ag-2', { memoryMb: 768 }],
      ['ag-3', { memoryMb: 2048, cpus: '500m' }],
    ]);
  });

  it('skips malformed entries', () => {
    expect([...parseOpenShellSizes('ag-1:lots,ag-2:64,ag-3:1024:x,ag-4:1024:1:9,:1024,')]).toEqual([]);
  });
});

describe('parseEvictIdleSeconds', () => {
  it('defaults, accepts 0 (off) and whole seconds, and ignores junk', () => {
    expect(parseEvictIdleSeconds('')).toBe(DEFAULT_EVICT_IDLE_SECONDS);
    expect(parseEvictIdleSeconds('0')).toBe(0);
    expect(parseEvictIdleSeconds('300')).toBe(300);
    expect(parseEvictIdleSeconds('-5')).toBe(DEFAULT_EVICT_IDLE_SECONDS);
    expect(parseEvictIdleSeconds('soon')).toBe(DEFAULT_EVICT_IDLE_SECONDS);
  });
});
