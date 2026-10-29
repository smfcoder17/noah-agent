import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// En dev (`npm run dev`), l'API et l'écran noVNC sont relayés vers le serveur Apollo qui tourne dans Docker.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:8080", ws: true, changeOrigin: true },
    },
  },
  build: { outDir: "dist", assetsDir: "assets" },
});
