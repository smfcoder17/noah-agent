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
  build: { outDir: "dist", assetsDir: "assets", rollupOptions: { output: { manualChunks(id) {
    if (!id.includes("node_modules")) return;
    if (/assistant-ui/.test(id)) return "conversation";
    if (/react-dom|\/react\/|scheduler|use-sync-external-store/.test(id)) return "react";
    if (/remark|rehype|unified|micromark|mdast|hast/.test(id)) return "markdown";
    if (/lucide-react/.test(id)) return "icones";
  } } } },
});
