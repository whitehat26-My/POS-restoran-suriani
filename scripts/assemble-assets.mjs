#!/usr/bin/env node
/**
 * Assemble the Worker's static assets from both web apps:
 *
 *   apps/menu/dist  →  apps/api/.assets/        (customer app, SPA fallback)
 *   apps/pos/dist   →  apps/api/.assets/pos/    (the till, base /pos/)
 *
 * One Worker serves both surfaces from one directory, so neither can drift
 * from the API it talks to.
 */
import { cpSync, mkdirSync, rmSync } from "node:fs";

const out = new URL("../apps/api/.assets", import.meta.url).pathname;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(new URL("../apps/menu/dist", import.meta.url).pathname, out, {
  recursive: true,
});
cpSync(
  new URL("../apps/pos/dist", import.meta.url).pathname,
  `${out}/pos`,
  { recursive: true },
);
console.log("assets assembled → apps/api/.assets (menu at /, till at /pos/)");
