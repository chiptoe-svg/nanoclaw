/**
 * Host-side execution of the runner's `MailboxOperations` against one
 * session's inbound.db / outbound.db, through the same SQL the runner runs on
 * its mounted files (`../sqlite-operations.ts`). Handles are opened per
 * operation and closed after, like the rest of the host.
 */
import Database from 'better-sqlite3';
import fs from 'fs';

import { log } from '../../log.js';
import { inboundDbPath, outboundDbPath } from '../sqlite/paths.js';
import { OUTBOUND_SCHEMA } from '../sqlite/schema.js';
import {
  createSessionMailboxOperations,
  type SessionMailboxOperations,
  type SqlDatabase,
} from '../sqlite-operations.js';
import type { RemoteSessionKey } from './ids.js';

export { sqliteTimestamp } from '../sqlite-operations.js';

export class SessionUnavailableError extends Error {
  constructor(message = 'session mailbox unavailable') {
    super(message);
    this.name = 'SessionUnavailableError';
  }
}

export type SessionOperations = SessionMailboxOperations;

function withDb<T>(file: string, readonly: boolean, use: (db: SqlDatabase) => T): T {
  if (!fs.existsSync(file)) throw new SessionUnavailableError();
  const db = new Database(file, { readonly, fileMustExist: true });
  try {
    db.pragma('busy_timeout = 5000');
    if (!readonly) {
      db.pragma('journal_mode = DELETE');
      db.pragma('foreign_keys = ON');
      // Forward-compat for older outbound.db files (session_state / container_state added later).
      db.exec(OUTBOUND_SCHEMA);
    }
    return use(db);
  } finally {
    db.close();
  }
}

export function createSessionOperations(key: RemoteSessionKey): SessionOperations {
  return createSessionMailboxOperations({
    readInbound: (read) => withDb(inboundDbPath(key.agentGroupId, key.sessionId), true, read),
    withOutbound: (write) => withDb(outboundDbPath(key.agentGroupId, key.sessionId), false, write),
    onInvalidRow: (id, error) => log.error('Skipping invalid inbound mailbox row', { id, err: String(error) }),
  });
}
