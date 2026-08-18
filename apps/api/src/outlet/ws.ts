/**
 * Realtime events an outlet broadcasts to its connected tills.
 *
 * The Durable Object that owns the data does the broadcasting, so the write
 * and the announcement are one operation — there is no separate pub/sub layer
 * to drift out of sync with the database.
 *
 * Protocol: every connection receives a full `snapshot` immediately on
 * connect, then deltas. A till that reconnects always starts from truth and
 * never has to reconcile.
 */
import type { Sen } from "../lib/money";

export interface FloorTable {
  id: string;
  label: string;
  zoneId: string | null;
  capacity: number | null;
  sortOrder: number;
  /** empty | ordering | eating | bill_requested */
  status: string;
  session: {
    id: string;
    openedAt: number;
    status: string;
    totalSen: Sen;
    orderCount: number;
  } | null;
}

export interface FloorZone {
  id: string;
  nameMs: string;
  nameEn: string;
  sortOrder: number;
}

export interface TicketLine {
  qty: number;
  nameMs: string;
  nameEn: string;
  modifiers: { label: string; priceDeltaSen: Sen }[];
  notes: string | null;
}

export type OutletEvent =
  | {
      type: "snapshot";
      zones: FloorZone[];
      tables: FloorTable[];
      menuVersion: number;
    }
  | {
      type: "order.placed";
      orderId: string;
      tableId: string;
      tableLabel: string;
      sessionId: string;
      placedAt: number;
      source: string;
      totalSen: Sen;
      lines: TicketLine[];
    }
  | { type: "order.served"; orderId: string; tableId: string }
  | { type: "bill.requested"; tableId: string; sessionId: string; totalSen: Sen }
  | { type: "waiter.called"; tableId: string; tableLabel: string }
  | { type: "session.closed"; tableId: string; sessionId: string }
  | {
      type: "item.availability";
      itemId: string;
      available: boolean;
      menuVersion: number;
    }
  | { type: "print.queued"; orderId: string | null }
  | { type: "print.printed"; jobId: string; orderId: string | null }
  | {
      type: "print.failed";
      jobId: string;
      orderId: string | null;
      tableLabel: string;
      error: string;
    };

/** Send to every connected till; a dead socket must never break a write. */
export function broadcast(ctx: DurableObjectState, event: OutletEvent): void {
  const payload = JSON.stringify(event);
  for (const ws of ctx.getWebSockets()) {
    try {
      ws.send(payload);
    } catch {
      /* closing sockets are the runtime's problem, not the order's */
    }
  }
}
