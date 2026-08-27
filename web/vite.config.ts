import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Ports are DYNAMIC: scripts/dev.sh picks free ones (falling back from the
// documented defaults when 4444/4100 are busy) and exports them. Read those env
// vars so the dev server binds the chosen port and proxies /api to the chosen
// engine. Defaults preserve the documented 4444 -> 4100 wiring.
const ENGINE_PORT = process.env.ENGINE_PORT ?? "4100";
const WEB_PORT = Number(process.env.WEB_PORT ?? 4444);

export default defineConfig({
  plugins: [react()],
  server: {
    // Loopback by default: this dev server proxies /api to the engine, so a
    // 0.0.0.0 bind would expose the engine's shell/file/PTY surface to the LAN
    // regardless of the engine's own loopback bind. scripts/dev.sh passes
    // --host explicitly; WEB_HOST opts into a wider bind deliberately.
    host: process.env.WEB_HOST ?? "127.0.0.1",
    port: WEB_PORT,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${ENGINE_PORT}`,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    sourcemap: false,
    chunkSizeWarningLimit: 1600,
  },
});
