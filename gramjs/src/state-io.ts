import * as defaultFs from 'fs';

// ---------------------------------------------------------------------------
// pts state persistence (H6 / #105)
//
// Extracted from listener.ts so it is unit-testable with an injected fs.
// Writes are atomic (tmp + rename): a crash or OOM mid-write can never leave
// a truncated state.json behind, which would silently disable gap recovery.
// ---------------------------------------------------------------------------

export interface PtsState {
  pts: number;
  qts: number; // tracked alongside pts for GetDifference
}

export type LoadResult =
  | { kind: 'ok'; state: PtsState }
  | { kind: 'missing' } // first boot — no baseline yet
  | { kind: 'corrupt' }; // exists but unreadable — caller must NOT overwrite

export type FsLike = typeof defaultFs;

export function createPtsStateIo(path: string, fsModule: FsLike = defaultFs) {
  async function load(): Promise<LoadResult> {
    let raw: string;
    try {
      raw = await fsModule.promises.readFile(path, 'utf-8');
    } catch {
      return { kind: 'missing' };
    }
    try {
      const data = JSON.parse(raw) as Partial<PtsState>;
      if (typeof data.pts !== 'number' || !Number.isFinite(data.pts) || data.pts <= 0) {
        return { kind: 'corrupt' };
      }
      return {
        kind: 'ok',
        state: { pts: data.pts, qts: typeof data.qts === 'number' ? data.qts : 0 },
      };
    } catch {
      return { kind: 'corrupt' };
    }
  }

  async function save(state: PtsState): Promise<void> {
    const tmp = `${path}.tmp`;
    await fsModule.promises.writeFile(tmp, JSON.stringify(state), 'utf-8');
    await fsModule.promises.rename(tmp, path);
  }

  return { load, save };
}
