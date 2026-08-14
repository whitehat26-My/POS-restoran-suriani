import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", ".wrangler/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      /**
       * The tenant door.
       *
       * `env.OUTLET.get` is the one call that turns "an outlet id" into "that
       * outlet's data". It belongs in src/lib/tenant.ts, where the org
       * ownership check lives, and nowhere else — a second call site is how a
       * cross-tenant leak gets shipped.
       *
       * scripts/check-tenant-door.mjs enforces the same rule and cannot be
       * silenced with an inline comment, which is why both exist.
       */
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression[property.name='get'][object.property.name='OUTLET']",
          message:
            "Do not reach for a Durable Object stub directly. Route outlet access through getOutletForSession() or getPublicOutlet() in src/lib/tenant.ts, which is where the organisation ownership check happens.",
        },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // The door itself, and tests, are allowed through.
    files: ["src/lib/tenant.ts", "test/**/*.ts", "scripts/**/*"],
    rules: { "no-restricted-syntax": "off" },
  },
);
