// 0.4.0, lot L1 (b et c) : la ligne de tâche du fil. Repliée (qui, quoi, état), dépliée sur place, on peut y entrer ; la trace d'un fil
// qui n'a pas de tâche se lit avec la même ligne ; le fil place chaque tâche à sa place et l'onglet Tâches lit la même ligne.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { markOf } from "../ConversationRail";
import { avecTaches } from "@/lib/tachesFil";
import type { ChatMessage } from "@/lib/useAgentChat";
import type { TacheDuFil } from "@/lib/ouverture";
import { TacheLigne, TraceOutil } from "./TacheLigne";

vi.mock("../Noah", () => ({ AgentFace: () => null, agentColor: () => "#000" }));
// La ligne de trace lit son groupe dans le fil d'assistant-ui ; ici elle est seule, hors fil.
vi.mock("@assistant-ui/react", async (orig) => ({ ...(await orig<typeof import("@assistant-ui/react")>()), useAuiState: () => JSON.stringify({ premier: false, total: 0, finies: 0 }) }));

let host: HTMLDivElement, root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const tache = (over: Partial<TacheDuFil> = {}): TacheDuFil => ({
  id: "t1", titre: "Rédiger la newsletter de jeudi", genre: "demande", demandeur: { id: "a", nom: "Alma" }, agent: { id: "b", nom: "Basile" }, etat: "encours", resume: "",
  fichiers: [], ancre: 5, cree: 1_700_000_000, fini_a: null, conversation_id: "c1", question: null, ...over,
});
const render = (ui: React.ReactElement) => act(async () => root.render(ui));
const row = () => host.querySelector<HTMLButtonElement>("button[aria-expanded]")!;

it("repliée : le titre, qui travaille et où elle en est, sans le détail", async () => {
  await render(<TacheLigne tache={tache()} agentId="b" agentName="Basile" />);
  expect(host.textContent).toContain("Rédiger la newsletter de jeudi");
  expect(host.textContent).toContain("Basile · en cours");
  expect(row().getAttribute("aria-expanded")).toBe("false");
  expect(host.querySelector("a")).toBeNull();
  expect(host.querySelector("[data-etat]")!.getAttribute("data-etat")).toBe("encours");
});

it("dépliée sur place : le compte rendu, qui l'a confiée, et un lien qui ouvre la tâche", async () => {
  await render(<TacheLigne tache={tache({ etat: "fini", resume: "Le texte est prêt." })} agentId="b" agentName="Basile" />);
  expect(host.textContent).toContain("Basile · terminée");
  await act(async () => row().click());
  expect(row().getAttribute("aria-expanded")).toBe("true");
  expect(host.textContent).toContain("Le texte est prêt.");
  expect(host.textContent).not.toContain("Confiée par"); // la page de la tâche le dit dans son en-tête, la ligne ne le répète pas
  expect(host.querySelector("a")!.getAttribute("href")).toBe("#agent=b&conversation=c1");
  await act(async () => row().click());
  expect(host.querySelector("a")).toBeNull();
});

it("une tâche qui attend la personne s'ouvre d'elle-même ; un échec se dit", async () => {
  await render(<TacheLigne tache={tache({ etat: "attend" })} agentId="b" agentName="Basile" />);
  expect(row().getAttribute("aria-expanded")).toBe("true");
  expect(host.textContent).toContain("Basile · attend ta réponse");
  await render(<TacheLigne tache={tache({ etat: "echec", resume: "Noah a redémarré pendant le travail" })} agentId="b" agentName="Basile" />);
  expect(host.textContent).toContain("Basile · a échoué");
});

it("on entre dans la tâche : par un lien depuis le fil, par un rappel depuis Activité", async () => {
  const onOpen = vi.fn();
  await render(<TacheLigne tache={tache({ etat: "fini", resume: "Fait." })} agentId="b" agentName="Basile" defaultOpen onOpen={onOpen} />);
  expect(host.querySelector("a")).toBeNull();
  const enter = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Ouvrir la tâche"))!;
  await act(async () => enter.click());
  expect(onOpen).toHaveBeenCalledWith("c1");
});

it("la trace d'un fil sans tâche connue se lit avec la même ligne", async () => {
  const args = { fil: "c9", entete: "Alma m'a demandé", consigne: "Vérifie les liens du dernier article", etat: "en_cours", issue: "" };
  await render(<TraceOutil {...(({ args }) as unknown as Parameters<typeof TraceOutil>[0])} />);
  expect(host.textContent).toContain("Vérifie les liens du dernier article");
  expect(host.querySelector("[data-etat]")!.getAttribute("data-etat")).toBe("encours");
});

// --- Le fil place chaque tâche -------------------------------------------------------------------------------------------------

const msg = (storedId: number, role: "user" | "assistant" = "assistant"): ChatMessage => ({ id: `h${storedId}`, role, storedId, content: [{ type: "text", text: `m${storedId}` }] });
const trace = (storedId: number, fil: string): ChatMessage => ({
  id: `h${storedId}`, role: "assistant", storedId, trace: "{}",
  content: [{ type: "tool-call", toolCallId: `t${storedId}`, toolName: "trace", args: { fil, entete: "x", consigne: "y", etat: "fini", issue: "" }, result: true }],
});
const names = (all: ChatMessage[]) => all.map((m) => m.content[0].type === "tool-call" ? (m.content[0] as { toolName: string }).toolName : (m.content[0] as { text: string }).text);

it("une tâche prend la place de sa trace ; la trace d'une tâche inconnue reste", () => {
  const out = avecTaches([msg(1, "user"), trace(2, "c1"), trace(3, "inconnue"), msg(4)], [tache()]);
  expect(names(out)).toEqual(["m1", "tache", "trace", "m4"]);
  expect(out[1].id).toBe("h2"); // la même ligne d'un affichage à l'autre
  expect((out[1].content[0] as unknown as { args: { tache: TacheDuFil } }).args.tache.id).toBe("t1");
  expect(out[1].trace).toBeUndefined();
});

it("une tâche sans trace se place avant le premier message écrit après son ancre, ou en bas", () => {
  const base = [msg(1, "user"), msg(2), msg(6), msg(7)];
  expect(names(avecTaches(base, [tache({ ancre: 5 })]))).toEqual(["m1", "m2", "tache", "m6", "m7"]);
  expect(names(avecTaches(base, [tache({ ancre: 9 })]))).toEqual(["m1", "m2", "m6", "m7", "tache"]);
  expect(names(avecTaches(base, [tache({ id: "t2", ancre: 7, cree: 2 }), tache({ ancre: 7, cree: 1 })]))).toEqual(["m1", "m2", "m6", "m7", "tache", "tache"]);
  const running: ChatMessage[] = [msg(1, "user"), { ...msg(9), running: true }];
  expect(names(avecTaches(running, [tache({ ancre: 9 })]))).toEqual(["m1", "tache", "m9"]); // jamais sous la réponse qui s'écrit
  expect(avecTaches(base, undefined)).toBe(base);
  expect(avecTaches(base, [])).toBe(base);
});

it("la colonne des repères marque une tâche par son titre", () => {
  const [line] = avecTaches([msg(9)], [tache({ ancre: 0 })]);
  expect(markOf(line as never)).toMatchObject({ label: "Rédiger la newsletter de jeudi" });
});

it("la ligne nomme celui qui fait le travail, pas celui dont on lit le fil ni celui qui l'a demandée", async () => {
  await render(<TacheLigne tache={tache({ demandeur: { id: "n", nom: "Noah" }, agent: { id: "h", nom: "Hugo" }, etat: "attend" })} agentId="n" agentName="Noah" />);
  expect(host.textContent).toContain("Hugo · attend ta réponse");
  expect(host.textContent).not.toContain("Noah · attend");
  expect(host.textContent).not.toContain("Confiée par");
});
