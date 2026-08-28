/**
 * What the till can do while the line is down.
 *
 * Every one of these is a *fact that already happened* in the restaurant, not
 * a request to be granted later: the food was ordered, the plate was carried
 * out, the bill was settled. That is what makes replay safe — two devices can
 * never disagree about whether a thing happened, only about the order it
 * happened in, and the outlet's Durable Object is single-threaded so it
 * settles the order for everyone.
 *
 * The one exception is `item.availability`, which is state rather than a fact.
 * It is last-write-wins and the server is authoritative, which is the entire
 * conflict model.
 */
import type { Sen } from "@suriani/core/money";

export interface OrderLineOp {
  menuItemId: string;
  qty: number;
  notes?: string;
  /** Ids only. A price that arrives from a device is a price someone chose. */
  modifierOptionIds?: string[];
}

export type OpBody =
  | {
      kind: "order.place";
      tableId: string;
      lines: OrderLineOp[];
      /**
       * What the till showed the customer.
       *
       * NOT used for billing — the server prices from its own tables, as it
       * always has. It is sent so that a divergence (the owner edited a price
       * during the outage) is recorded rather than discovered in the accounts
       * a month later.
       */
      expectedTotalSen: Sen;
    }
  | { kind: "order.serve"; orderId: string }
  | { kind: "session.close"; sessionId: string }
  | { kind: "item.availability"; itemId: string; available: boolean };

/** One entry in the device's append-only log. */
export interface Op {
  /** Minted on the device before the first attempt, reused on every retry. */
  clientUlid: string;
  /** Which tablet wrote it — two tills in one shop must not interleave badly. */
  deviceId: string;
  /** The device's own clock. Kept for the record; never trusted for pricing. */
  at: number;
  body: OpBody;
}

/** What the server says happened to each op it was handed. */
export interface OpResult {
  clientUlid: string;
  /**
   * applied   — it landed now
   * duplicate — it had already landed; replaying changed nothing
   * rejected  — it can never land (unknown table, deleted dish). Dropped from
   *             the outbox and surfaced, because retrying forever would wedge
   *             every op queued behind it.
   */
  status: "applied" | "duplicate" | "rejected";
  error?: string;
  orderId?: string;
}
