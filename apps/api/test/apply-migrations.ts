import { applyD1Migrations, env } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";

// The control-plane schema is applied once, from the same SQL files that ship
// to production — not a test-only copy that could drift out of step with them.
//
// TEST_MIGRATIONS is injected by vitest.config.ts and exists only under test,
// so it is read through a local cast rather than added to the Worker's real
// binding types.
const { TEST_MIGRATIONS } = env as unknown as {
  TEST_MIGRATIONS: D1Migration[];
};

await applyD1Migrations(env.DB, TEST_MIGRATIONS);
