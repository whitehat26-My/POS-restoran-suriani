/**
 * The claim / print / ack loop, as it runs on the tablet.
 *
 * Deliberately dumb, exactly like the Node reference in `tools/print-agent`:
 * all layout lives on the server, so fixing a docket is a deploy rather than a
 * visit to a restaurant. This one adds the Bluetooth fallback the Node version
 * has no use for, and the transport that actually worked is reported on the
 * ack so the till can show it.
 */
import { AllTransportsFailed, printVia, type Transport } from "./transport";

export interface PrintJob {
  id: string;
  target: string;
  stationId: string | null;
  attempts: number;
  escposBase64: string;
}

export interface AgentPorts {
  /** Claim leased jobs. Rejects if the server cannot be reached. */
  claim(): Promise<PrintJob[]>;
  ack(jobId: string, result: AckBody): Promise<void>;
  /** Transports for a target, best first. Usually [LAN, Bluetooth]. */
  transportsFor(target: string): readonly Transport[];
  decode(base64: string): Uint8Array;
}

export type AckBody =
  | { ok: true; transport: string }
  | { ok: false; error: string };

export interface RunReport {
  claimed: number;
  printed: number;
  failed: number;
  /** Which transport carried each docket — "lan", "bluetooth". */
  transports: string[];
}

/**
 * Drain the queue once.
 *
 * Every claimed job is acked exactly once, success or failure, because a job
 * that is claimed and never acked sits on its lease until it expires — the
 * kitchen waits thirty seconds for a docket that was never coming. An ack of
 * `ok: false` is what drives the backoff and, eventually, the red banner.
 */
export async function runOnce(ports: AgentPorts): Promise<RunReport> {
  const jobs = await ports.claim();
  const report: RunReport = {
    claimed: jobs.length,
    printed: 0,
    failed: 0,
    transports: [],
  };

  for (const job of jobs) {
    let bytes: Uint8Array;
    try {
      bytes = ports.decode(job.escposBase64);
    } catch (err) {
      // Undecodable bytes will never decode. Ack the failure so the job walks
      // its backoff to `failed` and shows up on the till, rather than being
      // silently reclaimed forever.
      report.failed += 1;
      await ports.ack(job.id, {
        ok: false,
        error: `bad payload: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    try {
      const { transport } = await printVia(ports.transportsFor(job.target), bytes);
      report.printed += 1;
      report.transports.push(transport);
      await ports.ack(job.id, { ok: true, transport });
    } catch (err) {
      report.failed += 1;
      await ports.ack(job.id, {
        ok: false,
        error:
          err instanceof AllTransportsFailed
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err),
      });
    }
  }

  return report;
}
