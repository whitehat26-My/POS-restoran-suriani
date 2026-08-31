/**
 * The socket the till listens on.
 *
 * Reconnects with capped exponential backoff. Every (re)connection begins
 * with a fresh snapshot from the server, so the consumer never reconciles —
 * it replaces. The `state` callback drives the connection-health pill: the
 * cashier must always know whether the screen is truth.
 */
import { authToken, wsUrl } from "./base";

export type LiveState = "connecting" | "live" | "reconnecting";

export interface LiveHandle {
  close: () => void;
}

export function openLive(
  outletId: string,
  onEvent: (event: Record<string, unknown>) => void,
  onState: (state: LiveState) => void,
): LiveHandle {
  let closed = false;
  let attempt = 0;
  let socket: WebSocket | null = null;
  let timer: number | undefined;

  const connect = () => {
    if (closed) return;
    onState(attempt === 0 ? "connecting" : "reconnecting");

    // A WebSocket handshake cannot carry an Authorization header, and from
    // the tablet it is cross-origin so it carries no cookie either. The
    // server accepts the token in the query string for upgrades only.
    const token = authToken();
    socket = new WebSocket(
      wsUrl(`/api/outlets/${outletId}/ws`) +
        (token ? `?access_token=${encodeURIComponent(token)}` : ""),
    );

    socket.onopen = () => {
      attempt = 0;
      onState("live");
    };
    socket.onmessage = (event) => {
      try {
        onEvent(JSON.parse(event.data as string) as Record<string, unknown>);
      } catch {
        /* a malformed frame must not kill the till */
      }
    };
    socket.onclose = () => {
      if (closed) return;
      attempt += 1;
      const delay = Math.min(1000 * 2 ** attempt, 15_000);
      onState("reconnecting");
      timer = window.setTimeout(connect, delay);
    };
    socket.onerror = () => socket?.close();
  };

  connect();
  return {
    close: () => {
      closed = true;
      window.clearTimeout(timer);
      socket?.close();
    },
  };
}
