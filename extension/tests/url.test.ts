import { describe, it, expect } from 'vitest';
import { parseVnshUrl, buildVnshUrl, isVnshUrl } from '../src/lib/url';
import {
  hexToBytes,
  bytesToHex,
  bytesToBase64url,
  base64urlToBytes,
} from '../src/lib/crypto';

describe('URL parsing', () => {
  it('parses v2 URL format', () => {
    const key = new Uint8Array(32);
    const iv = new Uint8Array(16);
    crypto.getRandomValues(key);
    crypto.getRandomValues(iv);
    const secret = new Uint8Array([...key, ...iv]);
    const fragment = bytesToBase64url(secret);

    const url = `https://vnsh.dev/v/aBcDeFgHiJkL#${fragment}`;
    const parsed = parseVnshUrl(url);

    expect(parsed.host).toBe('https://vnsh.dev');
    expect(parsed.id).toBe('aBcDeFgHiJkL');
    expect(Array.from(parsed.key)).toEqual(Array.from(key));
    expect(Array.from(parsed.iv)).toEqual(Array.from(iv));
  });

  it('parses v1 URL format', () => {
    const keyHex =
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const ivHex = 'fedcba9876543210fedcba9876543210';
    const url = `https://vnsh.dev/v/abc-def-123#k=${keyHex}&iv=${ivHex}`;
    const parsed = parseVnshUrl(url);

    expect(parsed.host).toBe('https://vnsh.dev');
    expect(parsed.id).toBe('abc-def-123');
    expect(bytesToHex(parsed.key)).toBe(keyHex);
    expect(bytesToHex(parsed.iv)).toBe(ivHex);
  });

  it('throws on missing fragment', () => {
    expect(() => parseVnshUrl('https://vnsh.dev/v/abc')).toThrow(
      'missing fragment',
    );
  });

  it('throws on invalid path', () => {
    expect(() => parseVnshUrl('https://vnsh.dev/x/abc#frag')).toThrow(
      'cannot extract blob ID',
    );
  });

  it('throws on invalid v1 key length', () => {
    expect(() =>
      parseVnshUrl('https://vnsh.dev/v/abc#k=short&iv=fedcba9876543210fedcba9876543210'),
    ).toThrow('key must be 64 hex chars');
  });
});

describe('URL building', () => {
  it('builds v2 URL', () => {
    const key = new Uint8Array(32).fill(0xaa);
    const iv = new Uint8Array(16).fill(0xbb);
    const url = buildVnshUrl('https://vnsh.dev', 'testId123456', key, iv);

    expect(url).toMatch(/^https:\/\/vnsh\.dev\/v\/testId123456#/);
    // Fragment should be 64 chars base64url
    const fragment = url.split('#')[1];
    expect(fragment.length).toBe(64);
  });

  it('roundtrips: build → parse', () => {
    const key = new Uint8Array(32);
    const iv = new Uint8Array(16);
    crypto.getRandomValues(key);
    crypto.getRandomValues(iv);

    const url = buildVnshUrl('https://vnsh.dev', 'roundTrip123', key, iv);
    const parsed = parseVnshUrl(url);

    expect(parsed.host).toBe('https://vnsh.dev');
    expect(parsed.id).toBe('roundTrip123');
    expect(Array.from(parsed.key)).toEqual(Array.from(key));
    expect(Array.from(parsed.iv)).toEqual(Array.from(iv));
  });
});

describe('isVnshUrl', () => {
  it('matches valid vnsh URLs', () => {
    expect(isVnshUrl('https://vnsh.dev/v/abc123#secret')).toBe(true);
    expect(
      isVnshUrl(
        'https://vnsh.dev/v/abc-def-123#k=aa&iv=bb',
      ),
    ).toBe(true);
  });

  it('rejects non-vnsh URLs', () => {
    expect(isVnshUrl('https://google.com')).toBe(false);
    expect(isVnshUrl('https://vnsh.dev/')).toBe(false);
    expect(isVnshUrl('https://vnsh.dev/v/abc')).toBe(false); // no fragment
  });
});
