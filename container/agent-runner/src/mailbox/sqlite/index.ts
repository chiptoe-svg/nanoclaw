import { closeSessionDb, getOutboundDb, readInbound } from './connection.js';
import { createSessionMailboxOperations } from '../sqlite-operations.generated.js';
import type { AgentMailbox, MailboxOperations, MailboxSessionKey } from '../types.js';

// The operations are assigned in the constructor; this declares them on the class.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unsafe-declaration-merging
export interface SqliteAgentMailbox extends MailboxOperations {}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class SqliteAgentMailbox implements AgentMailbox {
  readonly operations: MailboxOperations = this;

  constructor() {
    const operations = createSessionMailboxOperations({
      readInbound: (read) => readInbound(read),
      withOutbound: (write) => write(getOutboundDb()),
      onInvalidRow: (id, error) =>
        console.error(`[agent-runner] Skipping invalid inbound mailbox row ${id}: ${String(error)}`),
    });
    Object.assign(this, operations, {
      writeMessageOut: async (message: Parameters<MailboxOperations['writeMessageOut']>[0]) =>
        operations.writeMessageOut(message),
    });
  }

  shouldRestartAfter(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return (
      message.includes('database disk image is malformed') ||
      message.includes('SQLITE_CORRUPT') ||
      message.includes('file is not a database')
    );
  }

  async start(_key: MailboxSessionKey | null): Promise<void> {}

  async run<T>(action: () => T | Promise<T>): Promise<T> {
    return action();
  }

  async stop(): Promise<void> {
    closeSessionDb();
  }
}
