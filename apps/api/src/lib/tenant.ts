/**
 * THE TENANT DOOR
 *
 * Every path to an outlet's data goes through this file. Nothing else in the
 * codebase may call `env.OUTLET.get` — enforced by an ESLint rule and by
 * `test/isolation.test.ts`, which greps the source tree and fails the build if
 * a second call site appears.
 *
 * The catastrophic failure for a POS SaaS is one restaurant seeing another's
 * sales. Concentrating the check here means there is exactly one place to audit
 * and exactly one place that can be wrong.
 */
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";

import * as control from "../control/schema";
import type { SessionPayload } from "../auth/session";
import type { OutletDO } from "../outlet/OutletDO";

export interface OutletHandle {
  outlet: control.Outlet;
  stub: DurableObjectStub<OutletDO>;
}

/**
 * Resolve an outlet for an authenticated staff session.
 *
 * Returns null — never throws, never distinguishes reasons — when the outlet
 * does not exist, belongs to another organisation, or is suspended. Callers
 * answer **404** for all three.
 *
 * The 404 matters. A 403 would confirm that an outlet id exists, which lets an
 * attacker enumerate the platform's customers one id at a time. "Not found" is
 * the only honest answer to give someone with no right to know.
 */
export async function getOutletForSession(
  env: Env,
  session: SessionPayload,
  outletId: string,
): Promise<OutletHandle | null> {
  const db = drizzle(env.DB, { schema: control });
  const rows = await db
    .select()
    .from(control.outlets)
    .where(eq(control.outlets.id, outletId))
    .limit(1);

  const outlet = rows[0];
  if (!outlet) return null;
  if (outlet.orgId !== session.orgId) return null;
  if (outlet.status !== "active") return null;

  return { outlet, stub: stubFor(env, outlet.doId) };
}

/**
 * Resolve an outlet for the public customer-ordering path, where there is no
 * session — the customer is a stranger with a phone.
 *
 * This deliberately performs no ownership check, because there is no identity
 * to check against. Authorisation instead comes from the table's `qr_token`,
 * which is a 160-bit secret verified *inside* the Durable Object. Knowing an
 * outlet id alone yields nothing: every public operation requires the token.
 */
export async function getPublicOutlet(
  env: Env,
  outletId: string,
): Promise<OutletHandle | null> {
  const db = drizzle(env.DB, { schema: control });
  const rows = await db
    .select()
    .from(control.outlets)
    .where(eq(control.outlets.id, outletId))
    .limit(1);

  const outlet = rows[0];
  if (!outlet) return null;
  if (outlet.status !== "active") return null;

  return { outlet, stub: stubFor(env, outlet.doId) };
}

/** Every outlet the session's organisation owns. */
export async function listOutletsForSession(
  env: Env,
  session: SessionPayload,
): Promise<control.Outlet[]> {
  const db = drizzle(env.DB, { schema: control });
  return db
    .select()
    .from(control.outlets)
    .where(eq(control.outlets.orgId, session.orgId));
}

/**
 * The only `env.OUTLET.get` call site in the codebase.
 *
 * `doId` is a random string held in D1, never derived from the outlet id, so
 * an attacker who enumerates outlet ids still cannot address a Durable Object.
 * Not exported: the mapping from "an outlet you are allowed to touch" to "its
 * storage" must not be reachable without passing one of the checks above.
 */
function stubFor(env: Env, doId: string): DurableObjectStub<OutletDO> {
  return env.OUTLET.get(env.OUTLET.idFromName(doId));
}
