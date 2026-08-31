import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // Local development runs vite here and `wrangler dev` for the API;
    // in production one Worker serves both from the same origin.
    proxy: { "/api": "http://localhost:8787" },
  },
  build: { outDir: "dist", sourcemap: false },
});
