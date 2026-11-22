import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/lib/api", async (orig) => ({ ...(await orig<object>()), get: vi.fn(async (p: string) => p === "/api/juge" ? { actif: true, modele: "m", nom: "Juge", cout_mois: 0, appels: 0, refus: 0, accords: 0, pannes: 0, tris: 0, signales: 0, mode: "auto" } : p.endsWith("/proactif") ? { mode: "signaler", choisi: true, minutes: 60, modifiable: true, sources: [], objectifs: 0, dernier_passage: null, erreur: null, passages: 0, signalements: 0, tours_du_jour: 0, tours_max: 12, en_cours: false, cout: 0, heures: { de: 8, a: 21 }, propositions_max: 3 } : []), send: vi.fn(async () => ({})), request: vi.fn(async () => ({})), canAdmin: () => true, canTalk: () => true, currentAuthEpoch: () => "test" }));
import type { Agent } from "@/lib/api";
import { SettingsPage, type SettingsTab } from "./Settings";

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({})));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const noOp = () => {};
const chefs = [{ id: "a", name: "Marie", role: "Chef de projet", chef: true }, { id: "b", name: "Luc", role: "Rédacteur" }] as unknown as Agent[];
const show = async (tab: SettingsTab, owner = true, onTab: (t: SettingsTab) => void = noOp, agents: Agent[] = []) =>
  act(async () => root.render(<SettingsPage tab={tab} owner={owner} agents={agents} onTab={onTab} onClose={noOp} onBrainSaved={noOp} />));
const links = () => [...host.querySelectorAll<HTMLElement>(".set-nav .set-link")].map((l) => l.querySelector(".cut")!.textContent);
const title = () => host.querySelector("h2.title")!.textContent;

it("propriétaire : les rubriques du prototype, dans l'ordre, sans Bureau ni Abonnements faute de donnée", async () => {
  await show("appearance");
  expect(links()).toEqual(["Apparence", "Compte", "Coffre", "Appareils", "Notifications", "Équipe", "Modèles et budget", "Fournisseurs", "Personnes", "Serveur"]);
  expect(host.querySelector("main")!.getAttribute("aria-label")).toBe("Réglages");
});

it("non-propriétaire : aucune rubrique de configuration du serveur", async () => {
  await show("appearance", false);
  expect(links()).toEqual(["Apparence", "Compte", "Coffre", "Appareils", "Notifications", "Équipe"]);
});

it("cliquer une rubrique demande son premier onglet", async () => {
  const onTab = vi.fn();
  await show("appearance", true, onTab);
  const link = [...host.querySelectorAll<HTMLElement>(".set-link")].find((l) => l.textContent!.startsWith("Modèles et budget"))!;
  await act(async () => link.click());
  expect(onTab).toHaveBeenCalledWith("brain");
});

it.each<[SettingsTab, string]>([
  ["appearance", "Apparence"], ["security", "Compte"], ["vault", "Coffre"], ["phone", "Appareils"], ["notifications", "Notifications"],
  ["team", "Équipe"], ["brain", "Modèles et budget"], ["create", "Modèles et budget"], ["voice", "Modèles et budget"], ["providers", "Fournisseurs"],
  ["profiles", "Personnes"], ["updates", "Serveur"], ["mail", "Serveur"], ["privacy", "Serveur"], ["diagnostic", "Serveur"], ["home", "Apparence"],
])("l'ancien onglet %s ouvre la rubrique %s", async (tab, rubric) => {
  await show(tab);
  expect(title()).toBe(rubric);
  expect(host.querySelector(".set")!.classList.contains("detail")).toBe(tab !== "home");
});

it("un onglet de rubrique est sélectionné : Serveur > Confidentialité, Modèles > Voix", async () => {
  await show("privacy");
  expect(host.querySelector('[role="tab"][data-state="active"]')!.textContent).toBe("Confidentialité");
  await show("voice");
  expect(host.querySelector('[role="tab"][data-state="active"]')!.textContent).toBe("Voix");
});

it("téléphone : le sommaire (« home ») porte le bouton Relier et une ligne par rubrique avec son aide", async () => {
  await show("home");
  const nav = host.querySelector(".set-nav")!;
  expect(nav.textContent).toContain("Relier un téléphone ou un ordinateur");
  expect(nav.querySelectorAll(".set-link small").length).toBe(10);
  expect(host.querySelector(".set")!.classList.contains("detail")).toBe(false);
});

it("téléphone : « ‹ Réglages » ramène au sommaire, « Relier » ouvre Appareils", async () => {
  const onTab = vi.fn();
  await show("appearance", true, onTab);
  const back = [...host.querySelectorAll<HTMLButtonElement>(".set-body button")].find((b) => b.textContent === "Réglages")!;
  await act(async () => back.click());
  expect(onTab).toHaveBeenLastCalledWith("home");
  const pair = [...host.querySelectorAll<HTMLButtonElement>(".set-nav button")].find((b) => b.textContent === "Relier un téléphone ou un ordinateur")!;
  await act(async () => pair.click());
  expect(onTab).toHaveBeenLastCalledWith("phone");
});

it("Équipe : le chef est en lecture seule, sans bouton pour en désigner un autre", async () => {
  await show("team", true, noOp, chefs);
  const equipe = host.querySelector("[data-equipe]")!;
  expect(equipe.textContent).toContain("Le premier agent que tu as créé est ton chef d'équipe.");
  const rows = [...equipe.querySelectorAll(".list")][0].querySelectorAll(".row");
  expect(rows.length).toBe(1);
  expect(rows[0].textContent).toContain("Marie");
  expect(rows[0].textContent).not.toContain("Luc");
  expect(rows[0].querySelector("button")).toBeNull();
  expect(equipe.textContent).toContain("ce mois-ci"); // le réglage d'autonomie (le juge) vit ici, plus sous Confidentialité
  for (const sujet of ["Payer", "Supprimer définitivement", "Secrets et droits", "Première publication"]) expect(equipe.textContent).toContain(sujet);
});

it("Équipe : « Quand tu ne lui parles pas » est dans la fiche de chaque agent réglable (plus dans le panneau de l'agent)", async () => {
  await show("team", true, noOp, chefs);
  const section = host.querySelector("[data-autonomie]")!;
  expect(section.textContent).toContain("Quand tu ne lui parles pas");
  const fiches = [...section.querySelectorAll("[data-autonomie-agent]")];
  expect(fiches.map((f) => f.getAttribute("data-autonomie-agent"))).toEqual(["a", "b"]);
  for (const fiche of fiches) for (const mot of ["Rien", "Me signaler", "Agir et me dire"]) expect(fiche.textContent).toContain(mot);
});

it("Équipe sans agent : le dit, sans inventer de chef", async () => {
  await show("team");
  expect(host.querySelector("[data-equipe]")!.textContent).toContain("Aucun agent pour l'instant.");
});

it("Apparence : langue, thème, taille, masquer les sensibles et visages immobiles sont là", async () => {
  await show("appearance");
  expect(host.querySelector('select[aria-label="Langue"]')).toBeTruthy();
  expect(host.querySelector('[role="group"][aria-label="Thème"]')!.textContent).toBe("ClairSombreSystème");
  expect(host.querySelector('[role="group"][aria-label="Taille du texte"]')!.textContent).toBe("PetitNormalGrand");
  for (const l of ["Masquer les données sensibles", "Visages immobiles"]) expect(host.querySelector(`[role="switch"][aria-label="${l}"]`), l).toBeTruthy();
  const faces = host.querySelector<HTMLElement>('[role="switch"][aria-label="Visages immobiles"]')!;
  const before = faces.getAttribute("aria-checked");
  await act(async () => faces.click());
  expect(faces.getAttribute("aria-checked")).not.toBe(before);
  await act(async () => faces.click());
});
