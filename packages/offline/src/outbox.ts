/**
 * The durable queue of things this device did but the server has not confirmed.
 *
 * Two properties matter more than anything else here:
 *
 *  1. **An op is written before it is sent.** The order exists on disk the
 *     instant the cashier taps, so pulling the power between the tap and the
 *     request loses nothing.
 *
 *  2. **Order is preserved.** Ops are keyed by a zero-padded monotonic
 *     sequence, so `keys()` returns them in the order the cashier performed
 *     them — "serve order X" can never reach the server before "place order
 *     X", which would otherwise be a 404 and a lost ticket.
 */
import type { Op, OpBody } from "./ops";
import type { Store } from "./store";

const OP_PREFIX = "op/";
const SEQ_KEY = "meta/seq";
/** 12 digits sorts correctly to a trillion ops — a century of restaurant. */
const SEQ_WIDTH = 12;

export interface QueuedOp {
  seq: number;
  op: Op;
  attempts: number;
  lastError?: string;
}

export class Outbox {
  constructor(
    private readonly store: Store,
    private readonly deviceId: string,
    private readonly mintUlid: () => string,
  ) {}

  private key(seq: number): string {
    return `${OP_PREFIX}${String(seq).padStart(SEQ_WIDTH, "0")}`;
  }

  /** Append one op. Returns its client ULID, which is also its identity. */
  async enqueue(body: OpBody, now = Date.now()): Promise<Op> {
    const seq = ((await this.store.get<number>(SEQ_KEY)) ?? 0) + 1;
    const op: Op = {
      clientUlid: this.mintUlid(),
      deviceId: this.deviceId,
      at: now,
      body,
    };
    // The op lands before the sequence advances. A crash between the two
    // repeats a sequence number at worst, which overwrites nothing because
    // the write below would be to a key that is already occupied — so the
    // op is written first and the counter second, never the reverse.
    await this.store.put<QueuedOp>(this.key(seq), { seq, op, attempts: 0 });
    await this.store.put(SEQ_KEY, seq);
    return op;
  }

  /** The oldest `limit` ops, in the order they were performed. */
  async peek(limit = 50): Promise<QueuedOp[]> {
    const keys = (await this.store.keys(OP_PREFIX)).slice(0, limit);
    const out: QueuedOp[] = [];
    for (const key of keys) {
      const queued = await this.store.get<QueuedOp>(key);
      if (queued) out.push(queued);
    }
    return out;
  }

  async size(): Promise<number> {
    return (await this.store.keys(OP_PREFIX)).length;
  }

  /** Confirmed by the server — applied, already known, or permanently refused. */
  async settle(seqs: number[]): Promise<void> {
    for (const seq of seqs) await this.store.delete(this.key(seq));
  }

  /** A transient failure: keep it, count it, and let the caller back off. */
  async recordFailure(seq: number, error: string): Promise<void> {
    const key = this.key(seq);
    const queued = await this.store.get<QueuedOp>(key);
    if (!queued) return;
    await this.store.put<QueuedOp>(key, {
      ...queued,
      attempts: queued.attempts + 1,
      lastError: error,
    });
  }

  async all(): Promise<QueuedOp[]> {
    return this.peek(Number.MAX_SAFE_INTEGER);
  }
}
