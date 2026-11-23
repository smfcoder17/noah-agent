// Réglages > Fournisseurs > « Utilisation de tes abonnements » : une barre par fenêtre mesurée, dite comme la personne la dit
// (« 42 % de ta semaine Claude, remise à zéro … »), la dernière mesure, et ce que xAI ne donne pas. Rien si la route est refusée.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SubscriptionUsage, type Usage } from "./SubscriptionUsage";

const reset = Math.floor(new Date("2026-11-26T09:00:00Z").getTime() / 1000);
const claude: Usage = { id: "claude", nom: "Claude Code", offre: "max", modele: "claude-haiku-5-5", mesure_le: Date.now() - 3 * 60000, tours: 2, jetons: 0,
  fenetres: [{ id: "five_hour", pct: 7, reset: reset - 86400, etat: "permis" }, { id: "seven_day", pct: 42, reset, etat: "permis" }] };
const gpt: Usage = { id: "chatgpt", nom: "ChatGPT", offre: "go", modele: "gpt-5", mesure_le: Date.now() - 2 * 3600000, tours: 5, jetons: 90,
  fenetres: [{ id: "thirty_day", pct: 100, reset: null, etat: "limite" }] };
const grok: Usage = { id: "grok", nom: "Grok", offre: "", modele: "grok-4.3", mesure_le: Date.now(), tours: 4, jetons: 400, fenetres: [] };

let host: HTMLDivElement, root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const show = async (answer: Response) => {
  vi.stubGlobal("fetch", vi.fn(async () => answer));
  await act(async () => root.render(<SubscriptionUsage />));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

it("une barre par fenêtre, avec le pourcentage réel, le modèle exact et la dernière mesure", async () => {
  await show(Response.json({ en_ligne: true, abonnements: [claude, gpt, grok] }));
  const text = host.textContent ?? "";
  expect(text).toContain("Claude Code");
  expect(text).toContain("claude-haiku-5-5");
  expect(text).toMatch(/42 % de ta semaine Claude, remise à zéro /);
  expect(text).toMatch(/7 % de ta fenêtre de 5 h Claude/);
  expect(text).toMatch(/Dernière mesure il y a 3 minutes|Dernière mesure dans 3 minutes|Dernière mesure/);
  const meters = [...host.querySelectorAll('[role="meter"]')];
  expect(meters.map((m) => m.getAttribute("aria-valuenow"))).toEqual(["7", "42", "100"]);
  expect(text).toMatch(/100 % de ton mois ChatGPT.*limite atteinte/);
});

it("Grok : les tours comptés et ce que xAI ne donne pas, sans pourcentage inventé", async () => {
  await show(Response.json({ en_ligne: true, abonnements: [grok] }));
  expect(host.textContent).toContain("4 tours comptés. xAI ne donne pas le reste");
  expect(host.querySelectorAll('[role="meter"]')).toHaveLength(0);
});

it("ordinateur éteint : les dernières mesures connues sont dites telles ; aucune mesure : un message clair", async () => {
  await show(Response.json({ en_ligne: false, abonnements: [claude] }));
  expect(host.textContent).toContain("Ton ordinateur est éteint : ce sont les dernières mesures connues.");
  await act(async () => root.unmount());
  root = createRoot(host);
  await show(Response.json({ en_ligne: true, abonnements: [] }));
  expect(host.textContent).toContain("Aucune mesure pour l'instant");
});

it("route refusée (profil invité) : la section n'apparaît pas", async () => {
  await show(Response.json({ detail: "Réservé au propriétaire de ce Noah Agent." }, { status: 403 }));
  expect(host.textContent).toBe("");
});
