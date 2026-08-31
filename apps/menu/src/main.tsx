import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "../../../design/tokens.css";
import "./styles.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Offline: the shell and the last menu stay readable when signal drops.
if ("serviceWorker" in navigator && !import.meta.env.DEV) {
  navigator.serviceWorker.register("/sw.js").catch(() => {
    /* offline caching is an enhancement, never a blocker */
  });
}
