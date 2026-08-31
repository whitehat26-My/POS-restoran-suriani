/**
 * The tablet's public route table.
 *
 * This is a **separate router from the POS API, not the same one with a flag**,
 * and that distinction is the whole security design. There is no staff route
 * here to accidentally leave enabled, no sales figure to accidentally return,
 * no login to accidentally expose — not because they are guarded, but because
 * they are not written. A reader can audit everything this server can do by
 * reading one file, which is the only kind of audit that stays true.
 *
 * Four things exist:
 *
 *   GET  /                              the app shell (shows "table not found")
 *   GET  /t/:outletId/:token            the app shell
 *   GET  /assets/<file>, /sw.js         the app's own files
 *   GET  /api/t/:outletId/:token        this table, and the menu
 *   POST /api/t/:outletId/:token/orders place an order
 *   GET  /api/t/:outletId/:token/status what this tablet knows about the table
 *
 * Bill requests and waiter calls are deliberately absent. They ring a bell on
 * the till, and a bell that can be rung by anyone on the guest WiFi is a bell
 * that gets rung. During an outage the customer is told to ask at the counter
 * instead — which is what they would do anyway, and it is one fewer thing
 * reachable from a shared network.
 */
import { lineTotalSen, type Sen } from "@suriani/core/money";

import { RateLimiter } from "./limit";
import type {
  CachedItem,
  CachedTable,
  LocalOrderLine,
  LocalPorts,
  LocalRequest,
  LocalResponse,
  OutletCache,
} from "./types";

const SHELL = "index.html";

/** Only these characters can appear in a built asset's name. */
const ASSET = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const json = (status: number, value: unknown): LocalResponse => ({
  status,
  body: { json: value },
});

const notFound = () => json(404, { error: "not found" });

export interface RouterOptions {
  ports: LocalPorts;
  /** Reads: generous. A phone polls status every twelve seconds. */
  readLimit?: RateLimiter;
  /** Writes: tight. Nobody legitimately places six orders in a minute. */
  writeLimit?: RateLimiter;
}

export function createRouter(opts: RouterOptions) {
  const { ports } = opts;
  const reads = opts.readLimit ?? new RateLimiter(60, 120);
  const writes = opts.writeLimit ?? new RateLimiter(6, 12);

  return async function handle(req: LocalRequest): Promise<LocalResponse> {
    const now = ports.now();
    const segments = req.path.split("/").filter(Boolean);

    /* ---- the app's own files ------------------------------------- */
    if (req.method === "GET") {
      if (segments.length === 0) return { status: 200, body: { asset: SHELL } };
      if (segments[0] === "sw.js" && segments.length === 1) {
        return { status: 200, body: { asset: "sw.js" } };
      }
      if (segments[0] === "assets" && segments.length === 2) {
        // Anchored, single-segment and character-restricted: "..", a
        // backslash, an encoded slash or a nested path all fail to match, so
        // no request can walk out of the assets directory.
        return ASSET.test(segments[1]!)
          ? { status: 200, body: { asset: `assets/${segments[1]}` } }
          : notFound();
      }
      if (segments[0] === "t" && segments.length === 3) {
        // The shell is served whatever the token is. It fetches the table
        // itself and shows "meja tidak dijumpai" when the token is wrong,
        // which keeps a bad token from being distinguishable here.
        return { status: 200, body: { asset: SHELL } };
      }
    }

    /* ---- the data routes ----------------------------------------- */
    if (segments[0] !== "api" || segments[1] !== "t") return notFound();

    const [, , outletId, token, tail, ...extra] = segments;
    if (!outletId || !token || extra.length > 0) return notFound();

    const limiter = req.method === "POST" ? writes : reads;
    if (!limiter.take(req.ip, now)) {
      return { status: 429, body: { json: { error: "too many requests" } } };
    }

    const cache = ports.cache();
    if (!cache) {
      // The tablet has never been online, so it has no menu to serve. Not a
      // 404: the customer is at a real table and telling them the table does
      // not exist would send them looking for staff to fix the wrong thing.
      return json(503, { error: "not ready" });
    }

    const table = resolve(cache, outletId, token);
    // One answer for an unknown outlet and an unknown token alike, so this
    // server cannot be used to discover which outlet ids are real.
    if (!table) return notFound();

    if (req.method === "GET" && tail === undefined) {
      return json(200, tablePage(cache, table));
    }
    if (req.method === "GET" && tail === "status") {
      const status = await ports.status(table);
      return json(200, {
        menuVersion: cache.menuVersion,
        local: true,
        table: { label: table.label, status: "ordering" },
        session:
          status.orders.length > 0
            ? {
                status: "open",
                totalSen: status.totalSen,
                orders: status.orders,
              }
            : null,
      });
    }
    if (req.method === "POST" && tail === "orders") {
      return placeOrder(req, cache, table, ports);
    }

    return notFound();
  };
}

function resolve(
  cache: OutletCache,
  outletId: string,
  token: string,
): CachedTable | null {
  if (outletId !== cache.outletId) return null;
  return cache.tables.find((t) => t.qrToken === token) ?? null;
}

function tablePage(cache: OutletCache, table: CachedTable) {
  return {
    outlet: { name: cache.outletName },
    table: { label: table.label },
    menu: { categories: cache.categories, items: cache.items },
    /**
     * The customer app reads this and hides the two buttons this server does
     * not carry, and says why. Better than letting a customer press "Minta
     * Bil" and watch nothing happen during the one hour when nothing must
     * feel broken.
     */
    local: true,
    cachedAt: cache.cachedAt,
  };
}

async function placeOrder(
  req: LocalRequest,
  cache: OutletCache,
  table: CachedTable,
  ports: LocalPorts,
): Promise<LocalResponse> {
  let parsed: { lines?: unknown; clientUlid?: unknown };
  try {
    parsed = JSON.parse(req.body ?? "") as typeof parsed;
  } catch {
    return json(400, { error: "bad_body" });
  }

  if (!Array.isArray(parsed.lines) || parsed.lines.length === 0) {
    return json(400, { error: "empty_order" });
  }
  if (parsed.lines.length > 40) {
    return json(400, { error: "too_many_lines" });
  }
  if (typeof parsed.clientUlid !== "string" || parsed.clientUlid.length < 8) {
    // The phone mints this before its first attempt and reuses it on retry.
    // Without it a flaky tap becomes two plates of chicken.
    return json(400, { error: "missing_client_ulid" });
  }

  const itemsById = new Map(cache.items.map((i) => [i.id, i]));
  const lines: LocalOrderLine[] = [];

  for (const raw of parsed.lines as LocalOrderLine[]) {
    const item = itemsById.get(String(raw?.menuItemId));
    if (!item) return json(400, { error: "unknown_item" });
    if (item.isAvailable === 0) return json(400, { error: "unavailable" });

    const qty = Number(raw.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 20) {
      return json(400, { error: "bad_qty" });
    }

    const optionIds = Array.isArray(raw.modifierOptionIds)
      ? raw.modifierOptionIds.map(String)
      : [];
    const bad = validateOptions(item, optionIds);
    if (bad) return json(400, { error: bad });

    lines.push({
      menuItemId: item.id,
      qty,
      notes: typeof raw.notes === "string" ? raw.notes.slice(0, 120) : undefined,
      modifierOptionIds: optionIds,
    });
  }

  const placed = await ports.placeOrder({
    table,
    lines,
    clientUlid: parsed.clientUlid,
  });
  return json(placed.duplicate ? 200 : 201, placed);
}

/**
 * The option rules, enforced here as well as on the server.
 *
 * Not belt and braces — during an outage this is the *only* enforcement there
 * is, and it stays the only one for as long as the line is down. A drink that
 * reaches the kitchen without panas-or-ais answered is a drink someone has to
 * walk back and ask about.
 */
function validateOptions(item: CachedItem, optionIds: string[]): string | null {
  const seen = new Set(optionIds);
  if (seen.size !== optionIds.length) return "duplicate_option";

  const ownGroups = new Map(item.modifierGroups.map((g) => [g.id, g]));
  const groupOfOption = new Map<string, string>();
  for (const group of item.modifierGroups) {
    for (const option of group.options) groupOfOption.set(option.id, group.id);
  }

  const chosenPerGroup = new Map<string, number>();
  for (const id of optionIds) {
    const groupId = groupOfOption.get(id);
    // An option belonging to a different dish is the forged-price attempt in
    // its other shape: pick the cheap dish, send the expensive dish's option.
    if (!groupId) return "unknown_option";
    chosenPerGroup.set(groupId, (chosenPerGroup.get(groupId) ?? 0) + 1);
  }

  for (const [groupId, group] of ownGroups) {
    const count = chosenPerGroup.get(groupId) ?? 0;
    if (count < group.minSelect) return "option_required";
    if (count > group.maxSelect) return "too_many_options";
  }
  return null;
}

/**
 * What the order costs, priced from the tablet's own cache.
 *
 * A price never arrives from a phone — the request carries option ids and
 * nothing else, exactly as the cloud API requires. This is the same rule the
 * Worker enforces, applied by the machine that happens to be answering.
 *
 * The number is for what the customer is shown and what the docket says. The
 * *bill* is priced by the server when the op syncs, and a divergence between
 * the two is recorded rather than quietly accepted.
 */
export function priceLines(
  items: readonly CachedItem[],
  lines: readonly LocalOrderLine[],
): Sen {
  const byId = new Map(items.map((i) => [i.id, i]));
  let total = 0;
  for (const line of lines) {
    const item = byId.get(line.menuItemId);
    if (!item) continue;
    const modifiers = resolveModifiers(item, line.modifierOptionIds ?? []);
    total += lineTotalSen(item.priceSen, line.qty, modifiers);
  }
  return total;
}

/** Option ids → the labels and deltas the tablet holds for them. */
export function resolveModifiers(
  item: CachedItem,
  optionIds: readonly string[],
): { label: string; priceDeltaSen: Sen }[] {
  const resolved: { label: string; priceDeltaSen: Sen }[] = [];
  for (const group of item.modifierGroups) {
    for (const option of group.options) {
      if (optionIds.includes(option.id)) {
        resolved.push({
          label: option.labelMs,
          priceDeltaSen: option.priceDeltaSen,
        });
      }
    }
  }
  return resolved;
}
