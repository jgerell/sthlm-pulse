import { defineConfig } from "vite";

export default defineConfig({
  build: {
    // MapLibre and deck.gl are most of the bundle, and the map needs both at once.
    chunkSizeWarningLimit: 2000,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:4280",
    },
  },
});
