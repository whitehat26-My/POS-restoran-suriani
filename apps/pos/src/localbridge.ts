/**
 * The JS end of the tablet's web server.
 *
 * The socket lives in Java because a WebView cannot listen on one. Everything
 * that decides anything lives here, in the router the tests drive — so what a
 * stranger on the guest WiFi can reach is decided by code that runs in CI,
 * not by code that only runs on a tablet in a restaurant.
 *
 * In a browser none of this starts: `registerPlugin` returns a proxy whose
 * calls reject, and `start()` reports that plainly rather than pretending.
 */
import { registerPlugin } from "@capacitor/core";
import type { LocalRequest, LocalResponse } from "@suriani/localserver";

import { isTablet } from "./print";

interface LocalServerPlugin {
  start(options: { port?: number }): Promise<{
    address: string;
    port: number;
    url: string;
    running: boolean;
  }>;
  stop(): Promise<void>;
  address(): Promise<{
    address: string | null;
    running: boolean;
    served: number;
  }>;
  respond(options: {
    requestId: string;
    status: number;
    json?: string;
    asset?: string;
  }): Promise<void>;
  addListener(
    event: "request",
    fn: (event: {
      requestId: string;
      method: string;
      path: string;
      query: string;
      body: string | null;
      ip: string;
    }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

const Native = registerPlugin<LocalServerPlugin>("SurianiLocalServer");

export const localServerAddress = () => Native.address();

export interface RunningServer {
  url: string;
  stop: () => Promise<void>;
}

/**
 * Start listening, and pump every request through the router.
 *
 * @param handle the router from `openLocalServer`
 */
export async function startLocalServer(
  handle: (req: LocalRequest) => Promise<LocalResponse>,
  port = 8080,
): Promise<RunningServer> {
  if (!isTablet()) throw new Error("a browser cannot listen on a socket");

  const listener = await Native.addListener("request", (event) => {
    void (async () => {
      let response: LocalResponse;
      try {
        response = await handle({
          method: event.method,
          path: event.path,
          query: Object.fromEntries(new URLSearchParams(event.query)),
          body: event.body ?? undefined,
          ip: event.ip,
        });
      } catch {
        // A bug in here must not leave a phone waiting for a socket that
        // never answers; the Java side would time out at five seconds, but
        // saying so immediately is better.
        response = { status: 500, body: { json: { error: "internal" } } };
      }

      await Native.respond({
        requestId: event.requestId,
        status: response.status,
        ...("asset" in response.body
          ? { asset: response.body.asset }
          : { json: JSON.stringify(response.body.json) }),
      });
    })();
  });

  const started = await Native.start({ port });

  return {
    url: started.url,
    stop: async () => {
      await listener.remove();
      await Native.stop();
    },
  };
}
