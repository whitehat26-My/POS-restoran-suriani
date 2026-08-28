/**
 * The till's offline spine, wired up.
 *
 * Every action a cashier takes is written to a durable outbox first and sent
 * second. When the line is up that is a few milliseconds of extra latency
 * nobody notices; when it is down, the restaurant carries on trading and the
 * evening reconciles itself the moment the line returns.
 *
 * This works today in a plain browser, which matters: it means the offline
 * behaviour is exercised on every dev run and in the browser drill, rather
 * than only inside an APK nobody can test in CI. The Android shell inherits
 * it unchanged — a WebView has IndexedDB like any other browser.
 */
import { ulid } from "@suriani/core/ids";
import {
  Outbox,
  Syncer,
  idbStore,
  memoryStore,
  type Op,
  type OpBody,
  type OpResult,
  type Store,
  type SyncReport,
  type SyncState,
} from "@suriani/offline";

/** A tablet keeps its identity across restarts; two tills must not collide. */
function deviceId(): string {
  const KEY = "suriani_device_id";
  try {
    const stored = localStorage.getItem(KEY);
    if (stored) return stored;
    const fresh = `dev_${ulid()}`;
    localStorage.setItem(KEY, fresh);
    return fresh;
  } catch {
    // Private window, or storage blocked. A per-session id still works; it
    // only costs the ability to tell two shifts apart in the op log.
    return `dev_${ulid()}`;
  }
}

/**
 * IndexedDB where it exists, memory where it does not.
 *
 * Falling back to memory means a browser with storage disabled still takes
 * orders for as long as the tab is open, rather than refusing to work at all.
 * The till's pill says which it got.
 */
function store(outletId: string): { store: Store; durable: boolean } {
  try {
    if (typeof indexedDB !== "undefined") {
      return { store: idbStore(`suriani-${outletId}`), durable: true };
    }
  } catch {
    /* fall through */
  }
  return { store: memoryStore(), durable: false };
}

export interface OfflineTill {
  /** Record an action and try to send it. Never throws on a dead line. */
  perform(body: OpBody): Promise<Op>;
  /** Drain now — the line came back, or the cashier tapped retry. */
  nudge(): void;
  pending(): Promise<number>;
  durable: boolean;
  stop(): void;
}

export function openOfflineTill(
  outletId: string,
  onChange: (state: SyncState, report: SyncReport) => void,
  onRejected: (rejected: OpResult[]) => void,
): OfflineTill {
  const { store: kv, durable } = store(outletId);
  const outbox = new Outbox(kv, deviceId(), ulid);

  const push = async (ops: Op[]) => {
    const res = await fetch(`/api/outlets/${outletId}/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ops }),
    });
    if (!res.ok) {
      // A 4xx is the server refusing this shape for good — but the ops are
      // still ours, so surface it as a transport failure and let the cashier
      // see a stuck queue rather than silently dropping the evening.
      throw new Error(`sync failed: ${res.status}`);
    }
    return (await res.json()) as { results: OpResult[] };
  };

  const syncer = new Syncer(outbox, push, (state, report) => {
    onChange(state, report);
    if (report.rejected.length > 0) onRejected(report.rejected);
  });

  const online = () => syncer.nudge();
  const visible = () => {
    if (document.visibilityState === "visible") syncer.nudge();
  };
  window.addEventListener("online", online);
  document.addEventListener("visibilitychange", visible);

  // Anything left from the last shift goes first.
  void syncer.drain();

  return {
    async perform(body: OpBody) {
      const op = await outbox.enqueue(body);
      void syncer.drain();
      return op;
    },
    nudge: () => syncer.nudge(),
    pending: () => outbox.size(),
    durable,
    stop() {
      syncer.stop();
      window.removeEventListener("online", online);
      document.removeEventListener("visibilitychange", visible);
    },
  };
}
