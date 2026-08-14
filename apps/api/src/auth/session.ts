/**
 * Session tokens.
 *
 * An HMAC-signed, non-encrypted payload: `base64url(json).base64url(signature)`.
 * The contents are readable by the holder, which is fine — the point is that
 * they cannot be *changed*. The single most valuable property here is that
 * editing `orgId` inside the token invalidates the signature, so a tenant
 * cannot promote themselves into another tenant's data.
 *
 * Deliberately not an auth framework. Phase 1 has no self-serve signup, only
 * seeded staff; adopting one before the requirements exist would be guessing.
 * Revisit at Phase 9, when onboarding strangers defines what is actually needed.
 */

export interface SessionPayload {
  userId: string;
  orgId: string;
  role: "owner" | "manager" | "cashier";
  /** Unix seconds. */
  exp: number;
}

const DEFAULT_TTL_SECONDS = 60 * 60 * 12; // one shift

function base64urlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64urlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function createSession(
  payload: Omit<SessionPayload, "exp">,
  secret: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<string> {
  const full: SessionPayload = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const body = base64urlEncode(
    new TextEncoder().encode(JSON.stringify(full)),
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    new TextEncoder().encode(body),
  );
  return `${body}.${base64urlEncode(new Uint8Array(signature))}`;
}

/**
 * Verify and decode. Returns null for anything untrustworthy — bad signature,
 * tampered payload, expired, or malformed — without distinguishing between
 * them to the caller.
 */
export async function verifySession(
  token: string,
  secret: string,
): Promise<SessionPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts as [string, string];

  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      base64urlDecode(signature) as BufferSource,
      new TextEncoder().encode(body),
    );
    if (!valid) return null;

    const payload = JSON.parse(
      new TextDecoder().decode(base64urlDecode(body)),
    ) as SessionPayload;

    if (typeof payload.exp !== "number") return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (!payload.userId || !payload.orgId) return null;

    return payload;
  } catch {
    return null;
  }
}

export const SESSION_COOKIE = "suriani_session";

export function readSessionCookie(request: Request): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return rest.join("=");
  }
  return null;
}

export function sessionCookieHeader(token: string, ttlSeconds = DEFAULT_TTL_SECONDS): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${ttlSeconds}`;
}
