/**
 * Per-IP rate limiting.
 *
 * Not about hostile hackers — it is about the ordinary way a shared network
 * goes wrong. A phone with a stuck retry loop, a customer holding down a
 * button, a laptop someone left scanning the subnet: any of them can turn a
 * cheap tablet into a slow one during the exact service where it is the only
 * thing keeping the restaurant trading.
 *
 * A token bucket rather than a fixed window, because a fixed window lets a
 * whole minute's allowance be spent in its first second, which is precisely
 * the burst that hurts.
 */

export interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  /**
   * @param capacity  most requests allowed back to back
   * @param perMinute how fast the allowance refills
   */
  constructor(
    private readonly capacity: number,
    private readonly perMinute: number,
  ) {}

  /** @returns true when the request may proceed. */
  take(key: string, now: number): boolean {
    const bucket = this.buckets.get(key) ?? {
      tokens: this.capacity,
      updatedAt: now,
    };

    const refill = ((now - bucket.updatedAt) / 60_000) * this.perMinute;
    const tokens = Math.min(this.capacity, bucket.tokens + Math.max(0, refill));

    if (tokens < 1) {
      // Keep the clock moving even on a refusal, so a client hammering the
      // door does not freeze its own refill and lock itself out forever.
      this.buckets.set(key, { tokens, updatedAt: now });
      return false;
    }

    this.buckets.set(key, { tokens: tokens - 1, updatedAt: now });
    return true;
  }

  /**
   * Forget idle clients.
   *
   * A restaurant sees a few hundred phones a day and the tablet runs for
   * weeks, so the map would otherwise grow all shift with entries for people
   * who finished eating hours ago.
   */
  sweep(now: number, idleMs = 10 * 60_000): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updatedAt > idleMs) this.buckets.delete(key);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}
