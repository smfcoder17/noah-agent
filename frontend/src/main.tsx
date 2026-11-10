import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { captureShare } from "./lib/share";
// Polices servies par Noah lui-même : aucune requête vers Google à l'ouverture, et l'app s'affiche hors ligne.
import "@fontsource-variable/geist-mono";
import "./index.css";

// Police officielle embarquée, aucun appel à Google depuis Noah.
const fonts = import.meta.glob("./assets/fonts/*.ttf", { query: "?url", import: "default", eager: true }) as Record<string, string>;
const figtree = fonts["./assets/fonts/Figtree.ttf"];
if (figtree && typeof FontFace !== "undefined") document.fonts.add(new FontFace("Figtree", "url(" + figtree + ")", { weight: "400 700", style: "normal", display: "swap" }));
captureShare();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
