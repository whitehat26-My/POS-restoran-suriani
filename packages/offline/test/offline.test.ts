/**
 * The offline spine.
 *
 * The interesting cases are all failure ones: a crash between the tap and the
 * request, an op that can never succeed, a flaky line that answers halfway.
 * A POS that loses one order in a hundred is worse than no POS, because the
 * restaurant stops checking.
 */
import { describe, expect, it, vi } from "vitest";

import { Outbox } from "../src/outbox";
import { Syncer } from "../src/sync";
import { memoryStore, type Store } from "../src/store";
import type { Op, OpBody, OpResult } from "../src/ops";

let seq = 0;
const ulid = () => `ulid_${String(++seq).padStart(4, "0")}`;

function box(store: Store = memoryStore()) {
  return { store, outbox: new Outbox(store, "dev_tablet", ulid) };
}

const place = (tableId: string): OpBody => ({
  kind: "order.place",
  tableId,
  lines: [{ menuItemId: "itm_ng_kampung", qty: 1 }],
  expectedTotalSen: 800,
});

describe("outbox", () => {
  it("keeps the order the cashier worked in", async () => {
    const { outbox } = box();
    await outbox.enqueue(place("tbl_1"));
    await outbox.enqueue({ kind: "order.serve", orderId: "ord_1" });
    await outbox.enqueue({ kind: "session.close", sessionId: "ses_1" });

    const queued = await outbox.all();
    expect(queued.map((q) => q.op.body.kind)).toEqual([
      "order.place",
      "order.serve",
      "session.close",
    ]);
  });

  it("still sorts correctly past the point a naive key would break", async () => {
    // "op/10" sorts before "op/9" as a string. Zero-padding is the whole
    // reason "serve" cannot overtake "place" after the tenth order of a shift.
    const { outbox } = box();
    for (let i = 0; i < 12; i++) await outbox.enqueue(place(`tbl_${i}`));

    const queued = await outbox.all();
    expect(queued.map((q) => q.seq)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
  });

  it("survives the tablet being unplugged", async () => {
    const store = memoryStore();
    const first = box(store);
    await first.outbox.enqueue(place("tbl_5"));

    // Power cut. New process, same disk.
    const second = box(store);
    expect(await second.outbox.size()).toBe(1);

    // And it keeps counting from where it left off rather than overwriting.
    await second.outbox.enqueue(place("tbl_6"));
    expect((await second.outbox.all()).map((q) => q.seq)).toEqual([1, 2]);
  });

  it("counts failures without losing the op", async () => {
    const { outbox } = box();
    const op = await outbox.enqueue(place("tbl_1"));
    await outbox.recordFailure(1, "network");
    await outbox.recordFailure(1, "network");

    const [queued] = await outbox.all();
    expect(queued!.attempts).toBe(2);
    expect(queued!.lastError).toBe("network");
    expect(queued!.op.clientUlid).toBe(op.clientUlid);
  });
});

describe("syncer", () => {
  const allApplied = (ops: Op[]) => ({
    results: ops.map(
      (op): OpResult => ({ clientUlid: op.clientUlid, status: "applied" }),
    ),
  });

  it("drains everything and empties the outbox", async () => {
    const { outbox } = box();
    for (let i = 0; i < 3; i++) await outbox.enqueue(place(`tbl_${i}`));

    const push = vi.fn(async (ops: Op[]) => allApplied(ops));
    const report = await new Syncer(outbox, push, () => {}).drain();

    expect(report.applied).toBe(3);
    expect(report.pending).toBe(0);
    expect(await outbox.size()).toBe(0);
  });

  it("sends more than one batch, oldest first", async () => {
    const { outbox } = box();
    for (let i = 0; i < 5; i++) await outbox.enqueue(place(`tbl_${i}`));

    const seen: string[][] = [];
    const push = vi.fn(async (ops: Op[]) => {
      seen.push(ops.map((o) => (o.body as { tableId: string }).tableId));
      return allApplied(ops);
    });
    await new Syncer(outbox, push, () => {}, 2).drain();

    expect(seen).toEqual([
      ["tbl_0", "tbl_1"],
      ["tbl_2", "tbl_3"],
      ["tbl_4"],
    ]);
  });

  it("loses nothing when the line dies mid-drain", async () => {
    const { outbox } = box();
    for (let i = 0; i < 4; i++) await outbox.enqueue(place(`tbl_${i}`));

    let call = 0;
    const push = vi.fn(async (ops: Op[]) => {
      if (++call === 2) throw new Error("fetch failed");
      return allApplied(ops);
    });
    const states: string[] = [];
    const syncer = new Syncer(outbox, push, (s) => states.push(s), 2);

    const report = await syncer.drain();
    syncer.stop();

    expect(report.applied).toBe(2);
    // The two that never got an answer are still on disk, and the till knows.
    expect(await outbox.size()).toBe(2);
    expect(states).toContain("offline");
    expect((await outbox.all())[0]!.attempts).toBe(1);
  });

  it("drops an op the server will never accept, and keeps going", async () => {
    const { outbox } = box();
    await outbox.enqueue(place("tbl_gone"));
    await outbox.enqueue(place("tbl_ok"));

    const push = async (ops: Op[]) => ({
      results: ops.map(
        (op, i): OpResult =>
          i === 0
            ? { clientUlid: op.clientUlid, status: "rejected", error: "unknown_table" }
            : { clientUlid: op.clientUlid, status: "applied" },
      ),
    });

    const report = await new Syncer(outbox, push, () => {}).drain();

    // Retrying an impossible op forever would wedge every order behind it.
    expect(report.rejected.map((r) => r.error)).toEqual(["unknown_table"]);
    expect(report.applied).toBe(1);
    expect(await outbox.size()).toBe(0);
  });

  it("counts a replay as a duplicate rather than a second sale", async () => {
    const { outbox } = box();
    await outbox.enqueue(place("tbl_1"));

    const push = async (ops: Op[]) => ({
      results: ops.map(
        (op): OpResult => ({ clientUlid: op.clientUlid, status: "duplicate" }),
      ),
    });
    const report = await new Syncer(outbox, push, () => {}).drain();

    expect(report.duplicates).toBe(1);
    expect(report.applied).toBe(0);
    expect(await outbox.size()).toBe(0);
  });

  it("collapses overlapping drains into one", async () => {
    const { outbox } = box();
    await outbox.enqueue(place("tbl_1"));

    let inFlight = 0;
    let overlapped = false;
    const push = async (ops: Op[]) => {
      if (++inFlight > 1) overlapped = true;
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
      return allApplied(ops);
    };

    const syncer = new Syncer(outbox, push, () => {});
    // online + visibilitychange + a manual retry, all within a second.
    await Promise.all([syncer.drain(), syncer.drain(), syncer.drain()]);
    syncer.stop();

    expect(overlapped).toBe(false);
    expect(await outbox.size()).toBe(0);
  });

  it("does not spin when the server answers but settles nothing", async () => {
    const { outbox } = box();
    await outbox.enqueue(place("tbl_1"));

    const push = vi.fn(async () => ({ results: [] as OpResult[] }));
    const syncer = new Syncer(outbox, push, () => {});
    await syncer.drain();
    syncer.stop();

    expect(push).toHaveBeenCalledTimes(1);
    expect(await outbox.size()).toBe(1);
  });
});
