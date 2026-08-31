import { defineConfig } from "vitest/config";

// Pure byte-level tests: no Workers runtime needed, so these run in plain
// node and stay fast.
export default defineConfig({ test: { environment: "node" } });
