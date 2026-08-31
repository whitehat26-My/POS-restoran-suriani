#!/usr/bin/env node
/**
 * Guard: `env.OUTLET.get` may appear in exactly one file.
 *
 * The tenant door only works if it cannot be walked around. A future change
 * that reaches for a Durable Object stub directly — in a hurry, in a route
 * handler, without the org check — would silently reopen the cross-tenant hole
 * that the whole architecture exists to close.
 *
 * ESLint enforces this too, but ESLint can be disabled inline with a comment.
 * This cannot.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("../src", import.meta.url).pathname;
const ALLOWED = "lib/tenant.ts";
const PATTERN = /\bOUTLET\s*\.\s*get\s*\(/;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

const offenders = walk(ROOT).filter((file) => {
  const rel = relative(ROOT, file);
  if (rel === ALLOWED) return false;
  return PATTERN.test(readFileSync(file, "utf8"));
});

if (offenders.length > 0) {
  console.error(
    "\n✗ Tenant door bypassed.\n\n" +
      `  'env.OUTLET.get' is only allowed in src/${ALLOWED}, because that is\n` +
      "  the one place the organisation ownership check happens.\n\n" +
      "  Found in:\n" +
      offenders.map((f) => `    - src/${relative(ROOT, f)}`).join("\n") +
      "\n\n  Route the access through getOutletForSession() or getPublicOutlet().\n",
  );
  process.exit(1);
}

console.log(`✓ Tenant door intact — env.OUTLET.get confined to src/${ALLOWED}`);
