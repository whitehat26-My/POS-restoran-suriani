/**
 * The tablet's web server, without the tablet.
 *
 * Phase 5b's gate is "unplug the internet and a phone on the shop WiFi still
 * orders, and the ticket prints". Proving that properly needs an Android
 * device, a router and two printers. This harness proves everything up to the
 * socket: the real router, the real menu app, the real docket bytes, over a
 * real HTTP connection a real browser can talk to.
 *
 * What it stands in for is exactly the two pieces CI cannot run — the Java
 * that owns the socket and the Capacitor bridge that carries a request into
 * the WebView. Those are thin by design, for this reason.
 *
 *   node tools/printer-sim/index.mjs                       # the kitchen
 *   pnpm --filter @suriani/menu exec vite build            # the customer app
 *   node tools/local-server-harness/dist.mjs               # this
 *   → http://127.0.0.1:8099/t/out_harness/<token>
 */
import { createServer } from "node:http";
import net from "node:net";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { groupLinesByStation } from "@suriani/core/stations";
import { renderKitchenTicket } from "@suriani/escpos/templates";
import {
  createRouter,
  priceLines,
  resolveModifiers,
  type LocalPorts,
  type OutletCache,
} from "@suriani/localserver";

import {
  SEED_CATEGORIES,
  SEED_ITEMS,
  SEED_MODIFIER_GROUPS,
  SEED_STATIONS,
} from "../../apps/api/src/seed-data";

const PORT = Number(process.env.PORT ?? 8099);
const PRINTER = process.env.PRINTER ?? "127.0.0.1:9100";
const MENU_DIST = path.resolve(import.meta.dirname, "../../apps/menu/dist");
const TOKEN = "HARNESSTOKEN0000000000000000AAAA";

/* ---- the outlet, exactly as a tablet would have cached it -------- */

const groupsByItem = new Map<string, (typeof SEED_MODIFIER_GROUPS)[number][]>();
for (const group of SEED_MODIFIER_GROUPS) {
  const list = groupsByItem.get(group.menuItemId) ?? [];
  list.push(group);
  groupsByItem.set(group.menuItemId, list);
}

const cache: OutletCache = {
  outletId: "out_harness",
  outletName: "Suriani Jalan Imbi (HQ)",
  menuVersion: 1,
  categories: SEED_CATEGORIES.map((c) => ({
    id: c.id,
    nameMs: c.nameMs,
    nameEn: c.nameEn,
    sortOrder: c.sortOrder ?? 0,
  })),
  items: SEED_ITEMS.map((i) => ({
    id: i.id,
    categoryId: i.categoryId,
    nameMs: i.nameMs,
    nameEn: i.nameEn,
    descMs: i.descMs ?? null,
    descEn: i.descEn ?? null,
    priceSen: i.priceSen,
    tags: i.tags ?? [],
    isAvailable: 1,
    prepMinutes: i.prepMinutes ?? 10,
    modifierGroups: (groupsByItem.get(i.id) ?? []).map((g) => ({
      id: g.id,
      nameMs: g.nameMs,
      nameEn: g.nameEn,
      minSelect: g.minSelect,
      maxSelect: g.maxSelect,
      options: g.options.map((o) => ({
        id: o.id,
        labelMs: o.labelMs,
        labelEn: o.labelEn,
        priceDeltaSen: o.priceDeltaSen ?? 0,
      })),
    })),
  })),
  tables: [{ id: "tbl_h1", label: "Meja 01", qrToken: TOKEN }],
  cachedAt: Date.now(),
};

const stations = SEED_STATIONS.map((s) => ({
  id: s.id,
  name: s.name,
  target: s.target,
  enabled: 1,
  isDefault: s.isDefault ? 1 : 0,
}));
const routes = SEED_STATIONS.flatMap((s) =>
  (s.categoryIds ?? []).map((categoryId) => ({ stationId: s.id, categoryId })),
);

/* ---- the printer ------------------------------------------------- */

function sendToPrinter(bytes: Uint8Array): Promise<void> {
  const [host, port] = PRINTER.split(":");
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: host!, port: Number(port) }, () => {
      socket.write(Buffer.from(bytes), () => socket.end());
    });
    socket.on("close", () => resolve());
    socket.on("error", reject);
  });
}

/* ---- the ports the router talks to ------------------------------- */

const placed: { clientUlid: string; totalSen: number; printed: boolean }[] = [];

const ports: LocalPorts = {
  cache: () => cache,
  now: () => Date.now(),
  status: async (table) => ({
    totalSen: placed.reduce((sum, p) => sum + p.totalSen, 0),
    orders: placed.map((p) => ({
      id: p.clientUlid,
      status: "placed",
      placedAt: Date.now(),
    })),
  }),
  placeOrder: async ({ table, lines, clientUlid }) => {
    const itemsById = new Map(cache.items.map((i) => [i.id, i]));
    const totalSen = priceLines(cache.items, lines);

    const docketLines = lines.map((line) => {
      const item = itemsById.get(line.menuItemId)!;
      return {
        menuItemId: item.id,
        qty: line.qty,
        name: item.nameMs,
        modifiers: resolveModifiers(item, line.modifierOptionIds ?? []).map(
          (m) => m.label,
        ),
        notes: line.notes ?? null,
      };
    });

    const grouped = groupLinesByStation(docketLines, {
      stations,
      routes,
      categoryByItem: new Map(cache.items.map((i) => [i.id, i.categoryId])),
      menuItemIdOf: (l) => l.menuItemId,
    });

    let printed = true;
    for (const { station, lines: group } of grouped) {
      const bytes = renderKitchenTicket({
        outletName: cache.outletName,
        stationName: station.name,
        tableLabel: table.label,
        orderCode: `#${clientUlid.slice(-5).toUpperCase()}`,
        placedAt: new Date(),
        lines: group.map((l) => ({
          qty: l.qty,
          name: l.name,
          modifiers: l.modifiers,
          notes: l.notes,
        })),
      });
      try {
        await sendToPrinter(bytes);
        console.log(`  🖨️  ${station.name}: ${bytes.length} bytes`);
      } catch (err) {
        printed = false;
        console.log(`  ⚠️  ${station.name}: ${(err as Error).message}`);
      }
    }

    placed.push({ clientUlid, totalSen, printed });
    console.log(
      `  ✓ ${table.label} · RM ${(totalSen / 100).toFixed(2)} · printedLocally=${printed}`,
    );
    return { orderId: clientUlid, totalSen, duplicate: false };
  },
};

const handle = createRouter({ ports });

/* ---- the socket, which on a tablet is Java ----------------------- */

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
      const response = await handle({
        method: req.method ?? "GET",
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body: chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined,
        ip: req.socket.remoteAddress ?? "unknown",
      });

      if ("asset" in response.body) {
        try {
          const file = await readFile(path.join(MENU_DIST, response.body.asset));
          res.writeHead(200, {
            "Content-Type": TYPES[path.extname(response.body.asset)] ?? "application/octet-stream",
            "Cache-Control": "no-store",
          });
          res.end(file);
        } catch {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end('{"error":"not found"}');
        }
        return;
      }

      res.writeHead(response.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response.body.json));
    })();
  });
}).listen(PORT, "127.0.0.1", () => {
  console.log(`local-server harness on :${PORT}`);
  console.log(`  table: http://127.0.0.1:${PORT}/t/out_harness/${TOKEN}`);
  console.log(`  printer: ${PRINTER}`);
});
