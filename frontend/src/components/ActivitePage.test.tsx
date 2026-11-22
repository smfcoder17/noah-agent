import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const tache = (id: string, agent: [string, string], de: [string, string] | null, etat: string, titre: string) => ({
  id, titre, genre: "demande", demandeur: de ? { id: de[0], nom: de[1] } : null, agent: { id: agent[0], nom: agent[1] }, etat, resume: "", fichiers: [], ancre: 1,
  cree: 1_700_000_000, fini_a: etat === "fini" ? 1_700_000_240 : null, conversation_id: `c-${id}`, question: null, etapes: [],
});
const routine = { agent: { id: "ines", nom: "Inès" }, id: "veille", nom: "Veille des concurrents", quand: "Chaque jour à 7 h", en_pause: false, supprimee: false, passages: 12, echecs: 0, vient: true, dernier_a: 1_700_000_000, bilan: "Deux nouveautés ce matin.", dernier_etat: "ok" };
const calme = { ...routine, id: "point", nom: "Point de la semaine", agent: { id: "noah", nom: "Noah" }, vient: false, passages: 1, bilan: "Rien à signaler." };
const decision = {
  id: "q9", genre: "question", de: "lea", de_nom: "Léa", tache_id: "t1", tache: "Newsletter", conversation_id: "c1", titre: "Couleur de la campagne", pourquoi: "", choix: [], libre: true, reserve: "",
  chemin: [{ id: "lea", nom: "Léa" }, { id: "noah", nom: "Noah" }], cree: 1_700_000_000, reponse: "La couleur de la campagne", par: "Noah", par_id: "noah", le: 1_700_000_100, correction: "", corrigee: false, regle_id: null,
};
let activite: unknown, echec = false;
vi.mock("@/lib/api", () => ({
  get: vi.fn(async (path: string) => {
    if (path === "/api/activite") { if (echec) throw new Error("hors ligne"); return activite; }
    if (path === "/api/decisions") return { decisions: [decision] };
    if (path.includes("/routines-passages?")) return { passages: [{ id: 5, routine_id: "veille", nom: "Veille", etat: "ok", passe_a: 1_700_000_005, duree: 3, resume: "Deux nouveautés.", amene: false }], plus: false };
    return { id: 5, rendu: "Rendu complet.", erreur: "", resume: "Deux nouveautés.", etat: "ok" };
  }),
  send: vi.fn(async (path: string) => (path.endsWith("/routines-vues") ? { non_vues: 0 } : { conversation_id: "c1" })),
}));
vi.mock("@/lib/ouverture", () => ({ useOuverture: () => ({ revision: "1" }) }));
vi.mock("./Sidebar", () => ({ StateShape: () => <span data-forme /> }));
vi.mock("./ui", () => ({
  Button: ({ children, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button type="button" {...p}>{children}</button>,
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div>,
  ErrorText: ({ children }: { children?: React.ReactNode }) => (children ? <p role="alert">{children}</p> : null),
}));
import { get, send } from "@/lib/api";
import { ActivitePage } from "./ActivitePage";

let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
const onOpenTache = vi.fn(), onOpenAgent = vi.fn();
const page = () => <ActivitePage agentId="noah" onOpenTache={onOpenTache} onOpenAgent={onOpenAgent} />;
const monter = async () => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); await act(async () => root.render(page())); };
const demonter = async () => { await act(async () => root.unmount()); host.remove(); };
beforeEach(() => {
  vi.mocked(send).mockClear(); vi.mocked(get).mockClear(); onOpenTache.mockClear(); onOpenAgent.mockClear(); echec = false;
  activite = {
    taches: [tache("t1", ["lea", "Léa"], ["noah", "Noah"], "fini", "Rédiger la newsletter"), tache("t2", ["hugo", "Hugo"], ["noah", "Noah"], "attend", "Programmer l'envoi"), tache("t3", ["ines", "Inès"], null, "encours", "Veille du matin")],
    routines: [routine, calme], non_vues: 1,
  };
});
afterEach(async () => { if (host?.isConnected) await demonter(); });
const bouton = (texte: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(texte))!;

it("réunit les tâches de tous les agents : qui l'a confiée à qui, et où elle en est", async () => {
  await monter();
  expect(get).toHaveBeenCalledWith("/api/activite");
  expect(host.querySelector("h1")?.textContent).toBe("Activité");
  const lignes = [...host.querySelectorAll("[data-activite-taches] .row")];
  expect(lignes.map((l) => l.querySelector(".row-title")?.textContent)).toEqual(["Rédiger la newsletter", "Programmer l'envoi", "Veille du matin"]);
  expect(lignes[0].querySelector(".row-sub")?.textContent).toBe("Noah l'a confiée à Léa · terminée en 4 min");
  expect(lignes[1].querySelector(".row-sub")?.textContent).toBe("Noah l'a confiée à Hugo · attend ta réponse");
  expect(lignes[2].querySelector(".row-sub")?.textContent).toContain("Inès");
  expect(lignes[2].querySelector(".row-sub")?.textContent).not.toContain("confiée");
});

it("un clic sur une tâche ouvre sa tâche dans le fil de son agent", async () => {
  await monter();
  await act(async () => bouton("Programmer l'envoi").click());
  expect(onOpenTache).toHaveBeenCalledWith("hugo", "c-t2");
});

it("les routines : un voyant, ce qui est passé depuis la dernière visite, un compte par routine", async () => {
  await monter();
  expect(host.querySelector("[data-routines-activite] [data-voyant]")).not.toBeNull();
  expect(host.textContent).toContain("1 passées depuis ta dernière visite");
  const lignes = [...host.querySelectorAll("[data-routines-activite] .row")];
  expect(lignes[0].querySelector(".row-sub")?.textContent).toBe("Inès · Chaque jour à 7 h · Deux nouveautés ce matin.");
  expect(lignes[0].textContent).toContain("12 passages");
  expect(lignes[1].querySelector("[data-voyant]")).toBeNull();
});

it("une routine s'ouvre en haut de la page avec son bilan ; son agent est marqué vu ; « Amener dans le fil » ouvre le fil", async () => {
  await monter();
  await act(async () => bouton("Veille des concurrents").click());
  expect(send).toHaveBeenCalledWith("/api/agents/ines/routines-vues", {});
  expect(host.querySelector("[data-routine-bilan]")).not.toBeNull();
  expect(host.querySelector("h1.title")?.textContent).toBe("Veille des concurrents");
  expect(host.querySelector("[data-activite-taches]")).toBeNull();
  await act(async () => (host.querySelector("[data-passage] button") as HTMLButtonElement).click());
  await act(async () => bouton("Amener dans le fil").click());
  expect(send).toHaveBeenCalledWith("/api/agents/ines/routines-passages/5/amener", {});
  expect(onOpenAgent).toHaveBeenCalledWith("ines");
  await act(async () => bouton("Activité").click());
  expect(host.querySelector("[data-routines-activite]")).not.toBeNull();
});

it("« Décidé pour toi » se corrige d'ici", async () => {
  await monter();
  expect(host.textContent).toContain("Décidé pour toi");
  await act(async () => bouton("Corriger").click());
  expect(host.querySelector('[role="dialog"]')?.textContent).toContain("Couleur de la campagne");
});

it("sans rien : « Rien pour l'instant »", async () => {
  activite = { taches: [], routines: [], non_vues: 0 };
  await monter();
  expect(host.textContent).toContain("Rien pour l'instant");
});

it("en panne : « Ça n'a pas chargé », et Réessayer relit", async () => {
  echec = true;
  await monter();
  expect(host.textContent).toContain("Ça n'a pas chargé");
  echec = false;
  activite = { taches: [], routines: [], non_vues: 0 };
  await act(async () => bouton("Réessayer").click());
  expect(host.textContent).toContain("Rien pour l'instant");
});

it("en attente de la lecture : une ossature, pas une page vide", async () => {
  vi.mocked(get).mockImplementationOnce(() => new Promise(() => {}));
  await monter();
  expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
});

it("en quittant la page, ce qui y était nouveau est marqué vu : le voyant de la barre s'éteint", async () => {
  await monter();
  await demonter();
  expect(send).toHaveBeenCalledWith("/api/agents/ines/routines-vues", {});
});

it("une proposition restée sans réponse a quitté « Pour toi » : Activité la montre, marquée expirée", async () => {
  activite = { ...(activite as object), propositions_expirees: [{ id: "p1", agent_id: "lea", agent: "Léa", texte: "Je peux trier tes courriels.", cree: 1_700_000_000 }] };
  await monter();
  const ligne = host.querySelector('[data-propositions-expirees] [data-proposition="p1"]')!;
  expect(ligne.querySelector(".row-title")?.textContent).toBe("Je peux trier tes courriels.");
  expect(ligne.querySelector(".row-sub")?.textContent).toBe("Léa · expirée");
  expect(ligne.querySelector("button")).toBeNull(); // plus de Non / Fais-le
});
