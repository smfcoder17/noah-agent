import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { captureShare } from "./lib/share";
import { chargerLangue } from "./i18n";
// Polices servies par Noah lui-même : aucune requête vers Google à l'ouverture, et l'app s'affiche hors ligne.
import "@fontsource-variable/figtree/wght.css";
import "@fontsource-variable/geist-mono";
import "./index.css";

captureShare();
void chargerLangue().finally(() => { // l'anglais se charge avant le premier affichage ; un échec réseau laisse le français plutôt qu'un écran vide
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
