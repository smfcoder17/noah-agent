// Un morceau de l'interface devenu introuvable (mise à jour du serveur) : la page se recharge seule, une fois par minute au plus.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Boundary } from "@/components/Boundary";
import { estMorceauIntrouvable, fenetre, INTERFACE_CHANGEE, recharger, surveillerMorceaux } from "./rechargement";
import { agentRepris, noterAgent, sauverPile } from "./navigation";

let recharge: ReturnType<typeof vi.fn>;
beforeEach(() => {
  sessionStorage.clear();
  document.body.innerHTML = "";
  recharge = vi.fn();
  vi.spyOn(fenetre, "recharger").mockImplementation(recharge as () => void);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

it("reconnaît un morceau introuvable, pas une autre panne", () => {
  for (const m of ["Failed to fetch dynamically imported module: https://x/assets/Sortie-AbCd1234.js", "error loading dynamically imported module", "Importing a module script failed.", "Unable to preload CSS for /assets/a.css", "Loading chunk 12 failed."]) {
    expect(estMorceauIntrouvable(new TypeError(m)), m).toBe(true);
  }
  const chunk = new Error("x"); chunk.name = "ChunkLoadError";
  expect(estMorceauIntrouvable(chunk)).toBe(true);
  expect(estMorceauIntrouvable(new Error("Cannot read properties of undefined"))).toBe(false);
  expect(estMorceauIntrouvable(undefined)).toBe(false);
});

it("se recharge une fois, puis plus pendant une minute (pas de boucle)", () => {
  expect(recharger()).toBe(true);
  expect(recharger()).toBe(false);
  expect(recharge).toHaveBeenCalledTimes(1);
  sessionStorage.setItem("noah:rechargement", String(Date.now() - 61_000));
  expect(recharger()).toBe(true);
  expect(recharge).toHaveBeenCalledTimes(2);
});

it("un clic de la personne recharge même dans la minute", () => {
  expect(recharger()).toBe(true);
  expect(recharger({ forcer: true })).toBe(true);
  expect(recharge).toHaveBeenCalledTimes(2);
});

it("un texte en cours d'écriture n'est pas perdu : pas de rechargement seul, le bandeau est proposé", () => {
  document.body.innerHTML = '<textarea data-composer-input></textarea>';
  const saisie = document.querySelector<HTMLTextAreaElement>("[data-composer-input]")!;
  saisie.value = "Mon message à moitié écrit";
  const bandeau = vi.fn();
  window.addEventListener(INTERFACE_CHANGEE, bandeau);
  expect(recharger()).toBe(false);
  expect(recharge).not.toHaveBeenCalled();
  expect(bandeau).toHaveBeenCalledTimes(1);
  window.removeEventListener(INTERFACE_CHANGEE, bandeau);
  expect(recharger({ forcer: true })).toBe(true);
});

it("l'événement de Vite (préchargement perdu) et une promesse rejetée déclenchent le rechargement", () => {
  surveillerMorceaux();
  window.dispatchEvent(new Event("vite:preloadError"));
  expect(recharge).toHaveBeenCalledTimes(1);
  sessionStorage.clear();
  const rejet = new Event("unhandledrejection") as Event & { reason: unknown };
  rejet.reason = new TypeError("Failed to fetch dynamically imported module: /assets/x.js");
  window.dispatchEvent(rejet);
  expect(recharge).toHaveBeenCalledTimes(2);
  sessionStorage.clear();
  const autre = new Event("unhandledrejection") as Event & { reason: unknown };
  autre.reason = new Error("autre chose");
  window.dispatchEvent(autre);
  expect(recharge).toHaveBeenCalledTimes(2);
});

it("garde l'endroit et l'agent pour la page suivante", () => {
  noterAgent("a1");
  sauverPile();
  const saved = JSON.parse(sessionStorage.getItem("noah:pile-avant-rechargement")!);
  expect(saved.agent).toBe("a1");
  expect(saved.stack[0]).toEqual({ kind: "tab", tab: "chat" });
  expect(typeof agentRepris()).toBe("object"); // null ici : la reprise se lit au chargement du module, pas pendant l'essai
});

function Casse({ erreur }: { erreur: Error }): never { throw erreur; }

async function montrer(erreur: Error) {
  const host = document.createElement("div"), root = createRoot(host);
  document.body.append(host);
  await act(async () => root.render(<Boundary label="Cette rubrique"><Casse erreur={erreur} /></Boundary>));
  const cliquer = async () => act(async () => { host.querySelector("button")!.click(); });
  return { host, root, cliquer };
}

it("la rubrique qui ne trouve plus son morceau recharge la page ; « Réessayer » la recharge aussi, même dans la minute", async () => {
  const { host, root, cliquer } = await montrer(new TypeError("Failed to fetch dynamically imported module: /assets/Sortie-AbCd1234.js"));
  expect(recharge).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("Réessayer");
  await cliquer();
  expect(recharge).toHaveBeenCalledTimes(2);
  await act(async () => root.unmount());
});

it("une autre panne de rubrique garde « Réessayer » sans rechargement", async () => {
  const { root, cliquer } = await montrer(new Error("boum"));
  expect(recharge).not.toHaveBeenCalled();
  await cliquer();
  expect(recharge).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});