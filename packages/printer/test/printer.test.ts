/**
 * Dual-transport printing.
 *
 * The gate for this phase is a router unplugged mid-service with the kitchen
 * still printing, so the tests that matter are the ones where the LAN is gone:
 * dead, hanging, or answering and then failing.
 */
import { describe, expect, it, vi } from "vitest";

import { runOnce, type AckBody, type PrintJob } from "../src/agent";
import {
  AllTransportsFailed,
  printVia,
  type Transport,
} from "../src/transport";

const bytes = new Uint8Array([0x1b, 0x40, 0x41]);

const working = (name: string): Transport => ({
  name,
  send: vi.fn(async () => {}),
});
const broken = (name: string, why = "ECONNREFUSED"): Transport => ({
  name,
  send: vi.fn(async () => {
    throw new Error(why);
  }),
});
/** A socket the OS has not given up on yet — the nasty one. */
const hanging = (name: string): Transport => ({
  name,
  send: () => new Promise(() => {}),
});

describe("choosing a transport", () => {
  it("uses the LAN when the LAN is there", async () => {
    const lan = working("lan");
    const bluetooth = working("bluetooth");

    const result = await printVia([lan, bluetooth], bytes);

    expect(result.transport).toBe("lan");
    expect(bluetooth.send).not.toHaveBeenCalled();
  });

  it("falls back to Bluetooth when the router is dead", async () => {
    const lan = broken("lan", "EHOSTUNREACH");
    const bluetooth = working("bluetooth");

    const result = await printVia([lan, bluetooth], bytes);

    expect(result.transport).toBe("bluetooth");
    expect(bluetooth.send).toHaveBeenCalledWith(bytes);
    expect(result.attempts).toEqual([
      { transport: "lan", error: "EHOSTUNREACH" },
    ]);
  });

  it("does not wait for a hung socket before trying Bluetooth", async () => {
    // A printer that has quietly gone away does not refuse the connection;
    // it accepts nothing and the socket sits there. Waiting for the OS to
    // give up means the kitchen stands idle through the whole emergency.
    const bluetooth = working("bluetooth");

    const started = Date.now();
    const result = await printVia([hanging("lan"), bluetooth], bytes, 40);

    expect(result.transport).toBe("bluetooth");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.attempts[0]!.error).toContain("timed out");
  });

  it("reports every attempt when nothing works", async () => {
    await expect(
      printVia([broken("lan"), broken("bluetooth", "not paired")], bytes),
    ).rejects.toThrowError(AllTransportsFailed);

    const err = await printVia(
      [broken("lan"), broken("bluetooth", "not paired")],
      bytes,
    ).then(
      () => null,
      (e: unknown) => e as AllTransportsFailed,
    );
    expect(err?.attempts.map((a) => a.transport)).toEqual(["lan", "bluetooth"]);
    expect(err?.message).toContain("not paired");
  });

  it("says so when a target has no printer at all", async () => {
    await expect(printVia([], bytes)).rejects.toThrowError(
      "no transport configured",
    );
  });
});

describe("the agent loop", () => {
  const job = (over: Partial<PrintJob> = {}): PrintJob => ({
    id: "pj_1",
    target: "kitchen",
    stationId: "st_kitchen",
    attempts: 0,
    escposBase64: "G0BB",
    ...over,
  });

  const decode = (b64: string) =>
    Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));

  const ackSpy = () => vi.fn<(jobId: string, body: AckBody) => Promise<void>>(async () => {});

  it("prints and acks with the transport that carried it", async () => {
    const ack = ackSpy();
    const report = await runOnce({
      claim: async () => [job()],
      ack,
      transportsFor: () => [broken("lan"), working("bluetooth")],
      decode,
    });

    expect(report).toMatchObject({ claimed: 1, printed: 1, failed: 0 });
    expect(report.transports).toEqual(["bluetooth"]);
    expect(ack).toHaveBeenCalledWith("pj_1", {
      ok: true,
      transport: "bluetooth",
    });
  });

  it("acks every claimed job, even the ones it could not print", async () => {
    // A job claimed and never acked sits on its lease while the kitchen waits
    // for a docket that was never coming.
    const ack = ackSpy();
    const report = await runOnce({
      claim: async () => [job({ id: "a" }), job({ id: "b" })],
      ack,
      transportsFor: () => [broken("lan"), broken("bluetooth")],
      decode,
    });

    expect(report).toMatchObject({ claimed: 2, printed: 0, failed: 2 });
    expect(ack.mock.calls.map((c) => c[0])).toEqual(["a", "b"]);
    for (const [, body] of ack.mock.calls) {
      expect(body.ok).toBe(false);
      expect(body.ok === false && body.error).toContain("lan");
    }
  });

  it("does not retry a payload that can never decode", async () => {
    const ack = ackSpy();
    const lan = working("lan");
    const report = await runOnce({
      claim: async () => [job({ escposBase64: "!!!not base64!!!" })],
      ack,
      transportsFor: () => [lan],
      decode: () => {
        throw new Error("invalid base64");
      },
    });

    expect(report).toMatchObject({ printed: 0, failed: 1 });
    expect(lan.send).not.toHaveBeenCalled();
    expect(ack.mock.calls[0]![1].ok).toBe(false);
  });

  it("keeps going after one job fails", async () => {
    const ack = ackSpy();
    let call = 0;
    const report = await runOnce({
      claim: async () => [job({ id: "a" }), job({ id: "b" })],
      ack,
      transportsFor: () => [call++ === 0 ? broken("lan") : working("lan")],
      decode,
    });

    expect(report).toMatchObject({ claimed: 2, printed: 1, failed: 1 });
  });

  it("is a no-op when there is nothing to print", async () => {
    const ack = ackSpy();
    const report = await runOnce({
      claim: async () => [],
      ack,
      transportsFor: () => [working("lan")],
      decode,
    });

    expect(report).toEqual({ claimed: 0, printed: 0, failed: 0, transports: [] });
    expect(ack).not.toHaveBeenCalled();
  });
});
