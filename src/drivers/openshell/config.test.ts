import { describe, expect, it } from 'vitest';

import { parseOpenShellSizes } from './config.js';

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
