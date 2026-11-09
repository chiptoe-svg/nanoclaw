/**
 * Startup rebuild of per-agent-group images: an image whose derived-from label
 * no longer matches the current base (or is missing) is rebuilt; a current
 * one, an operator-set tag, and a runtime without image builds are left alone.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { inspect, configs, capabilities } = vi.hoisted(() => ({
  inspect: new Map<string, string>(),
  configs: [] as Array<{ agent_group_id: string; image_tag: string | null }>,
  capabilities: { imageBuild: true } as Record<string, boolean>,
}));

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  const exec = (cmd: string, cb: (err: Error | null, out?: { stdout: string; stderr: string }) => void) => {
    const ref = cmd.split(' ').pop()!;
    const out = inspect.get(cmd.includes('derived-from') ? `label:${ref}` : `id:${ref}`);
    if (out === undefined) cb(new Error(`No such image: ${ref}`));
    else cb(null, { stdout: `${out}\n`, stderr: '' });
  };
  // promisify(exec) resolves with the callback's second argument.
  return { ...actual, exec };
});
vi.mock('./drivers/index.js', () => ({
  getSessionDriver: () => ({ kind: 'fake', capabilities: () => capabilities }),
  isSessionEventsDriver: () => false,
}));
vi.mock('./db/container-configs.js', async () => {
  const actual = await vi.importActual<typeof import('./db/container-configs.js')>('./db/container-configs.js');
  return { ...actual, getAllContainerConfigs: async () => configs };
});

import { CONTAINER_IMAGE, CONTAINER_IMAGE_BASE } from './config.js';
import { rebuildStaleAgentGroupImages } from './container-runner.js';

const tag = (id: string) => `${CONTAINER_IMAGE_BASE}:${id}`;

beforeEach(() => {
  inspect.clear();
  configs.length = 0;
  capabilities.imageBuild = true;
  inspect.set(`id:${CONTAINER_IMAGE}`, 'sha256:new');
});

describe('rebuildStaleAgentGroupImages', () => {
  it('rebuilds images on an old base, missing a label, or missing entirely', async () => {
    configs.push(
      { agent_group_id: 'ag-old', image_tag: tag('ag-old') },
      { agent_group_id: 'ag-unlabeled', image_tag: tag('ag-unlabeled') },
      { agent_group_id: 'ag-gone', image_tag: tag('ag-gone') },
      { agent_group_id: 'ag-current', image_tag: tag('ag-current') },
    );
    inspect.set(`label:${tag('ag-old')}`, 'sha256:old');
    inspect.set(`label:${tag('ag-unlabeled')}`, '<no value>');
    inspect.set(`label:${tag('ag-current')}`, 'sha256:new');
    const build = vi.fn(async (_id: string) => {});
    await rebuildStaleAgentGroupImages(build);
    expect(build.mock.calls.map(([id]) => id)).toEqual(['ag-old', 'ag-unlabeled', 'ag-gone']);
  });

  it('leaves groups without a derived image or with an operator-set tag alone', async () => {
    configs.push(
      { agent_group_id: 'ag-plain', image_tag: null },
      { agent_group_id: 'ag-custom', image_tag: 'registry.example/custom:1' },
    );
    const build = vi.fn(async (_id: string) => {});
    await rebuildStaleAgentGroupImages(build);
    expect(build).not.toHaveBeenCalled();
  });

  it('keeps going after a failed build', async () => {
    configs.push(
      { agent_group_id: 'ag-a', image_tag: tag('ag-a') },
      { agent_group_id: 'ag-b', image_tag: tag('ag-b') },
    );
    const build = vi.fn(async (id: string) => {
      if (id === 'ag-a') throw new Error('apt failed');
    });
    await rebuildStaleAgentGroupImages(build);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('does nothing on a runtime without image builds or without a base image', async () => {
    configs.push({ agent_group_id: 'ag-old', image_tag: tag('ag-old') });
    const build = vi.fn(async (_id: string) => {});
    capabilities.imageBuild = false;
    await rebuildStaleAgentGroupImages(build);
    capabilities.imageBuild = true;
    inspect.delete(`id:${CONTAINER_IMAGE}`);
    await rebuildStaleAgentGroupImages(build);
    expect(build).not.toHaveBeenCalled();
  });
});
