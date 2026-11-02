import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { captureShare } from "./lib/share";
// Polices servies par Noah lui-même : aucune requête vers Google à l'ouverture, et l'app s'affiche hors ligne.
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./index.css";

captureShare();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
