import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBufferStore } from './buffer-store';
import type { Message } from './types';

function msg(id: string, text: string, chat = '777'): Message {
  return {
    tg_message_id: id,
    tg_chat_id: chat,
    message_type: 'text',
    text,
    sent_at: 1700000000,
  } as Message;
}

function setup(overrides: Partial<Parameters<typeof createBufferStore>[0]> = {}) {
  const post = vi.fn<Promise<boolean>, [Message[]]>();
  const deadLetter = vi.fn<Promise<boolean>, [Message[], string]>().mockResolvedValue(true);
  const onPersist = vi.fn();
  const store = createBufferStore({ post, deadLetter, onPersist, ...overrides });
  return { store, post, deadLetter, onPersist };
}

describe('createBufferStore — delivery basics', () => {
  it('delivers a batch and removes it only after confirmed delivery', async () => {
    const { store, post } = setup();
    post.mockResolvedValue(true);
    await store.enqueue(msg('1', 'a'), true);
    await store.enqueue(msg('2', 'b'), true);
    await store.flush();
    expect(post).toHaveBeenCalledTimes(1);
    expect(store.pending()).toBe(0);
  });

  it('keeps messages in the buffer when the worker rejects the batch', async () => {
    const { store, post } = setup();
    post.mockResolvedValue(false);
    await store.enqueue(msg('1', 'a'), true);
    await store.flush();
    expect(store.pending()).toBe(1);
  });

  it('drops messages shouldSync rejects', async () => {
    const { store } = setup();
    await store.enqueue(msg('1', 'a'), false);
    expect(store.pending()).toBe(0);
  });
});

describe('duplicate handling (#101)', () => {
  it('replaces a still-pending duplicate with the newer version', async () => {
    const { store, post } = setup();
    post.mockResolvedValue(true);
    await store.enqueue(msg('1', 'first'), true);
    await store.enqueue(msg('1', 'edited'), true);
    await store.flush();
    const batch = post.mock.calls[0]![0];
    expect(batch).toHaveLength(1);
    expect(batch[0]!.text).toBe('edited');
  });

  it('appends an edit whose original is inside the in-flight batch (edit-during-flush race)', async () => {
    const { store, post } = setup();
    let release!: () => void;
    post.mockImplementationOnce(
      () => new Promise<boolean>(resolve => { release = () => resolve(true); }),
    ).mockResolvedValue(true);
    await store.enqueue(msg('1', 'v1'), true);
    const flushPromise = store.flush(); // POST now in flight with v1
    await store.enqueue(msg('1', 'v2'), true); // edit arrives mid-flight
    expect(store.pending()).toBe(2); // appended, not replaced inside the window
    release();
    await flushPromise;
    // v1 delivered first, then the drain delivers v2 — the edit is never lost.
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0]![0][0]!.text).toBe('v1');
    expect(post.mock.calls[1]![0][0]!.text).toBe('v2');
    expect(store.pending()).toBe(0);
  });
});

describe('draining (re-review: stalled bursts and restored backlogs)', () => {
  it('one flush call drains a backlog larger than a batch', async () => {
    const { store, post } = setup({ batchSize: 100 });
    post.mockResolvedValue(true);
    store.restore(Array.from({ length: 250 }, (_, i) => msg(`r-${i}`, `t${i}`)));
    await store.flush(); // the single boot-restore flush
    expect(post).toHaveBeenCalledTimes(3); // 100 + 100 + 50
    expect(store.pending()).toBe(0);
  });

  it('stops draining at a batch that fails and stays queued', async () => {
    const { store, post } = setup({ batchSize: 10 });
    post.mockResolvedValueOnce(true).mockResolvedValue(false);
    store.restore(Array.from({ length: 25 }, (_, i) => msg(`r-${i}`, `t${i}`)));
    await store.flush();
    expect(post).toHaveBeenCalledTimes(2); // first delivered, second rejected -> stop
    expect(store.pending()).toBe(15);
  });
});

describe('poison batches and the cap (#104)', () => {
  it('dead-letters a batch after maxFlushFailures rejections and continues', async () => {
    const { store, post, deadLetter } = setup();
    post.mockResolvedValue(false);
    await store.enqueue(msg('1', 'poison'), true);
    for (let i = 0; i < 5; i++) await store.flush();
    expect(deadLetter).toHaveBeenCalledTimes(1);
    expect(store.pending()).toBe(0); // removed after the dead-letter write
  });

  it('resets the failure counter after a success', async () => {
    const { store, post, deadLetter } = setup();
    post.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);
    await store.enqueue(msg('1', 'a'), true);
    await store.flush(); // failure 1
    await store.flush(); // delivered
    await store.enqueue(msg('2', 'b'), true);
    await store.flush(); // failure counting starts again
    expect(deadLetter).not.toHaveBeenCalled();
  });

  it('the cap dead-letters the oldest PENDING batch, never the in-flight window (wave-2 review regression)', async () => {
    const { store, post, deadLetter } = setup({ maxBuffer: 120, batchSize: 10 });
    let release!: () => void;
    post.mockImplementationOnce(
      () => new Promise<boolean>(resolve => { release = () => resolve(true); }),
    ).mockResolvedValue(true);

    // Nine queued, the tenth triggers the (hanging) flush: ids inflight-0..9 are now in flight.
    for (let i = 0; i < 9; i++) await store.enqueue(msg(`inflight-${i}`, `m${i}`), true);
    const tenth = store.enqueue(msg('inflight-9', 'm9'), true);

    // The buffer grows past the cap while the POST hangs.
    for (let i = 0; i < 115; i++) await store.enqueue(msg(`pending-${i}`, `p${i}`), true);

    expect(deadLetter).toHaveBeenCalledTimes(1);
    const deadLettered = deadLetter.mock.calls[0]![0].map(m => m.tg_message_id);
    expect(deadLettered).toHaveLength(10);
    expect(deadLettered[0]).toBe('pending-0'); // the oldest PENDING entry…
    expect(deadLettered.some(id => id.startsWith('inflight-'))).toBe(false); // …never the in-flight window

    release();
    await tenth;

    // In-flight batch delivered exactly once; the drain then delivers every
    // surviving pending entry — nothing lost, nothing duplicated.
    expect(post.mock.calls[0]![0].map(m => m.tg_message_id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `inflight-${i}`),
    );
    const delivered = post.mock.calls.flatMap(call => call[0].map(m => m.tg_message_id));
    expect(delivered.filter(id => id === 'inflight-0')).toHaveLength(1);
    expect(delivered).not.toContain('pending-0'); // dead-lettered, not delivered
    expect(delivered).toContain('pending-10');
    expect(delivered).toContain('pending-114');
    expect(new Set(delivered).size).toBe(delivered.length); // no duplicates
    expect(delivered).toHaveLength(10 + 105);
    expect(store.pending()).toBe(0);
  });
});

describe('restore (#103)', () => {
  it('replaces the contents with a persisted backlog', async () => {
    const { store } = setup();
    await store.enqueue(msg('1', 'a'), true);
    store.restore([msg('9', 'from-disk'), msg('10', 'from-disk')]);
    expect(store.pending()).toBe(2);
    expect(store.snapshot()[0]!.text).toBe('from-disk');
  });
});
