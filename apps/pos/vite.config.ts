import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Served at /pos/ by the same Worker that serves the customer app.
  base: "/pos/",
  plugins: [react()],
  server: {
    proxy: {
      "/api": { target: "http://localhost:8787", ws: true },
    },
  },
  build: { outDir: "dist", sourcemap: false },
});
