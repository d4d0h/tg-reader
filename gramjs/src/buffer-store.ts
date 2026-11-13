import type { Message } from './types';

// ---------------------------------------------------------------------------
// Ingest buffer store (H2/H4/H5, #101 #103 #104)
//
// The listener's buffering policy, extracted so it is unit-testable — the
// two high-severity bugs in the first Wave 2 cut (cap dead-lettering the
// in-flight batch; the edit-during-flush window) both lived exactly here.
//
// Invariants this module enforces:
//  1. Entries inside the in-flight window (indices < flushingBatchLen) are
//     being delivered as their snapshot version: they are never replaced,
//     never dead-lettered, never spliced by anything but the post-delivery
//     removal. An edit to one is APPENDED so it survives that removal.
//  2. A duplicate (chat, message) key still pending is replaced by the newer
//     version (same-batch duplicates would abort the worker's upsert).
//  3. A batch the worker keeps rejecting is dead-lettered after
//     maxFlushFailures attempts; the buffer is capped at maxBuffer entries
//     with oldest-PENDING-first dead-lettering (never the in-flight window).
// ---------------------------------------------------------------------------

export interface BufferStoreDeps {
  /** Deliver a batch. Resolves true when the worker accepted it (2xx). */
  post: (batch: Message[]) => Promise<boolean>;
  /** Persist a batch to dead-letter storage. Resolves true when written. */
  deadLetter: (batch: Message[], reason: string) => Promise<boolean>;
  /** Called after every buffer mutation worth surviving a crash. */
  onPersist?: () => void | Promise<void>;
  maxBuffer?: number;
  maxFlushFailures?: number;
  batchSize?: number;
}

export function createBufferStore(deps: BufferStoreDeps) {
  const maxBuffer = deps.maxBuffer ?? 5000;
  const maxFlushFailures = deps.maxFlushFailures ?? 5;
  const batchSize = deps.batchSize ?? 100;

  let buffer: Message[] = [];
  let flushing = false; // re-entrancy guard: one POST in flight at a time
  let flushingBatchLen = 0; // leading entries currently inside the in-flight POST
  let consecutiveFailures = 0;

  /** Deliver the leading pending batch, if any. */
  async function flush(): Promise<void> {
    if (flushing || buffer.length === 0) return;
    flushing = true;
    // Entries stay in the buffer until delivery is confirmed. The snapshot is
    // by count — which is only safe because nothing else may remove or replace
    // entries inside the in-flight window while the POST is in flight.
    const batch = buffer.slice(0, batchSize);
    flushingBatchLen = batch.length;
    try {
      const ok = await deps.post(batch);
      if (ok) {
        buffer.splice(0, batch.length);
        consecutiveFailures = 0;
      } else {
        await handleFailure(batch, 'worker rejected batch');
      }
    } catch (err) {
      await handleFailure(batch, `fetch error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      flushing = false;
      flushingBatchLen = 0;
      await deps.onPersist?.();
    }
  }

  async function handleFailure(batch: Message[], reason: string): Promise<void> {
    consecutiveFailures++;
    if (consecutiveFailures >= maxFlushFailures) {
      const persisted = await deps.deadLetter(
        batch,
        `${reason} — giving up after ${consecutiveFailures} attempts`,
      );
      if (persisted) {
        buffer.splice(0, batch.length);
        consecutiveFailures = 0;
      }
    }
    // Retries (and the no-op case) log at the caller's level via the reason.
    else {
      console.error(`[ingest] ${reason} — will retry on next flush (${consecutiveFailures}/${maxFlushFailures})`);
    }
  }

  /**
   * Add a message (or a newer version of one already pending), honoring the
   * invariants above. `shouldSync` false drops the message entirely.
   */
  async function enqueue(msg: Message, shouldSync: boolean): Promise<void> {
    if (!shouldSync) return;
    const idx = buffer.findIndex(
      m => m.tg_chat_id === msg.tg_chat_id && m.tg_message_id === msg.tg_message_id,
    );
    if (idx !== -1 && idx >= flushingBatchLen) {
      buffer[idx] = msg; // newer version replaces a still-pending entry
    } else {
      buffer.push(msg); // new message, or an edit of an in-flight entry
    }
    // Cap: dead-letter the OLDEST PENDING batch — never the in-flight window,
    // whose entries the post-delivery splice still owns.
    if (buffer.length > maxBuffer) {
      const overflow = buffer.slice(flushingBatchLen, flushingBatchLen + batchSize);
      const persisted = await deps.deadLetter(
        overflow,
        `buffer cap ${maxBuffer} exceeded — worker unreachable`,
      );
      if (persisted) buffer.splice(flushingBatchLen, overflow.length);
    }
    // Fire-and-forget here: the listener's onPersist serializes writes, and
    // ingest latency must not wait on disk. flush() awaits it in its finally.
    void deps.onPersist?.();
    if (buffer.length >= batchSize) {
      await flush();
    }
  }

  return {
    enqueue,
    flush,
    /** Entries not yet delivered (including the in-flight window). */
    pending: () => buffer.length,
    /** Snapshot for persistence; identity-stable until the next mutation. */
    snapshot: (): readonly Message[] => buffer,
    /** Replace the contents (boot-time restore of a persisted backlog). */
    restore: (messages: Message[]) => {
      buffer = [...messages];
    },
    isFlushing: () => flushing,
  };
}
