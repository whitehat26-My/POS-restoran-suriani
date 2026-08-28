/**
 * Where the server is.
 *
 * In a browser the till is served by the same Worker as the API, so every
 * path is relative and this is a no-op. In the Android shell the app is
 * bundled into the APK and the WebView's origin is the device itself — there
 * is no server behind a relative path, so the till has to be told once where
 * its restaurant lives.
 *
 * Deliberately not baked into the build. The same APK runs at both branches
 * and at every restaurant onboarded later; an APK per customer would be a
 * release process nobody is going to keep up.
 */
const KEY = "suriani_api_base";

/** True when running inside the Capacitor shell rather than a browser tab. */
export function isNativeShell(): boolean {
  return (
    typeof window !== "undefined" &&
    // Capacitor sets this before any app code runs.
    (window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
      ?.isNativePlatform?.() === true
  );
}

export function apiBase(): string {
  if (!isNativeShell()) return "";
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function setApiBase(url: string): void {
  // Trailing slashes turn every path into a double slash, which some routers
  // and proxies treat as a different route.
  localStorage.setItem(KEY, url.trim().replace(/\/+$/, ""));
}

/** An API path, absolute where it has to be. */
export function apiUrl(path: string): string {
  return `${apiBase()}${path}`;
}

/** The same, as a WebSocket URL. */
export function wsUrl(path: string): string {
  const base = apiBase();
  if (!base) {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    return `${scheme}://${location.host}${path}`;
  }
  return `${base.replace(/^http/, "ws")}${path}`;
}

/** The tablet cannot do anything until it knows this. */
export function needsSetup(): boolean {
  return isNativeShell() && apiBase() === "";
}
