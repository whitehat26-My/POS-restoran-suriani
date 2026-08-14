#!/usr/bin/env node
/**
 * Onboard Restoran Suriani and its two branches.
 *
 * Calls the guarded /api/admin/seed endpoint, so it works identically against
 * `wrangler dev` and against a deployed Worker — there is no separate local-only
 * seeding path that could drift from how real onboarding happens.
 *
 *   API_URL=http://localhost:8787 \
 *   ADMIN_SEED_TOKEN=... \
 *   OWNER_PHONE=+60123456789 OWNER_PIN=246810 \
 *   pnpm seed
 */

const API_URL = process.env.API_URL ?? "http://localhost:8787";
const TOKEN = process.env.ADMIN_SEED_TOKEN;
const OWNER_PHONE = process.env.OWNER_PHONE ?? "+60123456789";
const OWNER_PIN = process.env.OWNER_PIN ?? "246810";

if (!TOKEN) {
  console.error(
    "ADMIN_SEED_TOKEN is not set.\n\n" +
      "  Local:  add ADMIN_SEED_TOKEN to apps/api/.dev.vars\n" +
      "  Remote: pnpm wrangler secret put ADMIN_SEED_TOKEN\n\n" +
      "The seed endpoint answers 404 without it, by design.",
  );
  process.exit(1);
}

const res = await fetch(`${API_URL}/api/admin/seed`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${TOKEN}`,
  },
  body: JSON.stringify({
    orgName: "Restoran Suriani",
    ownerName: "Puan Suriani",
    ownerPhone: OWNER_PHONE,
    ownerPin: OWNER_PIN,
  }),
});

if (!res.ok) {
  console.error(`Seed failed: ${res.status} ${await res.text()}`);
  if (res.status === 404) {
    console.error(
      "\nA 404 here usually means ADMIN_SEED_TOKEN does not match the value " +
        "the Worker was started with.",
    );
  }
  process.exit(1);
}

const body = await res.json();

if (!body.created) {
  console.log("Already seeded — nothing to do.\n");
} else {
  console.log("Seeded Restoran Suriani.\n");
}

console.log(`  Organisation: ${body.orgId}`);
for (const outlet of body.outlets) {
  console.log(`\n  ${outlet.name}`);
  console.log(`    id: ${outlet.id}`);
  if (outlet.sampleQrPath) {
    console.log(`    Meja 01 QR: ${API_URL}${outlet.sampleQrPath}`);
  }
}
console.log(`\n  Sign in with phone ${OWNER_PHONE} and the PIN you set.\n`);
