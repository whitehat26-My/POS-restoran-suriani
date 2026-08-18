/**
 * The socket the till listens on.
 *
 * Reconnects with capped exponential backoff. Every (re)connection begins
 * with a fresh snapshot from the server, so the consumer never reconciles —
 * it replaces. The `state` callback drives the connection-health pill: the
 * cashier must always know whether the screen is truth.
 */
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

    const scheme = location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(
      `${scheme}://${location.host}/api/outlets/${outletId}/ws`,
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
