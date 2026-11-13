import { afterEach, describe, expect, it } from 'vitest';
import { Api } from 'telegram';
import bigInt from 'big-integer';
import { requireEnv, resolveMediaType, resolveSenderId, sleep } from './utils';

describe('requireEnv()', () => {
  const NAME = 'TG_READER_TEST_VAR';

  afterEach(() => {
    delete process.env[NAME];
  });

  it('returns a set value', () => {
    process.env[NAME] = 'value';
    expect(requireEnv(NAME)).toBe('value');
  });

  it('throws naming the missing variable', () => {
    expect(() => requireEnv(NAME)).toThrow(NAME);
  });
});

describe('sleep()', () => {
  it('resolves after the given milliseconds', async () => {
    const before = Date.now();
    await sleep(25);
    expect(Date.now() - before).toBeGreaterThanOrEqual(20);
  });
});

describe('resolveSenderId()', () => {
  it('returns undefined for null/undefined peers', () => {
    expect(resolveSenderId(undefined)).toBeUndefined();
    expect(resolveSenderId(null)).toBeUndefined();
  });

  it('stringifies user, chat and channel peer ids', () => {
    expect(resolveSenderId(new Api.PeerUser({ userId: bigInt(123) }))).toBe('123');
    expect(resolveSenderId(new Api.PeerChat({ chatId: bigInt(456) }))).toBe('456');
    expect(resolveSenderId(new Api.PeerChannel({ channelId: bigInt(789) }))).toBe('789');
  });
});

describe('resolveMediaType()', () => {
  it('returns undefined for no media', () => {
    expect(resolveMediaType(undefined)).toBeUndefined();
    expect(resolveMediaType(null)).toBeUndefined();
  });

  it('maps photo and geo media', () => {
    expect(resolveMediaType(new Api.MessageMediaPhoto({}))).toBe('photo');
    expect(resolveMediaType(new Api.MessageMediaGeo({ geo: new Api.GeoPoint({ long: 0, lat: 0, accessHash: bigInt(1) }) }))).toBe('location');
  });

  it('maps a document with no recognised attributes to document', () => {
    const doc = new Api.Document({
      id: bigInt(1),
      accessHash: bigInt(1),
      fileReference: Buffer.alloc(0),
      date: 0,
      mimeType: 'application/octet-stream',
      size: bigInt(1),
      dcId: 1,
      attributes: [],
    });
    expect(resolveMediaType(new Api.MessageMediaDocument({ document: doc }))).toBe('document');
  });

  it('treats a link preview as no media', () => {
    expect(resolveMediaType(new Api.MessageMediaWebPage({ webpage: new Api.WebPageEmpty({ id: bigInt(1) }) }))).toBeUndefined();
  });
});
