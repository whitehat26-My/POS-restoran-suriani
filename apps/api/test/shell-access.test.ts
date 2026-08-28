/**
 * What the Android shell needs from the API, and what it must not be given.
 *
 * The tablet serves the till from inside the APK, so its origin is the device
 * and every call is cross-origin. That means CORS — and CORS on an API that
 * holds a restaurant's takings is worth being careful about, so the tests here
 * are as much about what is refused as what is allowed.
 */
import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";

import { createTenant, auth } from "./helpers";

const SHELL = "https://localhost";

describe("cross-origin access for the shell", () => {
  it("answers a preflight without demanding the token it cannot send", async () => {
    // A preflight carries no Authorization header. Answering it 401 tells the
    // browser the API refuses this origin, and the real request never happens.
    const res = await SELF.fetch("https://api.test/api/outlets", {
      method: "OPTIONS",
      headers: {
        Origin: SHELL,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(SHELL);
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
  });

  it("gives /health the headers too — it is the first call a tablet makes", async () => {
    // The setup screen proves the address by fetching /health before storing
    // it. Hono runs middleware in registration order, so a route declared
    // above the CORS middleware silently never gets it — and the shell would
    // be stuck on its own first screen at an address that works fine in a
    // browser.
    const res = await SELF.fetch("https://api.test/health", {
      headers: { Origin: SHELL },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(SHELL);
  });

  it("lets the shell read a real response", async () => {
    const t = await createTenant("Suriani Shell");
    const res = await SELF.fetch("https://api.test/api/outlets", {
      headers: { Origin: SHELL, ...auth(t) },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(SHELL);
    expect(res.headers.get("Vary")).toContain("Origin");
  });

  it("never turns on credentials", async () => {
    // With credentials on, a browser would attach the session cookie to
    // cross-origin requests and this API would grow a CSRF surface. The
    // tablet carries a bearer token instead, precisely so it does not.
    const t = await createTenant("Suriani NoCreds");
    const res = await SELF.fetch("https://api.test/api/outlets", {
      headers: { Origin: SHELL, ...auth(t) },
    });
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  it("refuses an origin that is not a shell", async () => {
    const res = await SELF.fetch("https://api.test/api/outlets", {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example",
        "Access-Control-Request-Method": "GET",
      },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("gives a stranger's page no header to read, even with a stolen token", async () => {
    const t = await createTenant("Suriani Leak");
    const res = await SELF.fetch("https://api.test/api/outlets", {
      headers: { Origin: "https://evil.example", ...auth(t) },
    });
    // The request itself is answered — this is not authentication — but with
    // no Allow-Origin header the browser refuses to hand the body to the page
    // that asked for it.
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("leaves same-origin responses alone", async () => {
    const t = await createTenant("Suriani Same");
    const res = await SELF.fetch("https://api.test/api/outlets", {
      headers: auth(t),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("the live socket from the tablet", () => {
  const wsUrl = (outletId: string, query = "") =>
    `https://api.test/api/outlets/${outletId}/ws${query}`;

  it("accepts the token in the query string, because a socket cannot send a header", async () => {
    const t = await createTenant("Suriani WS");
    const res = await SELF.fetch(
      wsUrl(t.outletId, `?access_token=${t.token}`),
      { headers: { Upgrade: "websocket" } },
    );
    expect(res.status).toBe(101);
    res.webSocket?.accept();
    res.webSocket?.close();
  });

  it("refuses a bad token in the query string", async () => {
    const t = await createTenant("Suriani WS Bad");
    const res = await SELF.fetch(wsUrl(t.outletId, "?access_token=not-a-token"), {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(401);
  });

  it("ignores access_token on anything that is not an upgrade", async () => {
    // Tokens in URLs reach access logs and proxy caches. The query string is
    // accepted for the one request that cannot use a header, and nowhere else
    // — otherwise every route would quietly grow a second, leakier way in.
    const t = await createTenant("Suriani WS Scope");
    const res = await SELF.fetch(
      `https://api.test/api/outlets/${t.outletId}/menu?access_token=${t.token}`,
    );
    expect(res.status).toBe(401);
  });

  it("still answers 404 across tenants on the socket", async () => {
    const a = await createTenant("Suriani WS A");
    const b = await createTenant("Warung WS B");
    const res = await SELF.fetch(wsUrl(b.outletId, `?access_token=${a.token}`), {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(404);
  });
});
