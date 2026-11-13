import { beforeEach, describe, expect, it } from 'vitest';
import { createPtsStateIo, type FsLike } from './state-io';
import type * as Fs from 'fs';

// In-memory fs double: only the surface state-io uses.
function fakeFs(initial: Record<string, string> = {}): FsLike & { files: Map<string, string> } {
  const files = new Map<string, string>(Object.entries(initial));
  const fsLike = {
    promises: {
      async readFile(path: string): Promise<string> {
        if (!files.has(path)) {
          const e = new Error('ENOENT: no such file') as NodeJS.ErrnoException;
          e.code = 'ENOENT';
          throw e;
        }
        return files.get(path)!;
      },
      async writeFile(path: string, data: string): Promise<void> {
        files.set(path, data);
      },
      async rename(from: string, to: string): Promise<void> {
        if (!files.has(from)) {
          const e = new Error('ENOENT: no such file') as NodeJS.ErrnoException;
          e.code = 'ENOENT';
          throw e;
        }
        files.set(to, files.get(from)!);
        files.delete(from);
      },
    },
  } as unknown as FsLike;
  return Object.assign(fsLike, { files });
}

function fsWithReadError(code: string): FsLike {
  const fsLike = {
    promises: {
      async readFile(): Promise<string> {
        const e = new Error(code) as NodeJS.ErrnoException;
        e.code = code;
        throw e;
      },
      async writeFile(): Promise<void> { /* unused in this test */ },
      async rename(): Promise<void> { /* unused in this test */ },
    },
  } as unknown as FsLike;
  return fsLike;
}

describe('createPtsStateIo', () => {
  let fs: ReturnType<typeof fakeFs>;
  beforeEach(() => {
    fs = fakeFs();
  });

  it('reports missing for a first boot', async () => {
    const io = createPtsStateIo('/data/state.json', fs);
    expect(await io.load()).toEqual({ kind: 'missing' });
  });

  it('round-trips a saved state and defaults qts to 0 for old files', async () => {
    const io = createPtsStateIo('/data/state.json', fs);
    await io.save({ pts: 100, qts: 7 });
    expect(await io.load()).toEqual({ kind: 'ok', state: { pts: 100, qts: 7 } });

    fs.files.set('/data/state.json', JSON.stringify({ pts: 200 }));
    expect(await io.load()).toEqual({ kind: 'ok', state: { pts: 200, qts: 0 } });
  });

  it('writes atomically — no .tmp left behind and the target is never partial', async () => {
    const io = createPtsStateIo('/data/state.json', fs);
    await io.save({ pts: 5, qts: 1 });
    expect(fs.files.has('/data/state.json.tmp')).toBe(false);
    expect(fs.files.get('/data/state.json')).toBe(JSON.stringify({ pts: 5, qts: 1 }));
  });

  it('reports corrupt for truncated JSON', async () => {
    const fs2 = fakeFs({ '/data/state.json': '{"pts": 12' });
    const io = createPtsStateIo('/data/state.json', fs2);
    expect(await io.load()).toEqual({ kind: 'corrupt' });
  });

  it('reports corrupt for structurally invalid payloads', async () => {
    for (const bad of ['{}', '{"pts": "123"}', '{"pts": 0}', '["pts"]', 'null']) {
      const fs2 = fakeFs({ '/data/state.json': bad });
      const io = createPtsStateIo('/data/state.json', fs2);
      expect(await io.load()).toEqual({ kind: 'corrupt' });
    }
  });

  it('only ENOENT is a first boot — EACCES/EISDIR are corrupt, not missing (wave-2 audit)', async () => {
    for (const code of ['EACCES', 'EISDIR', 'EROFS']) {
      const io = createPtsStateIo('/data/state.json', fsWithReadError(code));
      expect(await io.load()).toEqual({ kind: 'corrupt' });
    }
  });
});
