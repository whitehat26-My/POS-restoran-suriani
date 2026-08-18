/**
 * The cart lives on the phone.
 *
 * Persisted to localStorage keyed by the table token, so a customer who loses
 * signal, locks their phone, or reloads keeps what they picked. The pending
 * order ULID is persisted with it: minted before the first submit attempt and
 * reused on every retry, so a flaky tap can never place two orders.
 */
import { ulid } from "@suriani/core/ids";
import { lineTotalSen, type Modifier } from "@suriani/core/money";
import type { MenuItem } from "./api";

export interface CartLine {
  lineId: string;
  menuItemId: string;
  qty: number;
  optionIds: string[];
  notes?: string;
}

export interface CartState {
  lines: CartLine[];
  /** Reused across retries; cleared only on a successful submit. */
  pendingUlid: string | null;
}

const key = (qrToken: string) => `suriani_cart_${qrToken}`;
const ordersKey = (qrToken: string) => `suriani_orders_${qrToken}`;

export function loadCart(qrToken: string): CartState {
  try {
    const raw = localStorage.getItem(key(qrToken));
    if (raw) return JSON.parse(raw) as CartState;
  } catch {
    /* corrupted storage is an empty cart, not a crash */
  }
  return { lines: [], pendingUlid: null };
}

export function saveCart(qrToken: string, cart: CartState) {
  localStorage.setItem(key(qrToken), JSON.stringify(cart));
}

export function clearCart(qrToken: string) {
  localStorage.removeItem(key(qrToken));
}

/** Mint once, then reuse until the order actually lands. */
export function ensurePendingUlid(cart: CartState): string {
  return cart.pendingUlid ?? ulid();
}

export function newLine(
  item: MenuItem,
  qty: number,
  optionIds: string[],
  notes?: string,
): CartLine {
  return { lineId: ulid(), menuItemId: item.id, qty, optionIds, notes };
}

/** Display-only maths. The server prices the real bill from its own data. */
export function cartTotalSen(lines: CartLine[], items: MenuItem[]): number {
  const byId = new Map(items.map((i) => [i.id, i]));
  let total = 0;
  for (const line of lines) {
    const item = byId.get(line.menuItemId);
    if (!item) continue;
    const modifiers: Modifier[] = line.optionIds.flatMap((oid) => {
      for (const g of item.modifierGroups) {
        const o = g.options.find((x) => x.id === oid);
        if (o) return [{ label: o.labelMs, priceDeltaSen: o.priceDeltaSen }];
      }
      return [];
    });
    total += lineTotalSen(item.priceSen, line.qty, modifiers);
  }
  return total;
}

export interface PlacedSummary {
  orderId: string;
  totalSen: number;
  at: number;
  etaMin: number;
  lines: { name: string; qty: number; sen: number }[];
}

export function loadPlaced(qrToken: string): PlacedSummary[] {
  try {
    const raw = localStorage.getItem(ordersKey(qrToken));
    if (raw) return JSON.parse(raw) as PlacedSummary[];
  } catch {
    /* ignore */
  }
  return [];
}

export function appendPlaced(qrToken: string, order: PlacedSummary) {
  const all = [...loadPlaced(qrToken), order];
  localStorage.setItem(ordersKey(qrToken), JSON.stringify(all));
  return all;
}
