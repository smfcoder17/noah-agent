import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// En dev (`npm run dev`), l'API et l'écran noVNC sont relayés vers le serveur Noah qui tourne dans Docker.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  server: {
    port: 5173,
    proxy: {
      // L'origine devient celle du serveur : sinon il refuse les requêtes qui changent quelque chose (« elle ne vient pas de Noah »).
      "/api": { target: "http://localhost:8080", ws: true, changeOrigin: true, headers: { origin: "http://localhost:8080" } },
    },
  },
  build: { outDir: "dist", assetsDir: "assets" },
});
