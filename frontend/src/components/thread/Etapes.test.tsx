// 0.4.0, lot L9b : le bloc « Étapes » d'une tâche. Dans la ligne dépliée (résumé en texte) et sur la page de la tâche (une ligne par étape,
// coche verte, la dernière porte la pastille d'état). Une tâche sans étapes n'a pas de bloc : rien n'est inventé.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentContext } from "@/lib/agentContext";
import type { TacheDuFil } from "@/lib/ouverture";
import { EtapesTache } from "./Etapes";
import { TacheLigne } from "./TacheLigne";
import { CarteSansConsigne } from "./messages";

// jsdom n'a pas matchMedia (lu dès l'import de chatMood).
vi.hoisted(() => {
  window.matchMedia = ((query: string) => ({ matches: false, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false })) as typeof window.matchMedia;
});
vi.mock("../Noah", () => ({ AgentFace: () => null, agentColor: () => "#000" }));
vi.mock("@assistant-ui/react", async (orig) => ({ ...(await orig<typeof import("@assistant-ui/react")>()), useAuiState: () => false }));

let host: HTMLDivElement, root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const render = (ui: React.ReactElement) => act(async () => root.render(ui));

const tache = (over: Partial<TacheDuFil> = {}): TacheDuFil => ({
  id: "t1", titre: "Créer le visuel d'en-tête", genre: "demande", demandeur: { id: "a", nom: "Noah" }, agent: { id: "b", nom: "Léa" }, etat: "encours", resume: "Mise au format en cours.",
  fichiers: [], ancre: 5, cree: 1_700_000_000, fini_a: null, conversation_id: "c1", question: null, ...over,
});
const ETAPES = ["Brief lu", "Trois pistes générées", "Mise au format 1200 × 600"];

it("la ligne dépliée résume les étapes en un petit texte ; sans étapes, rien", async () => {
  await render(<TacheLigne tache={tache({ etapes: ETAPES })} agentId="b" agentName="Léa" defaultOpen />);
  expect(host.querySelector(".sub p")!.textContent).toBe("Brief lu · Trois pistes générées · Mise au format 1200 × 600");
  await render(<TacheLigne tache={tache({ etapes: [] })} agentId="b" agentName="Léa" defaultOpen />);
  expect(host.textContent).not.toContain("Brief lu");
  expect(host.querySelector(".sub p")!.textContent).toBe("Mise au format en cours.");
});

it("la page de la tâche : une ligne par étape, coches vertes, la dernière porte la pastille d'état (en cours)", async () => {
  await render(<EtapesTache etapes={ETAPES} etat="encours" />);
  expect(host.querySelector(".list-head")!.textContent).toBe("Étapes");
  const lignes = [...host.querySelectorAll<HTMLElement>("[data-etape]")];
  expect(lignes.map((l) => l.textContent)).toEqual(ETAPES);
  expect(lignes.map((l) => l.dataset.etape)).toEqual(["faite", "faite", "etat"]);
  expect(lignes[0].querySelector("svg")).not.toBeNull();
  expect(lignes[2].querySelector("svg.text-ok")).toBeNull();
});

it("terminée : toutes les étapes sont cochées ; attend et échec : la dernière garde sa pastille", async () => {
  await render(<EtapesTache etapes={ETAPES} etat="fini" />);
  expect([...host.querySelectorAll<HTMLElement>("[data-etape]")].map((l) => l.dataset.etape)).toEqual(["faite", "faite", "faite"]);
  for (const etat of ["attend", "echec"] as const) {
    await render(<EtapesTache etapes={ETAPES} etat={etat} />);
    expect([...host.querySelectorAll<HTMLElement>("[data-etape]")].map((l) => l.dataset.etape)).toEqual(["faite", "faite", "etat"]);
  }
});

it("une tâche sans étapes n'a pas de bloc", async () => {
  await render(<EtapesTache etapes={[]} etat="encours" />);
  expect(host.querySelector("[data-etapes]")).toBeNull();
  expect(host.textContent).toBe("");
});

it("le fil d'une tâche sans consigne pose le bloc avant la carte ; sans étapes ni carte, rien", async () => {
  const ctx = { agentId: "b", agentName: "Léa", agentColor: "", agentShape: "", agentDetail: "", agentModel: "", details: false, hint: "", conversationId: "c1", say: () => {}, readOnly: false, canWatch: false, tache: "Léa" };
  await render(<AgentContext.Provider value={{ ...ctx, etapes: <EtapesTache etapes={ETAPES} etat="encours" />, carte: <p data-q>La question</p> }}><CarteSansConsigne /></AgentContext.Provider>);
  const ordre = [...host.querySelectorAll("[data-etapes-tache], [data-carte-question]")].map((e) => (e as HTMLElement).dataset.etapesTache !== undefined ? "etapes" : "carte");
  expect(ordre).toEqual(["etapes", "carte"]);
  await render(<AgentContext.Provider value={ctx}><CarteSansConsigne /></AgentContext.Provider>);
  expect(host.textContent).toBe("");
});
