import * as defaultFs from 'fs';
import { randomBytes } from 'crypto';

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
    } catch (err) {
      // Only a genuinely absent file is a first boot. Anything else (EACCES,
      // EISDIR, a wedged mount) means the baseline EXISTS but cannot be read —
      // classifying that as 'missing' would silently reset the gap baseline,
      // the exact failure #105 refuses to allow.
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT') return { kind: 'missing' };
      return { kind: 'corrupt' };
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
    // Unique tmp name per call: concurrent saves sharing one `.tmp` raced each
    // other's rename and all but one failed with ENOENT (re-review probe).
    const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    await fsModule.promises.writeFile(tmp, JSON.stringify(state), 'utf-8');
    await fsModule.promises.rename(tmp, path);
  }

  return { load, save };
}
