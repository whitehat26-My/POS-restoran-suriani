import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "my.suriani.pos",
  appName: "Suriani POS",
  // The till, built by `pnpm build:web` and copied in by `cap sync`.
  webDir: "www",
  android: {
    // The till holds an outlet's whole trading day. A WebView that gets
    // recycled and reloads from a stale cache would show a floor plan that is
    // hours old, so nothing is served from the system cache.
    allowMixedContent: false,
  },
  server: {
    androidScheme: "https",
  },
};

export default config;
