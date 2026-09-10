import 'server-only';
import { BaseCheckpointSaver, type Checkpoint, type CheckpointListOptions, type CheckpointMetadata, type CheckpointTuple, type PendingWrite, type SerializerProtocol } from '@langchain/langgraph-checkpoint';
import type { RunnableConfig } from '@langchain/core/runnables';
import { getDb } from '../db/client';

/**
 * LANGGRAPH CHECKPOINTS IN SIDEQUEST'S OWN DATABASE.
 *
 * PRODUCTION LOCK V5 §35. A refinement that stops to ask the traveller one
 * question has to survive the answer arriving in a different request, and a
 * server restart in between, so an in-memory saver cannot go to production.
 *
 * ## Why this is hand-written
 *
 * `@langchain/langgraph-checkpoint-sqlite` depends on `better-sqlite3@^12`; this
 * repository is on `^13`. Installing it puts a **second native SQLite build** in
 * the process, opening the same WAL file through a different library — a class of
 * bug that shows up as intermittent corruption rather than as an error.
 * `BaseCheckpointSaver` is the officially supported extension point and is five
 * methods wide, so using it costs less than the risk of avoiding it, and it keeps
 * one database, one native module, one connection, one set of pragmas and one
 * migration story (`db/schema.ts#REFINEMENT_SCHEMA_SQL`).
 *
 * ## What a thread is
 *
 * `sidequest:{tripId}` — see `threads.ts`. **A thread id is not
 * authorization** (§61): every row here is scoped to a trip by a real foreign
 * key, and every caller checks the trip's owner before it constructs a thread id
 * at all. Nothing personal goes in the id.
 *
 * ## Serialisation
 *
 * The serde's own bytes and its type tag are stored side by side, so a serde
 * change is detectable rather than silently misread. Values are stored as BLOBs
 * because that is what the protocol produces; nothing here interprets them.
 */
export class SqliteRefinementCheckpointer extends BaseCheckpointSaver {
  /** The trip every checkpoint written through this instance belongs to. */
  private readonly tripId: string;

  constructor(tripId: string, serde?: SerializerProtocol) {
    super(serde);
    this.tripId = tripId;
  }

  private static threadOf(config: RunnableConfig): { threadId: string; ns: string; checkpointId?: string } {
    const configurable = (config.configurable ?? {}) as Record<string, unknown>;
    const threadId = typeof configurable.thread_id === 'string' ? configurable.thread_id : '';
    const ns = typeof configurable.checkpoint_ns === 'string' ? configurable.checkpoint_ns : '';
    const checkpointId = typeof configurable.checkpoint_id === 'string' ? configurable.checkpoint_id : undefined;
    return { threadId, ns, ...(checkpointId ? { checkpointId } : {}) };
  }

  private async tupleFromRow(row: CheckpointRow): Promise<CheckpointTuple> {
    const checkpoint = (await this.serde.loadsTyped(row.type, row.checkpoint)) as Checkpoint;
    const metadata = (await this.serde.loadsTyped(row.type, row.metadata)) as CheckpointMetadata;
    const writes = getDb()
      .prepare(
        `SELECT task_id, channel, type, value FROM refinement_writes
          WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
          ORDER BY task_id, idx`,
      )
      .all(row.thread_id, row.checkpoint_ns, row.checkpoint_id) as WriteRow[];
    const pendingWrites = await Promise.all(
      writes.map(async (write) => [write.task_id, write.channel, await this.serde.loadsTyped(write.type, write.value)] as [string, string, unknown]),
    );
    return {
      config: { configurable: { thread_id: row.thread_id, checkpoint_ns: row.checkpoint_ns, checkpoint_id: row.checkpoint_id } },
      checkpoint,
      metadata,
      ...(row.parent_id ? { parentConfig: { configurable: { thread_id: row.thread_id, checkpoint_ns: row.checkpoint_ns, checkpoint_id: row.parent_id } } } : {}),
      ...(pendingWrites.length > 0 ? { pendingWrites } : {}),
    };
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const { threadId, ns, checkpointId } = SqliteRefinementCheckpointer.threadOf(config);
    if (!threadId) return undefined;
    const row = checkpointId
      ? (getDb().prepare('SELECT * FROM refinement_checkpoints WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?').get(threadId, ns, checkpointId) as CheckpointRow | undefined)
      : (getDb().prepare('SELECT * FROM refinement_checkpoints WHERE thread_id = ? AND checkpoint_ns = ? ORDER BY checkpoint_id DESC LIMIT 1').get(threadId, ns) as CheckpointRow | undefined);
    if (!row) return undefined;
    return this.tupleFromRow(row);
  }

  async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    const { threadId, ns } = SqliteRefinementCheckpointer.threadOf(config);
    if (!threadId) return;
    const before = options?.before ? SqliteRefinementCheckpointer.threadOf(options.before).checkpointId : undefined;
    /*
     * `checkpoint_id` is a UUIDv6 — monotonic by construction — so lexical
     * ordering is chronological and `before` is a plain string comparison. That
     * is a property of the id format rather than of this code, so
     * `checkpointer.test.ts` asserts it instead of this comment assuming it.
     */
    const rows = getDb()
      .prepare(
        `SELECT * FROM refinement_checkpoints
          WHERE thread_id = ? AND checkpoint_ns = ?${before ? ' AND checkpoint_id < ?' : ''}
          ORDER BY checkpoint_id DESC${options?.limit ? ' LIMIT ?' : ''}`,
      )
      .all(...[threadId, ns, ...(before ? [before] : []), ...(options?.limit ? [options.limit] : [])]) as CheckpointRow[];
    for (const row of rows) {
      const tuple = await this.tupleFromRow(row);
      /*
       * Metadata filtering is applied here rather than in SQL. The metadata is a
       * serde BLOB, not queryable JSON, and inventing a queryable column for it
       * would mean two representations of the same thing that can disagree.
       */
      if (options?.filter && !matchesFilter(tuple.metadata, options.filter)) continue;
      yield tuple;
    }
  }

  async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata): Promise<RunnableConfig> {
    const { threadId, ns, checkpointId: parentId } = SqliteRefinementCheckpointer.threadOf(config);
    if (!threadId) throw new Error('A refinement checkpoint needs a thread id.');
    const [type, serialisedCheckpoint] = await this.serde.dumpsTyped(checkpoint);
    const [metadataType, serialisedMetadata] = await this.serde.dumpsTyped(metadata);
    if (metadataType !== type) throw new Error(`The serde produced two types for one checkpoint (${type} and ${metadataType}).`);
    getDb()
      .prepare(
        `INSERT INTO refinement_checkpoints (trip_id, thread_id, checkpoint_ns, checkpoint_id, parent_id, type, checkpoint, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (thread_id, checkpoint_ns, checkpoint_id)
         DO UPDATE SET type = excluded.type, checkpoint = excluded.checkpoint, metadata = excluded.metadata`,
      )
      .run(this.tripId, threadId, ns, checkpoint.id, parentId ?? null, type, serialisedCheckpoint, serialisedMetadata, new Date().toISOString());
    return { configurable: { thread_id: threadId, checkpoint_ns: ns, checkpoint_id: checkpoint.id } };
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const { threadId, ns, checkpointId } = SqliteRefinementCheckpointer.threadOf(config);
    if (!threadId || !checkpointId) throw new Error('A refinement write needs a thread and a checkpoint.');
    const db = getDb();
    const statement = db.prepare(
      `INSERT INTO refinement_writes (trip_id, thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
       DO UPDATE SET channel = excluded.channel, type = excluded.type, value = excluded.value`,
    );
    const now = new Date().toISOString();
    /*
     * One transaction. A half-written set of pending writes is a checkpoint that
     * resumes into a state the graph never produced, which is worse than a
     * failure the caller can retry (§49).
     */
    /*
     * Serialised first, written second. The serde is async, and a transaction on
     * a synchronous driver cannot contain an await — a `db.transaction` callback
     * that returns a promise commits immediately and the writes land outside it,
     * which is exactly the half-written set this transaction exists to prevent.
     */
    const rows = await Promise.all(
      writes.map(async ([channel, value], index) => {
        const [type, serialised] = await this.serde.dumpsTyped(value);
        return { channel, index, type, serialised };
      }),
    );
    db.transaction(() => {
      for (const row of rows) statement.run(this.tripId, threadId, ns, checkpointId, taskId, row.index, row.channel, row.type, row.serialised, now);
    })();
  }

  async deleteThread(threadId: string): Promise<void> {
    const db = getDb();
    db.transaction(() => {
      db.prepare('DELETE FROM refinement_writes WHERE thread_id = ?').run(threadId);
      db.prepare('DELETE FROM refinement_checkpoints WHERE thread_id = ?').run(threadId);
    })();
  }
}

interface CheckpointRow {
  trip_id: string;
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_id: string | null;
  type: string;
  checkpoint: Buffer;
  metadata: Buffer;
  created_at: string;
}

interface WriteRow {
  task_id: string;
  channel: string;
  type: string;
  value: Buffer;
}

/** Shallow equality on the keys the caller named, which is what `list`'s filter contract asks for. */
function matchesFilter(metadata: CheckpointMetadata | undefined, filter: Record<string, unknown>): boolean {
  if (!metadata) return false;
  const record = metadata as unknown as Record<string, unknown>;
  return Object.entries(filter).every(([key, value]) => record[key] === value);
}
