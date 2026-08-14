import { env } from "cloudflare:test";

import { hashPin } from "../src/auth/pin";
import { createSession } from "../src/auth/session";
import { doId, id, qrToken } from "../src/lib/ids";

export interface Tenant {
  orgId: string;
  userId: string;
  outletId: string;
  doId: string;
  phone: string;
  pin: string;
  token: string;
  qrToken: string;
  itemId: string;
  itemPriceSen: number;
}

let counter = 0;

/**
 * Create a complete, independent tenant: organisation, owner, outlet, and a
 * seeded menu and table inside that outlet's own Durable Object.
 *
 * Every test that matters here builds two of these and then tries to make one
 * see the other.
 */
export async function createTenant(name: string): Promise<Tenant> {
  const n = ++counter;
  const orgId = id("org");
  const userId = id("usr");
  const outletId = id("out");
  const outletDoId = doId();
  const phone = `+60120000${String(n).padStart(3, "0")}`;
  const pin = "246810";
  const token = qrToken();
  const itemId = id("item");
  const itemPriceSen = 1200;
  const now = Date.now();

  const { hash, salt } = await hashPin(pin);

  await env.DB.prepare(
    "INSERT INTO organizations (id, name, plan, created_at) VALUES (?, ?, 'pilot', ?)",
  )
    .bind(orgId, name, now)
    .run();

  await env.DB.prepare(
    `INSERT INTO users (id, org_id, name, phone, role, pin_hash, pin_salt, created_at)
     VALUES (?, ?, ?, ?, 'owner', ?, ?, ?)`,
  )
    .bind(userId, orgId, `${name} Owner`, phone, hash, salt, now)
    .run();

  await env.DB.prepare(
    `INSERT INTO outlets (id, org_id, name, do_id, status, created_at)
     VALUES (?, ?, ?, ?, 'active', ?)`,
  )
    .bind(outletId, orgId, `${name} Cawangan`, outletDoId, now)
    .run();

  // Test code may address the Durable Object directly; the single-door rule
  // constrains src/, which is what ships.
  const stub = env.OUTLET.get(env.OUTLET.idFromName(outletDoId));
  await stub.installSeed({
    categories: [{ id: `cat_${n}`, nameMs: "Nasi", nameEn: "Rice", sortOrder: 0 }],
    items: [
      {
        id: itemId,
        categoryId: `cat_${n}`,
        nameMs: "Nasi Lemak Ayam Berempah",
        nameEn: "Nasi Lemak with Spiced Chicken",
        priceSen: itemPriceSen,
        tags: ["halal", "best"],
        prepMinutes: 12,
      },
    ],
    tables: [{ id: `tbl_${n}`, label: "Meja 05", qrToken: token }],
  });

  const sessionToken = await createSession(
    { userId, orgId, role: "owner" },
    env.SESSION_SECRET,
  );

  return {
    orgId,
    userId,
    outletId,
    doId: outletDoId,
    phone,
    pin,
    token: sessionToken,
    qrToken: token,
    itemId,
    itemPriceSen,
  };
}

export function auth(tenant: Tenant): HeadersInit {
  return { Authorization: `Bearer ${tenant.token}` };
}

/**
 * A valid session for the same tenant but a different role.
 *
 * Used to prove the role gate answers 403 for a cashier while still answering
 * 404 for someone from another organisation — two different kinds of "no"
 * that must never collapse into one.
 */
export async function authAs(
  tenant: Tenant,
  role: "owner" | "manager" | "cashier",
): Promise<HeadersInit> {
  const token = await createSession(
    { userId: tenant.userId, orgId: tenant.orgId, role },
    env.SESSION_SECRET,
  );
  return { Authorization: `Bearer ${token}` };
}
