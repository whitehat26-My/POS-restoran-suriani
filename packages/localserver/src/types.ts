/**
 * What the tablet's own web server is, and what it deliberately is not.
 *
 * When the restaurant's internet dies, the till keeps trading — but a customer
 * at a table has nothing to scan, because the QR on the card points at the
 * cloud. This server closes that: the tablet serves the same customer app
 * over the shop's WiFi, from inside the APK, backed by the same local store
 * the till uses. The order lands in the same op log as a counter order and
 * syncs when the line returns, so there is no second path to keep correct.
 *
 * It is **always on, never outage-triggered**. There is no mode to detect and
 * no switchover to fail at the worst possible moment; there are simply two
 * doors and both are always open.
 *
 * The uncomfortable part, stated plainly: this listens on a network that
 * customers share. A tablet cannot hold a TLS certificate phones will trust
 * for a private address, so the local path is plain HTTP and phones will say
 * "Not secure". That is survivable because of what is on the other side of
 * the socket — and what is on the other side is the whole point of this file.
 */
import type { Sen } from "@suriani/core/money";

export interface LocalRequest {
  method: string;
  /** Path only; the query string is parsed separately. */
  path: string;
  query: Record<string, string>;
  body?: string;
  /** The peer address, for rate limiting. */
  ip: string;
}

export interface LocalResponse {
  status: number;
  /** JSON body, or a marker telling the socket layer to serve a file. */
  body: { json: unknown } | { asset: string };
  headers?: Record<string, string>;
}

export interface CachedOption {
  id: string;
  labelMs: string;
  labelEn: string;
  priceDeltaSen: Sen;
}

export interface CachedGroup {
  id: string;
  nameMs: string;
  nameEn: string;
  minSelect: number;
  maxSelect: number;
  options: CachedOption[];
}

export interface CachedItem {
  id: string;
  categoryId: string;
  nameMs: string;
  nameEn: string;
  descMs: string | null;
  descEn: string | null;
  priceSen: Sen;
  tags: string[];
  isAvailable: number;
  prepMinutes: number;
  modifierGroups: CachedGroup[];
}

export interface CachedCategory {
  id: string;
  nameMs: string;
  nameEn: string;
  sortOrder: number;
}

export interface CachedTable {
  id: string;
  label: string;
  qrToken: string;
}

/**
 * The outlet as the tablet last saw it.
 *
 * Refreshed whenever the line is up. During an outage it is the only truth
 * the local server has, which is why it is cached durably rather than held in
 * a React state that dies with the WebView.
 */
export interface OutletCache {
  outletId: string;
  outletName: string;
  menuVersion: number;
  categories: CachedCategory[];
  items: CachedItem[];
  tables: CachedTable[];
  /** When this snapshot was taken, so the customer can be told it is old. */
  cachedAt: number;
}

/** One line as the customer's phone sends it. Ids only — never prices. */
export interface LocalOrderLine {
  menuItemId: string;
  qty: number;
  notes?: string;
  modifierOptionIds?: string[];
}

export interface PlacedLocally {
  orderId: string;
  totalSen: Sen;
  duplicate: boolean;
}

/**
 * What the router needs from the tablet around it.
 *
 * A port rather than a direct dependency so the whole route table can be
 * driven by a fake in tests — including the paths that must be refused, which
 * are the ones worth being sure about.
 */
export interface LocalPorts {
  /** The outlet snapshot, or null when the tablet has never been online. */
  cache(): OutletCache | null;
  /**
   * Record an order. Writes to the same outbox a counter order uses, prints
   * the docket, and returns what the customer should see.
   */
  placeOrder(input: {
    table: CachedTable;
    lines: LocalOrderLine[];
    clientUlid: string;
  }): Promise<PlacedLocally>;
  /** What this tablet knows about a table's orders. */
  status(table: CachedTable): Promise<{
    totalSen: Sen;
    orders: { id: string; status: string; placedAt: number }[];
  }>;
  now(): number;
}
