import { defineConfig } from "vitest/config";
import {
  cloudflarePool,
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";

// Tests run inside the real workerd runtime with real D1 and real Durable
// Objects. Mocked tenant isolation would prove nothing — the whole point of
// isolation.test.ts is that it exercises the actual storage boundary.
//
// Two pieces are required and share one options object: the Vite plugin
// resolves the `cloudflare:test` module, the pool actually executes the tests
// inside workerd.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    new URL("./migrations", import.meta.url).pathname,
  );

  const options = {
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: {
      bindings: {
        // The control-plane schema, read from the same SQL that ships.
        TEST_MIGRATIONS: migrations,
        // Enables the onboarding endpoint under test. In production this is a
        // secret, and the route 404s when it is absent.
        ADMIN_SEED_TOKEN: "test-seed-token",
      },
    },
  };

  return {
    plugins: [cloudflareTest(options)],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      pool: cloudflarePool(options),
    },
  };
});
