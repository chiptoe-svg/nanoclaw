import { log } from '../../log.js';
import { remoteMailboxEnabled, warnIfRelayMustForwardMailbox } from './spawn.js';
import { startRemoteMailboxService } from './service.js';
import type { RemoteMailboxService } from './service.js';

export type { RemoteMailboxService };

/** Start the service only when at least one agent group opted in; otherwise do nothing. */
export async function startRemoteMailboxServiceIfEnabled(port: number): Promise<RemoteMailboxService | undefined> {
  if (!remoteMailboxEnabled()) return undefined;
  const service = await startRemoteMailboxService({ port });
  log.info('Remote mailbox service listening', { port: service.port });
  warnIfRelayMustForwardMailbox();
  return service;
}
