/**
 * Suriani POS API.
 *
 * Two route families with deliberately different trust models:
 *
 *   /api/*  — staff. Requires a signed session; every outlet lookup goes
 *             through the tenant door and answers 404 across tenants.
 *   /t/*    — customers. No session, no identity. Authorised purely by the
 *             table's QR secret, which is verified inside the outlet's own
 *             Durable Object.
 */
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";

import { renderCards } from "./cards";

import * as control from "./control/schema";
import { hashPin, hashSecret, verifyPin, verifySecret } from "./auth/pin";
import { timingSafeEqualString } from "./lib/compare";
import { doId, id, qrToken, agentSecret } from "./lib/ids";
import {
  SEED_CATEGORIES,
  SEED_ITEMS,
  SEED_MODIFIER_GROUPS,
  SEED_OUTLETS,
  SEED_STATIONS,
} from "./seed-data";
import {
  createSession,
  readSessionCookie,
  sessionCookieHeader,
  verifySession,
  type SessionPayload,
} from "./auth/session";
import {
  getOutletForSession,
  getPublicOutlet,
  listOutletsForSession,
} from "./lib/tenant";
import type { PlaceOrderLine, SyncOp } from "./outlet/OutletDO";

export { OutletDO } from "./outlet/OutletDO";

type Vars = { session: SessionPayload; device: control.Device };

const app = new Hono<{ Bindings: Env; Variables: Vars }>();


/* ------------------------------------------------------------------ *
 * Cross-origin access, for the tablet only
 *
 * The Android shell serves the till from inside the APK, so its origin is the
 * device itself and every API call is cross-origin. Three deliberate choices:
 *
 *  - **An allowlist, never a wildcard.** These are the only origins a
 *    Capacitor shell can have. A `*` would let any web page a cashier happens
 *    to open talk to this API with whatever token it could get hold of.
 *
 *  - **No `Allow-Credentials`, ever.** The tablet authenticates with a bearer
 *    token it holds itself, so no cookie is sent cross-origin — which means
 *    there is no CSRF surface here at all. Turning credentials on to "make
 *    cookies work" would create one.
 *
 *  - **Registered before the auth middleware**, because a preflight carries no
 *    Authorization header and would otherwise be answered 401 — and a browser
 *    reads a failed preflight as "this API refuses you", with no way to tell
 *    that the real request would have worked.
 * ------------------------------------------------------------------ */

const SHELL_ORIGINS = new Set([
  "https://localhost",     // Capacitor Android, androidScheme: "https"
  "http://localhost",      // Capacitor Android, http scheme
  "capacitor://localhost", // Capacitor iOS, if it is ever built
]);

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Max-Age": "86400",
    // Origin is part of the cache key, so a proxy cannot hand one origin's
    // response to another.
    Vary: "Origin",
  };
}

const cors = createMiddleware<{ Bindings: Env; Variables: Vars }>(async (c, next) => {
  const origin = c.req.header("Origin");
  const allowed = origin !== undefined && SHELL_ORIGINS.has(origin);

  if (c.req.method === "OPTIONS") {
    return allowed
      ? new Response(null, { status: 204, headers: corsHeaders(origin) })
      : c.json({ error: "origin not allowed" }, 403);
  }

  await next();
  if (allowed) {
    for (const [key, value] of Object.entries(corsHeaders(origin))) {
      c.header(key, value);
    }
  }
});

app.use("/api/*", cors);

/*
 * /health needs it too, and needs it registered *before* the route.
 *
 * Hono composes handlers in registration order, so a route declared above its
 * middleware never runs that middleware. This is the first request a tablet
 * ever makes — the setup screen proves the address before storing it — so
 * without the headers here the shell can never get past its own first screen,
 * while the same URL works perfectly in a browser. A cross-origin bug that
 * only appears on the device is exactly the kind that gets found in a
 * restaurant rather than in CI.
 */
app.use("/health", cors);
app.get("/health", (c) => c.json({ ok: true }));

/* ------------------------------------------------------------------ *
 * Onboarding
 *
 * Early customers are onboarded by hand — there is no self-serve signup until
 * Phase 9. This endpoint creates an organisation, its owner and its outlets in
 * one call.
 *
 * It fails closed: without ADMIN_SEED_TOKEN configured the route answers 404,
 * so it cannot sit unguarded in a deployment where nobody set the secret.
 * ------------------------------------------------------------------ */

app.post("/api/admin/seed", async (c) => {
  const expected = c.env.ADMIN_SEED_TOKEN;
  const provided = c.req
    .header("Authorization")
    ?.replace(/^Bearer\s+/i, "");
  if (
    !expected ||
    !provided ||
    !timingSafeEqualString(provided, expected)
  ) {
    return c.json({ error: "not found" }, 404);
  }

  const body = await c.req.json<{
    orgName?: string;
    ownerName?: string;
    ownerPhone: string;
    ownerPin: string;
    /**
     * Re-apply the master menu to an org that already exists.
     *
     * Opt-in on purpose. Once Phase 7 lets an owner edit her own menu, a
     * seed run that silently overwrote it would be the worst kind of bug —
     * so the caller has to say so.
     */
    syncMenu?: boolean;
  }>();

  if (!body.ownerPhone || !body.ownerPin) {
    return c.json({ error: "ownerPhone and ownerPin required" }, 400);
  }

  const db = drizzle(c.env.DB, { schema: control });

  // Idempotent: re-running must not create a second Restoran Suriani.
  const existing = await db
    .select()
    .from(control.users)
    .where(eq(control.users.phone, body.ownerPhone))
    .limit(1);
  if (existing[0]) {
    const owned = await db
      .select()
      .from(control.outlets)
      .where(eq(control.outlets.orgId, existing[0].orgId));

    if (!body.syncMenu) {
      return c.json({
        created: false,
        orgId: existing[0].orgId,
        outlets: owned.map((o) => ({ id: o.id, name: o.name })),
      });
    }

    const synced: Array<{
      id: string;
      name: string;
      categories: number;
      items: number;
      removedCategories: number;
      removedItems: number;
    }> = [];
    for (const outlet of owned) {
      const handle = await getPublicOutlet(c.env, outlet.id);
      if (!handle) continue;
      await handle.stub.updateSettings({ outletName: outlet.name });
      const result = await handle.stub.applyMenu({
        categories: SEED_CATEGORIES,
        items: SEED_ITEMS,
        modifierGroups: SEED_MODIFIER_GROUPS,
        stations: SEED_STATIONS,
      });
      synced.push({ id: outlet.id, name: outlet.name, ...result });
    }

    return c.json({
      created: false,
      menuSynced: true,
      orgId: existing[0].orgId,
      outlets: synced,
    });
  }

  const now = Date.now();
  const orgId = id("org");
  const userId = id("usr");
  const { hash, salt } = await hashPin(body.ownerPin);

  await db.insert(control.organizations).values({
    id: orgId,
    name: body.orgName ?? "Restoran Suriani",
    ssmNo: null,
    plan: "pilot",
    createdAt: now,
  });

  await db.insert(control.users).values({
    id: userId,
    orgId,
    name: body.ownerName ?? "Puan Suriani",
    phone: body.ownerPhone,
    email: null,
    role: "owner",
    pinHash: hash,
    pinSalt: salt,
    createdAt: now,
  });

  const created: Array<{ id: string; name: string; sampleQrPath: string }> = [];

  for (const spec of SEED_OUTLETS) {
    const outletId = id("out");
    const outletDoId = doId();

    await db.insert(control.outlets).values({
      id: outletId,
      orgId,
      name: spec.name,
      address: null,
      doId: outletDoId,
      timezone: "Asia/Kuala_Lumpur",
      status: "active",
      createdAt: now,
    });

    const tables = Array.from({ length: spec.tables }, (_, i) => ({
      id: id("tbl"),
      label: `Meja ${String(i + 1).padStart(2, "0")}`,
      // A 160-bit secret per table, not the table number.
      qrToken: qrToken(),
    }));

    const handle = await getPublicOutlet(c.env, outletId);
    if (!handle) return c.json({ error: "outlet creation failed" }, 500);

    await handle.stub.installSeed({
      categories: SEED_CATEGORIES,
      items: SEED_ITEMS,
      tables,
      modifierGroups: SEED_MODIFIER_GROUPS,
      stations: SEED_STATIONS,
      outletName: spec.name,
    });

    created.push({
      id: outletId,
      name: spec.name,
      sampleQrPath: `/t/${outletId}/${tables[0]!.qrToken}`,
    });
  }

  return c.json({ created: true, orgId, outlets: created }, 201);
});

/* ------------------------------------------------------------------ *
 * Staff authentication
 * ------------------------------------------------------------------ */

app.post("/api/auth/login", async (c) => {
  const body = await c.req.json<{ phone?: string; pin?: string }>();
  if (!body.phone || !body.pin) {
    return c.json({ error: "phone and pin required" }, 400);
  }

  const db = drizzle(c.env.DB, { schema: control });
  const rows = await db
    .select()
    .from(control.users)
    .where(eq(control.users.phone, body.phone))
    .limit(1);

  const user = rows[0];
  // Same response whether the user is unknown or the PIN is wrong, so the
  // endpoint cannot be used to discover which staff phone numbers exist.
  const ok = user
    ? await verifyPin(body.pin, user.pinHash, user.pinSalt)
    : false;
  if (!user || !ok) return c.json({ error: "invalid credentials" }, 401);

  const token = await createSession(
    {
      userId: user.id,
      orgId: user.orgId,
      role: user.role as SessionPayload["role"],
    },
    c.env.SESSION_SECRET,
  );

  c.header("Set-Cookie", sessionCookieHeader(token));
  return c.json({ token, user: { id: user.id, name: user.name, role: user.role } });
});

/* ------------------------------------------------------------------ *
 * Staff routes — everything below requires a valid session
 * ------------------------------------------------------------------ */

app.use("/api/outlets/*", async (c, next) => {
  const bearer = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "");

  // A WebSocket handshake cannot carry an Authorization header, and from the
  // tablet it is cross-origin so it carries no cookie either. The token comes
  // in the query string for that one case — and *only* that case, because
  // URLs end up in access logs and proxy caches in a way headers do not.
  const upgrading = c.req.header("Upgrade")?.toLowerCase() === "websocket";
  const fromQuery = upgrading ? c.req.query("access_token") : undefined;

  const token = bearer ?? fromQuery ?? readSessionCookie(c.req.raw);
  const session = token
    ? await verifySession(token, c.env.SESSION_SECRET)
    : null;
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  c.set("session", session);
  await next();
});

app.get("/api/outlets", async (c) => {
  const bearer = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "");
  const token = bearer ?? readSessionCookie(c.req.raw);
  const session = token
    ? await verifySession(token, c.env.SESSION_SECRET)
    : null;
  if (!session) return c.json({ error: "unauthenticated" }, 401);

  const outlets = await listOutletsForSession(c.env, session);
  return c.json({
    // The role travels with the outlet list so the till can hide the owner's
    // record screen rather than offering a button that answers 403.
    role: session.role,
    outlets: outlets.map((o) => ({ id: o.id, name: o.name, status: o.status })),
  });
});

app.get("/api/outlets/:outletId/menu", async (c) => {
  const handle = await getOutletForSession(
    c.env,
    c.get("session"),
    c.req.param("outletId"),
  );
  if (!handle) return c.json({ error: "not found" }, 404);
  return c.json(await handle.stub.listMenu());
});

app.get("/api/outlets/:outletId/orders", async (c) => {
  const handle = await getOutletForSession(
    c.env,
    c.get("session"),
    c.req.param("outletId"),
  );
  if (!handle) return c.json({ error: "not found" }, 404);
  return c.json({ orders: await handle.stub.listOrders() });
});

/* ------------------------------------------------------------------ *
 * Floor plan — tables and zones
 *
 * Two different kinds of "no" live here and must not be merged:
 *
 *   another org's outlet          → 404, you may not know it exists
 *   cashier editing own outlet    → 403, you are legitimately here but
 *                                   not permitted to restructure the floor
 *
 * Answering 404 for both would hide permission bugs behind a plausible
 * response; answering 403 for both would leak the customer list.
 * ------------------------------------------------------------------ */

/** Requires one of `roles`, having already passed the session middleware. */
function requireRole(...roles: SessionPayload["role"][]) {
  return createMiddleware<{ Bindings: Env; Variables: Vars }>(
    async (c, next) => {
      const session = c.get("session");
      if (!session || !roles.includes(session.role)) {
        return c.json(
          { error: "forbidden", detail: `requires ${roles.join(" or ")}` },
          403,
        );
      }
      await next();
    },
  );
}

const manages = requireRole("owner", "manager");

app.get("/api/outlets/:outletId/tables", async (c) => {
  const handle = await getOutletForSession(
    c.env,
    c.get("session"),
    c.req.param("outletId"),
  );
  if (!handle) return c.json({ error: "not found" }, 404);
  const includeArchived = c.req.query("includeArchived") === "true";
  return c.json({ tables: await handle.stub.listTables(includeArchived) });
});

app.get("/api/outlets/:outletId/zones", async (c) => {
  const handle = await getOutletForSession(
    c.env,
    c.get("session"),
    c.req.param("outletId"),
  );
  if (!handle) return c.json({ error: "not found" }, 404);
  return c.json({ zones: await handle.stub.listZones() });
});

/** Create one table, or a whole floor at once. */
app.post("/api/outlets/:outletId/tables", manages, async (c) => {
  const session = c.get("session");
  const handle = await getOutletForSession(
    c.env,
    session,
    c.req.param("outletId"),
  );
  if (!handle) return c.json({ error: "not found" }, 404);

  const body = await c.req.json<{
    label?: string;
    labels?: string[];
    zoneId?: string | null;
    capacity?: number | null;
  }>();

  const labels = body.labels ?? (body.label ? [body.label] : []);
  const result = await handle.stub.createTables({
    labels,
    zoneId: body.zoneId ?? null,
    capacity: body.capacity ?? null,
    userId: session.userId,
  });

  if (!result.ok) {
    return c.json(
      { error: result.error, detail: result.detail },
      result.error === "label_taken" ? 409 : 400,
    );
  }
  return c.json({ tables: result.tables }, 201);
});

app.patch("/api/outlets/:outletId/tables/:tableId", manages, async (c) => {
  const session = c.get("session");
  const handle = await getOutletForSession(
    c.env,
    session,
    c.req.param("outletId"),
  );
  if (!handle) return c.json({ error: "not found" }, 404);

  const body = await c.req.json<{
    label?: string;
    zoneId?: string | null;
    capacity?: number | null;
    sortOrder?: number;
  }>();

  const result = await handle.stub.updateTable({
    tableId: c.req.param("tableId"),
    ...body,
    userId: session.userId,
  });

  if (!result.ok) {
    if (result.error === "not_found") return c.json({ error: "not found" }, 404);
    return c.json({ error: result.error, detail: result.detail }, 409);
  }
  return c.json({ ok: true });
});

/**
 * Issue a new QR secret.
 *
 * Requires `confirm: true` because this instantly kills the card sitting on
 * that table — not something to trigger by a mis-tap during lunch.
 */
app.post(
  "/api/outlets/:outletId/tables/:tableId/rotate",
  manages,
  async (c) => {
    const session = c.get("session");
    const handle = await getOutletForSession(
      c.env,
      session,
      c.req.param("outletId"),
    );
    if (!handle) return c.json({ error: "not found" }, 404);

    // An empty or malformed body must fall through to the confirmation
    // error, not a 500 — rotating is destructive, so the safe path is the
    // one that refuses.
    const body = await c.req
      .json<{ confirm?: boolean }>()
      .catch((): { confirm?: boolean } => ({}));
    if (body.confirm !== true) {
      return c.json(
        {
          error: "confirmation_required",
          detail:
            "Rotating invalidates the printed card for this table. Send confirm: true.",
        },
        400,
      );
    }

    const result = await handle.stub.rotateTableToken({
      tableId: c.req.param("tableId"),
      userId: session.userId,
    });
    if (!result.ok) return c.json({ error: "not found" }, 404);
    return c.json({ qrToken: result.qrToken });
  },
);

app.delete("/api/outlets/:outletId/tables/:tableId", manages, async (c) => {
  const session = c.get("session");
  const handle = await getOutletForSession(
    c.env,
    session,
    c.req.param("outletId"),
  );
  if (!handle) return c.json({ error: "not found" }, 404);

  const result = await handle.stub.archiveTable({
    tableId: c.req.param("tableId"),
    userId: session.userId,
  });

  if (!result.ok) {
    if (result.error === "open_session") {
      return c.json(
        {
          error: "open_session",
          detail: `Table still has an open bill (${result.detail}). Close it first.`,
        },
        409,
      );
    }
    return c.json({ error: "not found" }, 404);
  }
  return c.json({ ok: true });
});

app.post(
  "/api/outlets/:outletId/tables/:tableId/restore",
  manages,
  async (c) => {
    const session = c.get("session");
    const handle = await getOutletForSession(
      c.env,
      session,
      c.req.param("outletId"),
    );
    if (!handle) return c.json({ error: "not found" }, 404);

    const result = await handle.stub.restoreTable({
      tableId: c.req.param("tableId"),
      userId: session.userId,
    });
    if (!result.ok) {
      if (result.error === "not_found") {
        return c.json({ error: "not found" }, 404);
      }
      return c.json({ error: result.error, detail: result.detail }, 409);
    }
    return c.json({ ok: true });
  },
);

app.post("/api/outlets/:outletId/zones", manages, async (c) => {
  const handle = await getOutletForSession(
    c.env,
    c.get("session"),
    c.req.param("outletId"),
  );
  if (!handle) return c.json({ error: "not found" }, 404);

  const body = await c.req.json<{
    nameMs: string;
    nameEn: string;
    sortOrder?: number;
  }>();
  if (!body.nameMs || !body.nameEn) {
    return c.json({ error: "nameMs and nameEn required" }, 400);
  }
  return c.json(await handle.stub.createZone(body), 201);
});

app.patch("/api/outlets/:outletId/zones/:zoneId", manages, async (c) => {
  const handle = await getOutletForSession(
    c.env,
    c.get("session"),
    c.req.param("outletId"),
  );
  if (!handle) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<{
    nameMs?: string;
    nameEn?: string;
    sortOrder?: number;
  }>();
  return c.json(
    await handle.stub.updateZone({ zoneId: c.req.param("zoneId"), ...body }),
  );
});

app.delete("/api/outlets/:outletId/zones/:zoneId", manages, async (c) => {
  const handle = await getOutletForSession(
    c.env,
    c.get("session"),
    c.req.param("outletId"),
  );
  if (!handle) return c.json({ error: "not found" }, 404);
  // Un-groups its tables rather than deleting them.
  return c.json(await handle.stub.deleteZone(c.req.param("zoneId")));
});

app.get("/api/outlets/:outletId/settings", manages, async (c) => {
  const handle = await getOutletForSession(
    c.env,
    c.get("session"),
    c.req.param("outletId"),
  );
  if (!handle) return c.json({ error: "not found" }, 404);
  return c.json(await handle.stub.getSettings());
});

app.patch("/api/outlets/:outletId/settings", manages, async (c) => {
  const handle = await getOutletForSession(
    c.env,
    c.get("session"),
    c.req.param("outletId"),
  );
  if (!handle) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<{
    wifiSsid?: string | null;
    wifiPassword?: string | null;
    localOrderUrl?: string | null;
  }>();
  return c.json(await handle.stub.updateSettings(body));
});

/** Print-ready cards for every active table. Open and press Print. */
app.get("/api/outlets/:outletId/tables/cards", manages, async (c) => {
  const handle = await getOutletForSession(
    c.env,
    c.get("session"),
    c.req.param("outletId"),
  );
  if (!handle) return c.json({ error: "not found" }, 404);

  const [tables, settings] = await Promise.all([
    handle.stub.listTables(),
    handle.stub.getSettings(),
  ]);

  const html = renderCards({
    outletName: handle.outlet.name,
    origin: new URL(c.req.url).origin,
    outletId: handle.outlet.id,
    tables: tables.map((t) => ({ label: t.label, qrToken: t.qrToken })),
    localOrderUrl: settings.localOrderUrl,
    wifiSsid: settings.wifiSsid,
    wifiPassword: settings.wifiPassword,
  });

  return c.html(html);
});

/** Counter order entry — walk-ins and phone orders. QR is never the only path. */
app.post("/api/outlets/:outletId/orders", async (c) => {
  const handle = await getOutletForSession(
    c.env,
    c.get("session"),
    c.req.param("outletId"),
  );
  if (!handle) return c.json({ error: "not found" }, 404);

  const body = await c.req.json<{
    qrToken?: string;
    tableId?: string;
    lines: PlaceOrderLine[];
    clientUlid?: string;
  }>();
  if (!body.qrToken && !body.tableId) {
    return c.json({ error: "qrToken or tableId required" }, 400);
  }

  const result = await handle.stub.placeOrder({
    qrToken: body.qrToken,
    tableId: body.tableId,
    lines: body.lines,
    clientUlid: body.clientUlid,
    source: "counter",
  });

  if (!result.ok) {
    if (result.error === "unknown_table") {
      return c.json({ error: "not found" }, 404);
    }
    return c.json({ error: result.error, detail: result.detail }, 400);
  }
  return c.json(result.order, result.order.duplicate ? 200 : 201);
});

/* ------------------------------------------------------------------ *
 * The till — floor, bills, service lifecycle, realtime
 * ------------------------------------------------------------------ */

/**
 * Live events. The upgrade rides the session cookie through the same
 * middleware and tenant door as every staff route, then is forwarded to the
 * outlet's Durable Object, which owns the sockets.
 */
app.get("/api/outlets/:outletId/ws", async (c) => {
  const handle = await getOutletForSession(
    c.env,
    c.get("session"),
    c.req.param("outletId"),
  );
  if (!handle) return c.json({ error: "not found" }, 404);
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    return c.json({ error: "expected websocket upgrade" }, 426);
  }
  return handle.stub.fetch(c.req.raw);
});

app.get("/api/outlets/:outletId/floor", async (c) => {
  const handle = await getOutletForSession(
    c.env,
    c.get("session"),
    c.req.param("outletId"),
  );
  if (!handle) return c.json({ error: "not found" }, 404);
  const [zones, tables] = await Promise.all([
    handle.stub.listZones(),
    handle.stub.getFloor(),
  ]);
  return c.json({ zones, tables });
});

/** The bill sheet for one table. */
app.get("/api/outlets/:outletId/tables/:tableId/bill", async (c) => {
  const handle = await getOutletForSession(
    c.env,
    c.get("session"),
    c.req.param("outletId"),
  );
  if (!handle) return c.json({ error: "not found" }, 404);
  const detail = await handle.stub.getSessionDetail(c.req.param("tableId"));
  if (!detail) return c.json({ error: "not found" }, 404);
  return c.json(detail);
});

app.post("/api/outlets/:outletId/orders/:orderId/served", async (c) => {
  const session = c.get("session");
  const handle = await getOutletForSession(
    c.env,
    session,
    c.req.param("outletId"),
  );
  if (!handle) return c.json({ error: "not found" }, 404);
  const result = await handle.stub.markOrderServed({
    orderId: c.req.param("orderId"),
    userId: session.userId,
  });
  if (!result.ok) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

/**
 * Close a bill and free the table. Phase 6 fronts this with payment
 * recording; until then closing is audit-logged, never silent.
 */
app.post("/api/outlets/:outletId/sessions/:sessionId/close", async (c) => {
  const session = c.get("session");
  const handle = await getOutletForSession(
    c.env,
    session,
    c.req.param("outletId"),
  );
  if (!handle) return c.json({ error: "not found" }, 404);
  const result = await handle.stub.closeSession({
    sessionId: c.req.param("sessionId"),
    userId: session.userId,
  });
  if (!result.ok) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

/**
 * Print the bill for an open table.
 *
 * Any staff role, deliberately: a cashier who cannot hand a customer their
 * bill cannot do the job. Phase 6 will pass a `method` here once a payment has
 * been recorded; until then the slip prints as an unsettled bill.
 */
app.post("/api/outlets/:outletId/sessions/:sessionId/receipt", async (c) => {
  const session = c.get("session");
  const handle = await getOutletForSession(
    c.env,
    session,
    c.req.param("outletId"),
  );
  if (!handle) return c.json({ error: "not found" }, 404);

  const result = await handle.stub.queueReceipt({
    sessionId: c.req.param("sessionId"),
    userId: session.userId,
  });
  if (!result.ok) {
    return result.error === "no_station"
      ? c.json({ error: "no print station configured" }, 409)
      : c.json({ error: "not found" }, 404);
  }
  return c.json(result);
});

/** 86-ing. Any staff role: it is the cashier who sees the empty pot. */
app.patch("/api/outlets/:outletId/items/:itemId/availability", async (c) => {
  const session = c.get("session");
  const handle = await getOutletForSession(
    c.env,
    session,
    c.req.param("outletId"),
  );
  if (!handle) return c.json({ error: "not found" }, 404);
  const body = await c.req.json<{ available?: boolean }>();
  if (typeof body.available !== "boolean") {
    return c.json({ error: "available (boolean) required" }, 400);
  }
  const result = await handle.stub.setItemAvailability({
    itemId: c.req.param("itemId"),
    available: body.available,
    userId: session.userId,
  });
  if (!result.ok) return c.json({ error: "not found" }, 404);
  return c.json(result);
});

/**
 * A tablet hands over what it did while the line was down.
 *
 * Any staff role — the cashier who traded through the outage is the one
 * holding the tablet when it reconnects. Goes through the tenant door like
 * every other outlet route, so a device belonging to another organisation
 * gets 404 and reaches nothing.
 */
app.post("/api/outlets/:outletId/sync", async (c) => {
  const session = c.get("session");
  const handle = await getOutletForSession(
    c.env,
    session,
    c.req.param("outletId"),
  );
  if (!handle) return c.json({ error: "not found" }, 404);

  const body = await c.req.json<{ ops?: SyncOp[] }>();
  if (!Array.isArray(body.ops)) {
    return c.json({ error: "ops (array) required" }, 400);
  }
  // A batch is bounded so one tablet returning from a long outage cannot hold
  // the outlet's single-threaded object for a whole request budget. The
  // device's outbox already drains in batches; this is the backstop.
  if (body.ops.length > 200) {
    return c.json({ error: "too many ops in one batch (max 200)" }, 413);
  }

  return c.json(
    await handle.stub.applyOps({ ops: body.ops, userId: session.userId }),
  );
});

/* ------------------------------------------------------------------ *
 * The daily record
 *
 * Owner and manager only. A cashier gets 403 — they are legitimately here,
 * just not entitled to the takings — and another organisation gets 404. The
 * timezone comes from the outlet row in D1, never from the request: a day
 * boundary the caller can move is a day boundary that can be used to move
 * money between days.
 * ------------------------------------------------------------------ */

app.get("/api/outlets/:outletId/reports/daily", manages, async (c) => {
  const handle = await getOutletForSession(
    c.env,
    c.get("session"),
    c.req.param("outletId"),
  );
  if (!handle) return c.json({ error: "not found" }, 404);

  const days = Number(c.req.query("days") ?? 30);
  const result = await handle.stub.dailySales({
    timeZone: handle.outlet.timezone,
    days: Number.isFinite(days) ? days : 30,
  });
  return c.json(result);
});

app.get("/api/outlets/:outletId/reports/daily/:date", manages, async (c) => {
  const date = c.req.param("date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: "date must be YYYY-MM-DD" }, 400);
  }
  const handle = await getOutletForSession(
    c.env,
    c.get("session"),
    c.req.param("outletId"),
  );
  if (!handle) return c.json({ error: "not found" }, 404);

  return c.json(
    await handle.stub.daySummary({ date, timeZone: handle.outlet.timezone }),
  );
});

/** Printer health for the till's pill and failure banner. */
app.get("/api/outlets/:outletId/print/health", async (c) => {
  const handle = await getOutletForSession(
    c.env,
    c.get("session"),
    c.req.param("outletId"),
  );
  if (!handle) return c.json({ error: "not found" }, 404);
  return c.json(await handle.stub.printHealth());
});

app.get("/api/outlets/:outletId/print/stations", async (c) => {
  const handle = await getOutletForSession(
    c.env,
    c.get("session"),
    c.req.param("outletId"),
  );
  if (!handle) return c.json({ error: "not found" }, 404);
  // The routes come with the stations because the tablet caches both: with
  // the line down it has to decide which docket goes where by itself, and it
  // cannot ask.
  return c.json({
    stations: await handle.stub.listStations(),
    routes: await handle.stub.listStationRoutes(),
  });
});

/** Re-queue a docket. Any staff role: it is the cashier who sees paper jam. */
app.post("/api/outlets/:outletId/print/jobs/:jobId/reprint", async (c) => {
  const session = c.get("session");
  const handle = await getOutletForSession(
    c.env,
    session,
    c.req.param("outletId"),
  );
  if (!handle) return c.json({ error: "not found" }, 404);
  const result = await handle.stub.reprintJob({
    jobId: c.req.param("jobId"),
    userId: session.userId,
  });
  if (!result.ok) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ *
 * The print agent
 *
 * A third trust model, distinct from staff sessions and customer QR tokens:
 * a long-lived device credential scoped to exactly one outlet. A stolen agent
 * token reaches one restaurant's print queue and nothing else — it cannot read
 * sales, open a bill, or touch another branch.
 * ------------------------------------------------------------------ */

/**
 * Register a print agent. Staff-authed and owner/manager only, because it
 * mints a long-lived credential. The token is returned once and never again —
 * only its PBKDF2 hash is stored, so a database leak hands nobody a working
 * agent.
 */
app.post("/api/outlets/:outletId/agents", manages, async (c) => {
  const session = c.get("session");
  const handle = await getOutletForSession(
    c.env,
    session,
    c.req.param("outletId"),
  );
  if (!handle) return c.json({ error: "not found" }, 404);

  const body = await c.req
    .json<{ name?: string }>()
    .catch((): { name?: string } => ({}));

  const deviceId = id("dev");
  const secret = agentSecret();
  const { hash, salt } = await hashSecret(secret);

  const db = drizzle(c.env.DB, { schema: control });
  await db.insert(control.devices).values({
    id: deviceId,
    outletId: handle.outlet.id,
    name: body.name ?? "Print agent",
    kind: "print_agent",
    tokenHash: hash,
    tokenSalt: salt,
    createdAt: Date.now(),
  });

  // Shown once. There is no endpoint that can read it back.
  return c.json({ deviceId, token: `${deviceId}.${secret}` }, 201);
});

/**
 * Resolve an agent token to its device.
 *
 * The token is `<deviceId>.<secret>`; the device row names the one outlet it
 * may touch, so the agent never chooses its own scope.
 */
async function authenticateAgent(
  env: Env,
  header: string | undefined,
): Promise<control.Device | null> {
  const token = header?.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const split = token.indexOf(".");
  if (split < 1) return null;

  const db = drizzle(env.DB, { schema: control });
  const rows = await db
    .select()
    .from(control.devices)
    .where(eq(control.devices.id, token.slice(0, split)))
    .limit(1);

  const device = rows[0];
  if (!device?.tokenHash || !device.tokenSalt) return null;
  const ok = await verifySecret(
    token.slice(split + 1),
    device.tokenHash,
    device.tokenSalt,
  );
  return ok ? device : null;
}

app.use("/api/agent/*", async (c, next) => {
  const device = await authenticateAgent(c.env, c.req.header("Authorization"));
  if (!device) return c.json({ error: "unauthenticated" }, 401);
  c.set("device", device);
  await next();
});

/** Claim work. Leased, not removed — see OutletDO.claimPrintJobs. */
app.get("/api/agent/jobs", async (c) => {
  const device = c.get("device");
  const handle = await getPublicOutlet(c.env, device.outletId);
  if (!handle) return c.json({ error: "not found" }, 404);

  const jobs = await handle.stub.claimPrintJobs({
    deviceId: device.id,
    limit: Number(c.req.query("limit") ?? 5),
  });
  return c.json({ jobs });
});

app.post("/api/agent/jobs/:jobId/ack", async (c) => {
  const device = c.get("device");
  const handle = await getPublicOutlet(c.env, device.outletId);
  if (!handle) return c.json({ error: "not found" }, 404);

  const body = await c.req.json<{
    ok?: boolean;
    transport?: string;
    error?: string;
  }>();

  const result = await handle.stub.ackPrintJob({
    jobId: c.req.param("jobId"),
    ok: body.ok === true,
    transport: body.transport,
    error: body.error,
  });
  if (!result.ok) return c.json({ error: "not found" }, 404);
  return c.json(result);
});

app.post("/api/agent/heartbeat", async (c) => {
  const device = c.get("device");
  const body = await c.req
    .json<{ appVersion?: string; printers?: unknown }>()
    .catch((): { appVersion?: string; printers?: unknown } => ({}));

  const db = drizzle(c.env.DB, { schema: control });
  await db
    .update(control.devices)
    .set({
      lastSeenAt: Date.now(),
      appVersion: body.appVersion ?? null,
      printerConfig: body.printers ? JSON.stringify(body.printers) : null,
    })
    .where(eq(control.devices.id, device.id));
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ *
 * Customer routes — no session. The QR token is the authorisation.
 *
 * Data lives under /api/t/... — the bare /t/:outletId/:qrToken path is the
 * URL printed on every table card, so it must serve the ordering page (the
 * static-asset SPA fallback), never JSON.
 * ------------------------------------------------------------------ */

app.get("/api/t/:outletId/:qrToken", async (c) => {
  const handle = await getPublicOutlet(c.env, c.req.param("outletId"));
  if (!handle) return c.json({ error: "not found" }, 404);

  const table = await handle.stub.resolveTable(c.req.param("qrToken"));
  if (!table) return c.json({ error: "not found" }, 404);

  const menu = await handle.stub.listMenu();
  return c.json({
    outlet: { name: handle.outlet.name },
    table: { label: table.label },
    menu,
  });
});

app.post("/api/t/:outletId/:qrToken/orders", async (c) => {
  const handle = await getPublicOutlet(c.env, c.req.param("outletId"));
  if (!handle) return c.json({ error: "not found" }, 404);

  const body = await c.req.json<{
    lines: PlaceOrderLine[];
    clientUlid?: string;
  }>();

  const result = await handle.stub.placeOrder({
    qrToken: c.req.param("qrToken"),
    lines: body.lines,
    clientUlid: body.clientUlid,
    source: "qr",
  });

  if (!result.ok) {
    // An unknown table token must look identical to an unknown outlet, so a
    // stranger cannot use the ordering endpoint to discover which outlet ids
    // are real.
    if (result.error === "unknown_table") {
      return c.json({ error: "not found" }, 404);
    }
    return c.json({ error: result.error, detail: result.detail }, 400);
  }
  return c.json(result.order, result.order.duplicate ? 200 : 201);
});

/** The status poll driving the Diterima → Dimasak → Dihidang track. */
app.get("/api/t/:outletId/:qrToken/status", async (c) => {
  const handle = await getPublicOutlet(c.env, c.req.param("outletId"));
  if (!handle) return c.json({ error: "not found" }, 404);
  const status = await handle.stub.getStatus(c.req.param("qrToken"));
  if (!status) return c.json({ error: "not found" }, 404);
  return c.json(status);
});

app.post("/api/t/:outletId/:qrToken/bill-request", async (c) => {
  const handle = await getPublicOutlet(c.env, c.req.param("outletId"));
  if (!handle) return c.json({ error: "not found" }, 404);
  const result = await handle.stub.requestBill(c.req.param("qrToken"));
  if (!result.ok) {
    if (result.error === "unknown_table") {
      return c.json({ error: "not found" }, 404);
    }
    return c.json({ error: result.error }, 400);
  }
  return c.json(result);
});

app.post("/api/t/:outletId/:qrToken/call-waiter", async (c) => {
  const handle = await getPublicOutlet(c.env, c.req.param("outletId"));
  if (!handle) return c.json({ error: "not found" }, 404);
  const result = await handle.stub.callWaiter(c.req.param("qrToken"));
  if (!result.ok) return c.json({ error: "not found" }, 404);
  return c.json(result);
});

export default app;
