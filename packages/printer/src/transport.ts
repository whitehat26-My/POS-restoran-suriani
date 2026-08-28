/**
 * How bytes reach a printer, and what to do when one way stops working.
 *
 * The restaurant has two independent failure modes and they need different
 * answers. The internet dying does not stop the kitchen printing, because the
 * printer is on the shop's own LAN. The *router* dying does — and that is the
 * one Bluetooth exists for: the tablet talks straight to the printer with no
 * network in between.
 */

export interface Transport {
  /** Recorded on the ack, so the till can show how a docket actually got out. */
  readonly name: string;
  send(bytes: Uint8Array): Promise<void>;
}

export interface TransportAttempt {
  transport: string;
  error: string;
}

export class AllTransportsFailed extends Error {
  constructor(readonly attempts: TransportAttempt[]) {
    super(
      attempts.length === 0
        ? "no transport configured"
        : attempts.map((a) => `${a.transport}: ${a.error}`).join("; "),
    );
    this.name = "AllTransportsFailed";
  }
}

/** Give up on a transport that neither succeeds nor fails. */
function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * Print over the first transport that works, in order.
 *
 * Each gets a short deadline of its own. A LAN printer that has quietly gone
 * away does not fail fast — the socket sits there until the OS gives up,
 * which can be a minute or more. Waiting that long before trying Bluetooth
 * means the kitchen stands idle during exactly the emergency the fallback
 * exists for, so the timeout is the mechanism, not a nicety.
 */
export async function printVia(
  transports: readonly Transport[],
  bytes: Uint8Array,
  timeoutMs = 1_500,
): Promise<{ transport: string; attempts: TransportAttempt[] }> {
  const attempts: TransportAttempt[] = [];

  for (const transport of transports) {
    try {
      await withTimeout(transport.send(bytes), timeoutMs, transport.name);
      return { transport: transport.name, attempts };
    } catch (err) {
      attempts.push({
        transport: transport.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  throw new AllTransportsFailed(attempts);
}
