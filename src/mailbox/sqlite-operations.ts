/**
 * The agent side of a session mailbox, as SQL over its two files: inbound.db
 * (read-only here) and outbound.db (written here).
 *
 * Edit `src/mailbox/sqlite-operations.ts` only, then run `pnpm mailbox-model:generate`.
 * The runner copy (`sqlite-operations.generated.ts`, importing `./model.generated.js`)
 * runs this against its mounted files with bun:sqlite; the host's remote mailbox
 * service runs it with better-sqlite3 for runners that can't mount the files.
 * Keep it free of runtime imports other than the model so it compiles in both trees.
 */
import {
  createOutboundRecord,
  parseContainerRecord,
  parseDestinationRecord,
  parseInboundRecord,
  parseOutboundRecord,
  parseSessionRoutingRecord,
  parseStateRecord,
} from './model.js';
import type {
  DestinationRecord,
  InboundRecord,
  OutboundRecord,
  OutboundWrite,
  ProcessingStatus,
  SessionRoutingRecord,
  StateRecord,
} from './model.js';

/** The statement surface bun:sqlite and better-sqlite3 share (positional parameters only). */
export interface SqlStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
}

export interface SqlDatabase {
  prepare(sql: string): SqlStatement;
  exec(sql: string): unknown;
}

export interface SessionDatabases {
  /** Run `read` against inbound.db. `read` must return materialized rows and may run more than once. */
  readInbound<T>(read: (db: SqlDatabase) => T): T;
  /** Run `write` against outbound.db. */
  withOutbound<T>(write: (db: SqlDatabase) => T): T;
  /** Called for an inbound row that fails validation; the row is skipped. */
  onInvalidRow?(id: string, error: unknown): void;
}

export interface SessionMailboxOperations {
  getPendingMessages(limit: number, isFirstPoll: boolean): InboundRecord[];
  markMessages(ids: string[], status: ProcessingStatus): void;
  markScriptSkipped(skips: Array<{ id: string; reason: string }>): void;
  getMessageIn(id: string): InboundRecord | undefined;
  findQuestionResponse(questionId: string): InboundRecord | undefined;
  findCliResponse(requestId: string): InboundRecord | undefined;
  writeMessageOut(message: OutboundWrite): number;
  getMessageIdBySeq(sequence: number): string | null;
  getRoutingBySeq(sequence: number): SessionRoutingRecord | null;
  getLatestInboundRoute(channelType: string, platformId: string): { threadId: string | null; inReplyTo: string } | null;
  getUndeliveredMessages(): OutboundRecord[];
  getDeliveryStatus(messageOutId: string): 'delivered' | 'failed' | null;
  getState(key: string): Omit<StateRecord, 'key'> | undefined;
  setState(key: string, value: string): void;
  deleteState(key: string): void;
  getSessionRouting(): SessionRoutingRecord;
  getDestinations(): DestinationRecord[];
  findDestinationByName(name: string): DestinationRecord | undefined;
  findDestinationByRouting(channelType: string, platformId: string): DestinationRecord | undefined;
  setContainerToolInFlight(tool: string, declaredTimeoutMs: number | null): void;
  clearContainerToolInFlight(): void;
  clearStaleProcessingAcks(): void;
}

interface MessageInRow {
  id: string;
  seq: number | null;
  kind: string;
  timestamp: string;
  status: string;
  process_after: string | null;
  recurrence: string | null;
  series_id: string | null;
  tries: number;
  trigger: number;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
  source_session_id: string | null;
  on_wake?: number;
}

interface MessageOutRow {
  id: string;
  seq: number | null;
  in_reply_to: string | null;
  timestamp: string;
  deliver_after: string | null;
  recurrence: string | null;
  kind: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
}

interface DestinationRow {
  name: string;
  display_name: string | null;
  type: 'channel' | 'agent';
  channel_type: string | null;
  platform_id: string | null;
  agent_group_id: string | null;
}

interface RoutingRow {
  channel_type: string | null;
  platform_id: string | null;
  thread_id: string | null;
}

const SQLITE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

export function sqliteTimestamp(value: string): string {
  const source = SQLITE_TIMESTAMP.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  const milliseconds = Date.parse(source);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : value;
}

/** One row or undefined: bun:sqlite returns null for no row, better-sqlite3 undefined. */
function one<T>(db: SqlDatabase, sql: string, ...params: unknown[]): T | undefined {
  return (db.prepare(sql).get(...params) ?? undefined) as T | undefined;
}

function inboundMessage(row: MessageInRow): InboundRecord {
  return parseInboundRecord({
    id: row.id,
    sequence: row.seq,
    kind: row.kind,
    timestamp: sqliteTimestamp(row.timestamp),
    status: row.status,
    processAfter: row.process_after === null ? null : sqliteTimestamp(row.process_after),
    recurrence: row.recurrence,
    seriesId: row.series_id ?? null,
    tries: row.tries,
    trigger: row.trigger === 1,
    platformId: row.platform_id,
    channelType: row.channel_type,
    threadId: row.thread_id,
    content: row.content,
    sourceSessionId: row.source_session_id ?? null,
    onWake: row.on_wake === 1,
  });
}

function outboundMessage(row: MessageOutRow): OutboundRecord {
  return parseOutboundRecord({
    id: row.id,
    sequence: row.seq,
    inReplyTo: row.in_reply_to,
    timestamp: sqliteTimestamp(row.timestamp),
    deliverAfter: row.deliver_after === null ? null : sqliteTimestamp(row.deliver_after),
    recurrence: row.recurrence,
    kind: row.kind,
    platformId: row.platform_id,
    channelType: row.channel_type,
    threadId: row.thread_id,
    content: row.content,
  });
}

function destination(row: DestinationRow): DestinationRecord {
  return parseDestinationRecord({
    name: row.name,
    displayName: row.display_name,
    type: row.type,
    channelType: row.channel_type,
    platformId: row.platform_id,
    agentGroupId: row.agent_group_id,
  });
}

function routing(row: RoutingRow): SessionRoutingRecord {
  return parseSessionRoutingRecord({
    channelType: row.channel_type,
    platformId: row.platform_id,
    threadId: row.thread_id,
  });
}

function transaction<T>(db: SqlDatabase, body: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = body();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

const UPSERT_CONTAINER_STATE = `INSERT INTO container_state (id, current_tool, tool_declared_timeout_ms, tool_started_at, updated_at)
   VALUES (1, ?, ?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET
     current_tool = excluded.current_tool,
     tool_declared_timeout_ms = excluded.tool_declared_timeout_ms,
     tool_started_at = excluded.tool_started_at,
     updated_at = excluded.updated_at`;

export function createSessionMailboxOperations(dbs: SessionDatabases): SessionMailboxOperations {
  const { readInbound, withOutbound } = dbs;
  let hasOnWake: boolean | null = null;

  const ack = (entries: Array<[string, string]>): void => {
    if (entries.length === 0) return;
    withOutbound((db) =>
      transaction(db, () => {
        const statement = db.prepare(
          'INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)',
        );
        for (const [id, status] of entries) statement.run(id, status, new Date().toISOString());
      }),
    );
  };

  const markScriptSkipped = (skips: Array<{ id: string; reason: string }>): void =>
    ack(skips.map(({ id, reason }) => [id, reason === 'error' ? 'script-skip:error' : 'completed']));

  const pendingResponse = (field: 'questionId' | 'requestId', value: string): MessageInRow | undefined =>
    readInbound((db) =>
      one<MessageInRow>(
        db,
        "SELECT * FROM messages_in WHERE status = 'pending' AND content LIKE ?",
        `%"${field}":"${value}"%`,
      ),
    );

  return {
    getPendingMessages(limit, isFirstPoll) {
      const pending = readInbound((db) => {
        hasOnWake ??= (db.prepare("PRAGMA table_info('messages_in')").all() as Array<{ name: string }>).some(
          ({ name }) => name === 'on_wake',
        );
        return db
          .prepare(
            `SELECT * FROM messages_in
             WHERE status = 'pending'
               AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))
               ${hasOnWake ? 'AND (on_wake = 0 OR ? = 1)' : ''}
             ORDER BY seq ASC`,
          )
          .all(...(hasOnWake ? [isFirstPoll ? 1 : 0] : [])) as MessageInRow[];
      });
      if (pending.length === 0) return [];
      const acked = new Set(
        withOutbound(
          (db) => db.prepare('SELECT message_id FROM processing_ack').all() as Array<{ message_id: string }>,
        ).map(({ message_id }) => message_id),
      );
      const unclaimed = pending.filter(({ id }) => !acked.has(id));
      const wake = unclaimed.filter(({ trigger }) => trigger === 1).slice(0, limit);
      const remaining = limit - wake.length;
      const context = remaining > 0 ? unclaimed.filter(({ trigger }) => trigger === 0).slice(-remaining) : [];
      return [...wake, ...context]
        .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
        .flatMap((row) => {
          try {
            return [inboundMessage(row)];
          } catch (error) {
            dbs.onInvalidRow?.(row.id, error);
            return [];
          }
        });
    },

    markMessages(ids, status) {
      if (status === 'script-skip:error') markScriptSkipped(ids.map((id) => ({ id, reason: 'error' })));
      else ack(ids.map((id) => [id, status]));
    },

    markScriptSkipped,

    getMessageIn(id) {
      const row = readInbound((db) => one<MessageInRow>(db, 'SELECT * FROM messages_in WHERE id = ?', id));
      return row && inboundMessage(row);
    },

    findQuestionResponse(questionId) {
      const response = pendingResponse('questionId', questionId);
      if (!response) return undefined;
      const acknowledged = withOutbound((db) =>
        one(db, 'SELECT 1 FROM processing_ack WHERE message_id = ?', response.id),
      );
      return acknowledged ? undefined : inboundMessage(response);
    },

    findCliResponse(requestId) {
      const row = pendingResponse('requestId', requestId);
      return row && inboundMessage(row);
    },

    writeMessageOut(message) {
      const maxIn = readInbound(
        (db) => one<{ value: number }>(db, 'SELECT COALESCE(MAX(seq), 0) AS value FROM messages_in')!.value,
      );
      return withOutbound((db) =>
        transaction(db, () => {
          const maxOut = one<{ value: number }>(db, 'SELECT COALESCE(MAX(seq), 0) AS value FROM messages_out')!.value;
          const max = Math.max(maxOut, maxIn);
          const sequence = max % 2 === 0 ? max + 1 : max + 2;
          const record = createOutboundRecord(message, sequence, new Date().toISOString());
          // A remote runner retrying after a lost response resends the same draft:
          // answer with the sequence already allocated instead of failing on the id.
          const existing = one<{ seq: number | null }>(db, 'SELECT seq FROM messages_out WHERE id = ?', record.id);
          if (existing && existing.seq !== null) return existing.seq;
          db.prepare(
            `INSERT INTO messages_out
               (id, seq, in_reply_to, timestamp, deliver_after, recurrence, kind, platform_id, channel_type, thread_id, content)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            record.id,
            record.sequence,
            record.inReplyTo,
            record.timestamp,
            record.deliverAfter,
            record.recurrence,
            record.kind,
            record.platformId,
            record.channelType,
            record.threadId,
            record.content,
          );
          return sequence;
        }),
      );
    },

    getMessageIdBySeq(sequence) {
      const inboundRow = readInbound((db) =>
        one<{ id: string }>(db, 'SELECT id FROM messages_in WHERE seq = ?', sequence),
      );
      if (inboundRow) return inboundRow.id;
      const outboundRow = withOutbound((db) =>
        one<{ id: string }>(db, 'SELECT id FROM messages_out WHERE seq = ?', sequence),
      );
      if (!outboundRow) return null;
      const delivered = readInbound((db) =>
        one<{ platform_message_id: string | null }>(
          db,
          'SELECT platform_message_id FROM delivered WHERE message_out_id = ?',
          outboundRow.id,
        ),
      );
      return delivered?.platform_message_id || outboundRow.id;
    },

    getRoutingBySeq(sequence) {
      const row =
        readInbound((db) =>
          one<RoutingRow>(db, 'SELECT channel_type, platform_id, thread_id FROM messages_in WHERE seq = ?', sequence),
        ) ??
        withOutbound((db) =>
          one<RoutingRow>(db, 'SELECT channel_type, platform_id, thread_id FROM messages_out WHERE seq = ?', sequence),
        );
      return row ? routing(row) : null;
    },

    getLatestInboundRoute(channelType, platformId) {
      const row = readInbound((db) =>
        one<{ id: string; thread_id: string | null }>(
          db,
          `SELECT id, thread_id FROM messages_in
           WHERE channel_type = ? AND platform_id = ?
           ORDER BY seq DESC LIMIT 1`,
          channelType,
          platformId,
        ),
      );
      return row ? { threadId: row.thread_id, inReplyTo: row.id } : null;
    },

    getUndeliveredMessages() {
      return withOutbound(
        (db) =>
          db
            .prepare(
              `SELECT * FROM messages_out
               WHERE (deliver_after IS NULL OR datetime(deliver_after) <= datetime('now'))
               ORDER BY timestamp ASC`,
            )
            .all() as MessageOutRow[],
      ).map(outboundMessage);
    },

    getDeliveryStatus(messageOutId) {
      const row = readInbound((db) =>
        one<{ status: string }>(db, 'SELECT status FROM delivered WHERE message_out_id = ?', messageOutId),
      );
      if (!row) return null;
      return row.status === 'failed' ? 'failed' : 'delivered';
    },

    getState(key) {
      const row = withOutbound((db) =>
        one<{ value: string; updated_at: string }>(
          db,
          'SELECT value, updated_at FROM session_state WHERE key = ?',
          key,
        ),
      );
      if (!row) return undefined;
      const record = parseStateRecord({ key, value: row.value, updatedAt: sqliteTimestamp(row.updated_at) });
      return { value: record.value, updatedAt: record.updatedAt };
    },

    setState(key, value) {
      withOutbound((db) =>
        db
          .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
          .run(key, value, new Date().toISOString()),
      );
    },

    deleteState(key) {
      withOutbound((db) => db.prepare('DELETE FROM session_state WHERE key = ?').run(key));
    },

    getSessionRouting() {
      const row = readInbound((db) =>
        one(db, "SELECT 1 FROM sqlite_master WHERE name = 'session_routing'")
          ? one<RoutingRow>(db, 'SELECT channel_type, platform_id, thread_id FROM session_routing WHERE id = 1')
          : undefined,
      );
      return routing(row ?? { channel_type: null, platform_id: null, thread_id: null });
    },

    getDestinations() {
      return readInbound((db) => db.prepare('SELECT * FROM destinations ORDER BY name').all() as DestinationRow[]).map(
        destination,
      );
    },

    findDestinationByName(name) {
      const row = readInbound((db) => one<DestinationRow>(db, 'SELECT * FROM destinations WHERE name = ?', name));
      return row && destination(row);
    },

    findDestinationByRouting(channelType, platformId) {
      const row = readInbound((db) =>
        channelType === 'agent'
          ? one<DestinationRow>(
              db,
              "SELECT * FROM destinations WHERE type = 'agent' AND agent_group_id = ?",
              platformId,
            )
          : one<DestinationRow>(
              db,
              "SELECT * FROM destinations WHERE type = 'channel' AND channel_type = ? AND platform_id = ?",
              channelType,
              platformId,
            ),
      );
      return row && destination(row);
    },

    setContainerToolInFlight(tool, declaredTimeoutMs) {
      const timeout =
        declaredTimeoutMs !== null && Number.isSafeInteger(declaredTimeoutMs) && declaredTimeoutMs >= 0
          ? declaredTimeoutMs
          : null;
      const now = new Date().toISOString();
      const record = parseContainerRecord({
        currentTool: tool,
        toolDeclaredTimeoutMs: timeout,
        toolStartedAt: now,
        updatedAt: now,
      });
      withOutbound((db) =>
        db.prepare(UPSERT_CONTAINER_STATE).run(record.currentTool, record.toolDeclaredTimeoutMs, now, now),
      );
    },

    clearContainerToolInFlight() {
      withOutbound((db) => db.prepare(UPSERT_CONTAINER_STATE).run(null, null, null, new Date().toISOString()));
    },

    clearStaleProcessingAcks() {
      withOutbound((db) => db.prepare("DELETE FROM processing_ack WHERE status = 'processing'").run());
    },
  };
}
