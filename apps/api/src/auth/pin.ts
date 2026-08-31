/**
 * Staff PIN hashing.
 *
 * A PIN is a low-entropy secret — four to six digits, so at most a million
 * candidates. That makes the *work factor* the only thing standing between a
 * leaked database and every staff account, which is why this uses PBKDF2 with
 * a high iteration count and a per-user salt rather than a plain digest.
 *
 * PBKDF2 rather than bcrypt/argon2 because Workers has no native bindings;
 * WebCrypto is what the runtime actually provides.
 */

const ITERATIONS = 210_000;
const KEY_BITS = 256;
const PIN_PATTERN = /^\d{4,8}$/;

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function isValidPinFormat(pin: string): boolean {
  return PIN_PATTERN.test(pin);
}

async function derive(pin: string, salt: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: ITERATIONS, hash: "SHA-256" },
    key,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

/**
 * Hash any secret — a staff PIN, a device token.
 *
 * One PBKDF2 implementation for both, so there is a single work factor and a
 * single constant-time comparison to audit. The PIN wrappers below add only
 * the format check.
 */
export async function hashSecret(
  secret: string,
): Promise<{ hash: string; salt: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(secret, salt);
  return { hash: toBase64(hash), salt: toBase64(salt) };
}

export async function verifySecret(
  secret: string,
  storedHash: string,
  storedSalt: string,
): Promise<boolean> {
  try {
    const candidate = await derive(secret, fromBase64(storedSalt));
    return timingSafeEqual(candidate, fromBase64(storedHash));
  } catch {
    return false;
  }
}

export async function hashPin(
  pin: string,
): Promise<{ hash: string; salt: string }> {
  if (!isValidPinFormat(pin)) {
    throw new Error("PIN must be 4–8 digits");
  }
  return hashSecret(pin);
}

/** Constant-time comparison. A length-varying early return leaks the hash. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export async function verifyPin(
  pin: string,
  storedHash: string,
  storedSalt: string,
): Promise<boolean> {
  if (!isValidPinFormat(pin)) return false;
  return verifySecret(pin, storedHash, storedSalt);
}
