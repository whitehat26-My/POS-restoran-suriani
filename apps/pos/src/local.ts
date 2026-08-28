/**
 * The tablet as a web server.
 *
 * When the restaurant's internet dies the till keeps trading, but a customer
 * at a table has nothing to scan: the QR on the card points at the cloud.
 * This closes that gap. The tablet serves the same customer app over the
 * shop's own WiFi, from inside the APK, and the order it takes lands in the
 * same outbox a counter order does — one store, one sync path, no second
 * implementation of ordering to keep correct.
 *
 * Two things are cached durably for it, because during an outage they are the
 * only truth the tablet has and a WebView that gets recycled must come back
 * knowing them: the outlet's menu and tables, and its print stations.
 *
 * The route table itself is in `@suriani/localserver`, deliberately separate
 * from anything that can read a sale.
 */
import { idbStore, memoryStore, type Store } from "@suriani/offline";
import {
  createRouter,
  priceLines,
  resolveModifiers,
  type LocalOrderLine,
  type LocalPorts,
  type LocalRequest,
  type LocalResponse,
  type OutletCache,
} from "@suriani/localserver";

import { api, type Outlet } from "./api";
import { printOrderDockets, type PrintedDockets } from "./print";
import type { OfflineTill } from "./offline";

const CACHE_KEY = "outlet/cache";
const STATIONS_KEY = "outlet/stations";
const ORDERS_KEY = "outlet/local-orders";

export interface CachedStations {
  stations: {
    id: string;
    name: string;
    target: string;
    enabled: number;
    isDefault: number;
  }[];
  routes: { stationId: string; categoryId: string }[];
}

/**
 * An order this tablet took and has not yet seen the server confirm.
 *
 * Kept so the customer's status card and the cashier's feed can both show it
 * while the line is down. Dropped once the op leaves the outbox, because from
 * then on the server's own ticket is the truth.
 */
export interface LocalOrderRecord {
  clientUlid: string;
  tableId: string;
  tableLabel: string;
  placedAt: number;
  totalSen: number;
  printed: boolean;
  lines: { qty: number; name: string; modifiers: string[]; notes: string | null }[];
}

function store(outletId: string): Store {
  try {
    if (typeof indexedDB !== "undefined") return idbStore(`suriani-${outletId}`);
  } catch {
    /* fall through */
  }
  return memoryStore();
}

export interface LocalServer {
  /** Answer one request from a phone on the shop WiFi. */
  handle(req: LocalRequest): Promise<LocalResponse>;
  /** Pull a fresh snapshot. Safe to call often; silent when the line is down. */
  refresh(): Promise<boolean>;
  cache(): OutletCache | null;
  /** The print stations, as last seen. The till prints its own dockets too. */
  stations(): CachedStations;
  /** Orders taken here that the server has not confirmed yet. */
  pending(): LocalOrderRecord[];
  stop(): void;
}

export function openLocalServer(
  outlet: Outlet,
  till: OfflineTill,
  /** Called whenever the unconfirmed set changes — a new order, or one that synced. */
  onRecords?: (records: LocalOrderRecord[], added?: LocalOrderRecord) => void,
): LocalServer {
  const kv = store(outlet.id);

  let cache: OutletCache | null = null;
  let stations: CachedStations = { stations: [], routes: [] };
  let records: LocalOrderRecord[] = [];
  let stopped = false;

  // Load whatever the last shift left behind, before the first request.
  void (async () => {
    cache = (await kv.get<OutletCache>(CACHE_KEY)) ?? null;
    stations = (await kv.get<CachedStations>(STATIONS_KEY)) ?? stations;
    records = (await kv.get<LocalOrderRecord[]>(ORDERS_KEY)) ?? [];
    if (records.length > 0) onRecords?.(records);
  })();

  const saveRecords = async () => {
    // A day's worth is plenty; anything older has long since synced.
    records = records.slice(-200);
    await kv.put(ORDERS_KEY, records);
  };

  const ports: LocalPorts = {
    cache: () => cache,
    now: () => Date.now(),

    async status(table) {
      const mine = records.filter((r) => r.tableId === table.id);
      return {
        totalSen: mine.reduce((sum, r) => sum + r.totalSen, 0),
        orders: mine.map((r) => ({
          id: r.clientUlid,
          // This tablet knows the order was taken. Whether it has been carried
          // out is the till's business and does not survive the outage, so
          // claiming anything more would be inventing it.
          status: "placed",
          placedAt: r.placedAt,
        })),
      };
    },

    async placeOrder({ table, lines, clientUlid }) {
      const snapshot = cache;
      if (!snapshot) throw new Error("no cache");

      const itemsById = new Map(snapshot.items.map((i) => [i.id, i]));
      const totalSen = priceLines(snapshot.items, lines);

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

      // Print BEFORE the op is written, on purpose.
      //
      // The reverse order has a worse failure: a power cut between the write
      // and the print leaves the kitchen blind with nothing to show for it,
      // and a docket that never appears is exactly the failure this project
      // refuses to let be quiet. This way the worst case is a slip on the
      // spike for an order the system does not have — visible, and something
      // a cashier can key in.
      const printed: PrintedDockets = await printOrderDockets({
        outletName: snapshot.outletName,
        tableLabel: table.label,
        orderCode: `#${clientUlid.slice(-5).toUpperCase()}`,
        placedAt: new Date(),
        lines: docketLines,
        stations,
        categoryByItem: new Map(snapshot.items.map((i) => [i.id, i.categoryId])),
      });

      const op = await till.perform({
        kind: "order.place",
        tableId: table.id,
        lines: lines as LocalOrderLine[],
        expectedTotalSen: totalSen,
        // Only when paper actually came out. A failed printer falls back to
        // the server's queue, with its retries and its red banner.
        printedLocally: printed.ok,
      });

      const record: LocalOrderRecord = {
        clientUlid: op.clientUlid,
        tableId: table.id,
        tableLabel: table.label,
        placedAt: op.at,
        totalSen,
        printed: printed.ok,
        lines: docketLines.map(({ qty, name, modifiers, notes }) => ({
          qty,
          name,
          modifiers,
          notes,
        })),
      };
      records.push(record);
      await saveRecords();
      onRecords?.(records, record);

      return { orderId: op.clientUlid, totalSen, duplicate: false };
    },
  };

  const handle = createRouter({ ports });

  const refresh = async (): Promise<boolean> => {
    try {
      const [menu, tables, printers] = await Promise.all([
        api.menu(outlet.id),
        api.tables(outlet.id),
        api.stations(outlet.id),
      ]);

      const next: OutletCache = {
        outletId: outlet.id,
        outletName: outlet.name,
        // Bumped locally so a phone holding a cached menu refetches after a
        // sync, without needing the server's own counter.
        menuVersion: (cache?.menuVersion ?? 0) + 1,
        categories: menu.categories,
        items: menu.items as OutletCache["items"],
        tables: tables.tables.map((t) => ({
          id: t.id,
          label: t.label,
          qrToken: t.qrToken,
        })),
        cachedAt: Date.now(),
      };

      cache = next;
      stations = { stations: printers.stations, routes: printers.routes };
      await kv.put(CACHE_KEY, next);
      await kv.put(STATIONS_KEY, stations);
      return true;
    } catch {
      // The line is down, which is the hour this whole file exists for. The
      // last snapshot stays exactly as it was.
      return false;
    }
  };

  // Drop records the server has confirmed: from then on its ticket is truth.
  const prune = async () => {
    if (records.length === 0) return;
    const queued = new Set(await till.queuedUlids());
    const kept = records.filter((r) => queued.has(r.clientUlid));
    if (kept.length !== records.length) {
      records = kept;
      await saveRecords();
      onRecords?.(records);
    }
  };

  void refresh();
  const timer = window.setInterval(() => {
    if (stopped) return;
    void refresh();
    void prune();
  }, 60_000);

  return {
    handle,
    refresh,
    cache: () => cache,
    stations: () => stations,
    pending: () => records,
    stop() {
      stopped = true;
      window.clearInterval(timer);
    },
  };
}
