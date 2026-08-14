/**
 * Identifiers.
 *
 * Three different kinds, deliberately not interchangeable:
 *
 *  - ULID       — sortable, client-generatable. Used for orders so a tablet can
 *                 mint an id while offline and the server can replay it safely.
 *  - qrToken    — an unguessable table secret. Never the table number.
 *  - doId       — an unguessable Durable Object name. Never derived from the
 *                 outlet id, so guessing outlet ids leads nowhere.
 */

/** Crockford base32, excluding I, L, O and U to avoid transcription errors. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTime(now: number, length: number): string {
  let out = "";
  for (let i = length - 1; i >= 0; i--) {
    out = CROCKFORD[now % 32]! + out;
    now = Math.floor(now / 32);
  }
  return out;
}

function encodeRandom(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i++) out += CROCKFORD[bytes[i]! % 32]!;
  return out;
}

/**
 * A ULID: 48-bit timestamp then 80 bits of randomness, 26 chars total.
 *
 * Lexicographically sortable by creation time, which means an op log replayed
 * after an outage naturally lands in the order it happened.
 */
export function ulid(now: number = Date.now()): string {
  return encodeTime(now, 10) + encodeRandom(16);
}

/**
 * A table's QR secret.
 *
 * 160 bits. This is the value that stops someone editing a URL and sending
 * twenty plates of chicken to another table.
 */
export function qrToken(): string {
  return encodeRandom(32);
}

/** The random Durable Object name for an outlet. */
export function doId(): string {
  return "outlet_" + encodeRandom(26);
}

/** A short prefixed id for control-plane rows. */
export function id(prefix: string): string {
  return `${prefix}_${ulid()}`;
}
