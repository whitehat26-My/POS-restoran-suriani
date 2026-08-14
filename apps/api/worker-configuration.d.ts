// Bindings for this Worker.
//
// `Env` is declared inside `declare namespace Cloudflare` by
// @cloudflare/workers-types, so it must be augmented there — a plain global
// `interface Env` creates a *different*, empty type and every binding silently
// becomes a type error. This file has no top-level import so that it stays a
// global script; the Durable Object type is referenced inline instead.

declare namespace Cloudflare {
  interface Env {
    /** Control plane: organisations, users, outlets, devices, usage. */
    DB: D1Database;
    /** Data plane: one Durable Object per outlet. */
    OUTLET: DurableObjectNamespace<
      import("./src/outlet/OutletDO").OutletDO
    >;
    /**
     * HMAC key for session cookies.
     * Dev and test use the value in wrangler.jsonc `vars`; production is set
     * with `wrangler secret put SESSION_SECRET` and never committed.
     */
    SESSION_SECRET: string;
    /**
     * Enables the one-shot onboarding endpoint. Unset by default, and the
     * endpoint 404s when it is missing — the seed route fails closed rather
     * than existing unguarded in production.
     * Set with: wrangler secret put ADMIN_SEED_TOKEN
     */
    ADMIN_SEED_TOKEN?: string;
  }
}

interface Env extends Cloudflare.Env {}
