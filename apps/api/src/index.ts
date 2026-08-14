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
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";

import * as control from "./control/schema";
import { hashPin, verifyPin } from "./auth/pin";
import { timingSafeEqualString } from "./lib/compare";
import { doId, id, qrToken } from "./lib/ids";
import { SEED_CATEGORIES, SEED_ITEMS, SEED_OUTLETS } from "./seed-data";
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
import type { PlaceOrderLine } from "./outlet/OutletDO";

export { OutletDO } from "./outlet/OutletDO";

type Vars = { session: SessionPayload };

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

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
    return c.json({
      created: false,
      orgId: existing[0].orgId,
      outlets: owned.map((o) => ({ id: o.id, name: o.name })),
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
  const token = bearer ?? readSessionCookie(c.req.raw);
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

app.get("/api/outlets/:outletId/tables", async (c) => {
  const handle = await getOutletForSession(
    c.env,
    c.get("session"),
    c.req.param("outletId"),
  );
  if (!handle) return c.json({ error: "not found" }, 404);
  return c.json({ tables: await handle.stub.listTables() });
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
    qrToken: string;
    lines: PlaceOrderLine[];
    clientUlid?: string;
  }>();

  const result = await handle.stub.placeOrder({
    qrToken: body.qrToken,
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
 * Customer routes — no session. The QR token is the authorisation.
 * ------------------------------------------------------------------ */

app.get("/t/:outletId/:qrToken", async (c) => {
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

app.post("/t/:outletId/:qrToken/orders", async (c) => {
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

export default app;
