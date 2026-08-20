/*
 * The founders gate has to remember that a password was entered correctly,
 * across requests, without a server to remember it in. So the proof travels in
 * a cookie the holder can read and edit at will.
 *
 * The cookie therefore carries its own expiry plus an HMAC over that expiry,
 * keyed by the password itself. Editing the expiry invalidates the signature,
 * and rotating the password logs everyone out for free — no session store, no
 * revocation list.
 */

const encoder = new TextEncoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A hex-encoded HMAC-SHA256 of `value` under `secret`. */
export async function mac(secret: string, value: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(value));
  return hex(sig);
}

/** Mints a cookie value good until `expiresAt`, in epoch milliseconds. */
export async function sign(secret: string, expiresAt: number): Promise<string> {
  return `${expiresAt}.${await mac(secret, String(expiresAt))}`;
}

/** True when `token` was minted by {@link sign} under `secret` and still has time left. */
export async function verify(
  secret: string,
  token: string | undefined,
  now: number,
): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot < 1) return false;
  const stamp = token.slice(0, dot);
  const expiresAt = Number(stamp);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;
  return equal(token.slice(dot + 1), await mac(secret, stamp));
}

/**
 * Whether a submitted password is the right one.
 *
 * The comparison runs over digests rather than the passwords themselves, so a
 * guess reveals neither how long the real password is nor how many characters
 * of it were right.
 */
export async function passwordMatches(expected: string, submitted: string): Promise<boolean> {
  // An empty guess is wrong by definition, and it is worth answering here: an
  // empty string is not a usable HMAC key, so hashing it would throw instead.
  if (submitted === '') return false;
  const [a, b] = await Promise.all([mac(expected, 'gate'), mac(submitted, 'gate')]);
  return equal(a, b);
}

/** Compares two strings without leaking, in timing, how far they agreed. */
export function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
