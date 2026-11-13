import { describe, expect, it } from 'vitest';
import { flag, flagInt, parseArgs } from './tg';

describe('parseArgs()', () => {
  it('extracts the command and positional arguments', () => {
    const parsed = parseArgs(['node', 'tg', 'search', 'payment', 'invoice']);
    expect(parsed.command).toBe('search');
    expect(parsed.positional).toEqual(['payment', 'invoice']);
  });

  it('captures flag values and boolean flags', () => {
    const parsed = parseArgs(['node', 'tg', 'search', '--limit', '20', '--json']);
    expect(parsed.flags).toEqual({ limit: '20', json: true });
    expect(parsed.positional).toEqual([]);
  });

  // Documents current behaviour: a valueless flag consumes the next non-flag
  // token as its value, so the query disappears. The wave 5 CLI fixes
  // (M19/#119) revisit positional handling.
  it('a valueless flag swallows the following positional as its value', () => {
    const parsed = parseArgs(['node', 'tg', 'search', '--json', 'query']);
    expect(parsed.flags).toEqual({ json: 'query' });
    expect(parsed.positional).toEqual([]);
  });

  it('does not consume a following --flag as a value', () => {
    const parsed = parseArgs(['node', 'tg', 'chats', '--limit', '--json']);
    expect(parsed.flags).toEqual({ limit: true, json: true });
  });

  it('returns an empty command for bare invocation', () => {
    const parsed = parseArgs(['node', 'tg']);
    expect(parsed.command).toBe('');
    expect(parsed.positional).toEqual([]);
  });
});

describe('flag()/flagInt()', () => {
  it('flag returns string values and undefined otherwise', () => {
    expect(flag({ limit: '20' }, 'limit')).toBe('20');
    expect(flag({ json: true }, 'json')).toBeUndefined();
    expect(flag({}, 'missing')).toBeUndefined();
  });

  it('flagInt parses numbers and falls back on garbage', () => {
    expect(flagInt({ limit: '20' }, 'limit', 50)).toBe(20);
    expect(flagInt({ limit: true }, 'limit', 50)).toBe(50);
    expect(flagInt({ limit: 'abc' }, 'limit', 50)).toBe(50);
    expect(flagInt({}, 'limit', 50)).toBe(50);
  });
});
