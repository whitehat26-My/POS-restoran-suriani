/**
 * The drain loop.
 *
 * Deliberately dumb: send the oldest ops, apply what the server says happened,
 * back off when it cannot be reached. All the judgement lives on the server,
 * which is single-threaded and therefore the only place that can decide an
 * order without racing itself.
 */
import type { Op, OpResult } from "./ops";
import type { Outbox } from "./outbox";

export type SyncState = "idle" | "syncing" | "offline";

export interface SyncReport {
  applied: number;
  duplicates: number;
  rejected: OpResult[];
  pending: number;
}

/** How a batch reaches the server. Injected so tests need no network. */
export type PushOps = (ops: Op[]) => Promise<{ results: OpResult[] }>;

const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000];

export class Syncer {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private failures = 0;
  private stopped = false;

  constructor(
    private readonly outbox: Outbox,
    private readonly push: PushOps,
    private readonly onChange: (state: SyncState, report: SyncReport) => void,
    private readonly batchSize = 25,
  ) {}

  /**
   * Drain until the outbox is empty or the server stops answering.
   *
   * Concurrent calls collapse into one: the browser fires `online` and a
   * visibility change and a manual retry within the same second, and three
   * overlapping drains would send the same op three times. The server
   * deduplicates, but doing it here keeps a flaky café wifi from tripling
   * every request.
   */
  async drain(): Promise<SyncReport> {
    if (this.running) return this.report(0, 0, []);
    this.running = true;
    let applied = 0;
    let duplicates = 0;
    const rejected: OpResult[] = [];

    try {
      for (;;) {
        const batch = await this.outbox.peek(this.batchSize);
        if (batch.length === 0) break;

        this.onChange("syncing", await this.report(applied, duplicates, rejected));

        let results: OpResult[];
        try {
          ({ results } = await this.push(batch.map((q) => q.op)));
        } catch (err) {
          // The line is down, or the server is. Keep everything, count it,
          // and try again later — never drop an op on a transport failure.
          for (const q of batch) {
            await this.outbox.recordFailure(q.seq, (err as Error).message);
          }
          this.failures += 1;
          this.onChange("offline", await this.report(applied, duplicates, rejected));
          this.schedule();
          return this.report(applied, duplicates, rejected);
        }

        const bySeq = new Map(batch.map((q) => [q.op.clientUlid, q.seq]));
        const settled: number[] = [];
        for (const result of results) {
          const seq = bySeq.get(result.clientUlid);
          if (seq === undefined) continue;
          settled.push(seq);
          if (result.status === "applied") applied += 1;
          else if (result.status === "duplicate") duplicates += 1;
          else rejected.push(result);
        }
        await this.outbox.settle(settled);

        // A server that answers without settling anything would spin this
        // loop forever on the same batch.
        if (settled.length === 0) break;
      }

      this.failures = 0;
      const report = await this.report(applied, duplicates, rejected);
      this.onChange("idle", report);
      return report;
    } finally {
      this.running = false;
    }
  }

  /** Retry later, with the usual backoff. */
  private schedule(): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    const wait = BACKOFF_MS[Math.min(this.failures - 1, BACKOFF_MS.length - 1)] ?? 30_000;
    this.timer = setTimeout(() => void this.drain(), wait);
  }

  /** The line came back — go now rather than waiting out the backoff. */
  nudge(): void {
    this.failures = 0;
    clearTimeout(this.timer);
    void this.drain();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private async report(
    applied: number,
    duplicates: number,
    rejected: OpResult[],
  ): Promise<SyncReport> {
    return { applied, duplicates, rejected, pending: await this.outbox.size() };
  }
}
