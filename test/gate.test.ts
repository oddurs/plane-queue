import { describe, expect, it } from 'vitest';
import { equal, mac, passwordMatches, sign, verify } from '../src/gate/token.ts';

/**
 * The gate cookie is held by the person it is keeping out, so the properties
 * worth testing are the adversarial ones: a forged cookie must not open it, an
 * expired one must not open it, and rotating the password must close it again.
 */

const SECRET = 'correct horse battery staple';
const NOW = 1_700_000_000_000;
const LATER = NOW + 60_000;

describe('gate token', () => {
  it('accepts a token it just minted', async () => {
    expect(await verify(SECRET, await sign(SECRET, LATER), NOW)).toBe(true);
  });

  it('rejects a token past its expiry', async () => {
    const token = await sign(SECRET, LATER);
    expect(await verify(SECRET, token, LATER + 1)).toBe(false);
    // And exactly at the boundary, which is the off-by-one that matters.
    expect(await verify(SECRET, token, LATER)).toBe(false);
  });

  it('rejects a token whose expiry was edited', async () => {
    const token = await sign(SECRET, NOW - 1);
    const [, signature] = token.split('.');
    expect(await verify(SECRET, `${LATER}.${signature}`, NOW)).toBe(false);
  });

  it('rejects a token signed with a different password', async () => {
    const token = await sign('the old password', LATER);
    expect(await verify(SECRET, token, NOW)).toBe(false);
  });

  it('rejects tokens that are not tokens', async () => {
    for (const junk of [undefined, '', '.', 'nonsense', `${LATER}`, `.${await mac(SECRET, String(LATER))}`]) {
      expect(await verify(SECRET, junk, NOW), String(junk)).toBe(false);
    }
  });
});

describe('password check', () => {
  it('accepts the password and nothing else', async () => {
    expect(await passwordMatches(SECRET, SECRET)).toBe(true);
    for (const wrong of ['', SECRET.slice(0, -1), `${SECRET} `, SECRET.toUpperCase()]) {
      expect(await passwordMatches(SECRET, wrong), wrong).toBe(false);
    }
  });
});

describe('constant-time compare', () => {
  it('agrees with ordinary equality', () => {
    expect(equal('abc', 'abc')).toBe(true);
    expect(equal('abc', 'abd')).toBe(false);
    expect(equal('abc', 'ab')).toBe(false);
    expect(equal('', '')).toBe(true);
  });
});
