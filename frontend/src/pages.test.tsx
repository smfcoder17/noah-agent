// 0.4.2 : une seule page à la fois dans la zone de travail. « Pour toi », Activité, Rechercher, Réglages et la discussion d'un agent se
// remplacent, dans tous les ordres : ouvrir l'une ferme l'autre (retour de Franck : Réglages puis Pour toi s'affichaient l'un sur l'autre).
// L'application entière est montée sur un faux serveur, comme budgets.test.tsx ; on clique la barre de gauche, comme on le fait à la main.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, expect, it, vi } from "vitest";

vi.hoisted(() => {
  const wide = (q: string) => /min-width/.test(q) || /pointer:\s*fine/.test(q);
  window.matchMedia = ((query: string) => ({ matches: wide(query), media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false })) as typeof window.matchMedia;
  const Observer = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
  globalThis.ResizeObserver ??= Observer as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver ??= Observer as unknown as typeof IntersectionObserver;
  globalThis.CSS ??= { escape: (s: string) => s.replace(/[^\w-]/g, "\\$&") } as unknown as typeof CSS;
  Element.prototype.scrollTo ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
  window.scrollTo = (() => {}) as typeof window.scrollTo;
});

const AGENTS = ["a1", "a2"].map((id, i) => ({ id, name: i ? "Bis" : "Noah", role: "", online: true, step: null, tasks: {}, state: "idle", color: "#c2410c", pinned: false, droit: "proprietaire", partage: false }));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
function reponse(chemin: string): Response {
  if (chemin === "/api/status") return json({ has_account: true, model_configured: true, onboarded: true, api: 1, min_client_version: "0.1.0" });
  if (chemin === "/api/me") return json({ id: 1, username: "alice", role: "owner" });
  if (chemin === "/api/agents") return json(AGENTS);
  if (chemin === "/api/events") {
    const octets = new TextEncoder().encode("id: 1\nevent: pret\ndata: {}\n\n");
    return new Response(new ReadableStream({ start: (c) => c.enqueue(octets) }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }
  const conversations = chemin.match(/^\/api\/agents\/(\w+)\/conversations$/);
  if (conversations) return json([{ id: `c-${conversations[1]}`, title: "Conversation", updated_at: "2026-11-18 10:00:00", state: "idle", en_cours: false, main: true, archived: false, origin: "user", partagee: false, de: null }]);
  if (/\/messages$/.test(chemin)) return json([{ id: 1, role: "agent", text: "Bonjour.", created_at: "2026-11-18 10:00:00" }]);
  if (/\/en-cours$/.test(chemin)) return json({ occupe: false, activite: null, run_id: null, file: [], accord: null });
  if (/\/appel$/.test(chemin)) return json({ appel: null });
  if (chemin === "/api/calls/pending") return json({ appels: [] });
  if (/\/taches-confiees$/.test(chemin)) return json({ taches: [] });
  if (chemin === "/api/activite") return json({ taches: [], routines: [], non_vues: 0, propositions_expirees: [] });
  if (chemin === "/api/recherche") return json({ q: "", total: 0, agents: [] });
  if (/\/routines$/.test(chemin) || chemin === "/api/accords" || chemin === "/api/a-toi") return json([]);
  if (chemin === "/api/me/interface") return json({});
  if (chemin === "/api/me/alertes-appareils") return json({ alertes: [] });
  return json({ detail: "absent" }, 404);
}
vi.stubGlobal("fetch", vi.fn(async (entree: RequestInfo | URL) => reponse(new URL(typeof entree === "string" ? entree : entree instanceof URL ? entree.href : entree.url, "http://localhost").pathname)));

const attendre = (ms = 60) => act(async () => { await new Promise((fini) => setTimeout(fini, ms)); });
let unmount = () => {};
afterAll(() => unmount());

const PAGES = ["Pour toi", "Activité", "Rechercher", "Réglages"] as const;
type Geste = (typeof PAGES)[number] | "discussion";
const GESTES: Geste[] = [...PAGES, "discussion"];

it("une seule page à la fois : toutes les paires de pages et la discussion d'un agent, dans les deux ordres", async () => {
  const { default: App } = await import("./App");
  const hote = document.createElement("div");
  document.body.append(hote);
  const racine = createRoot(hote);
  unmount = () => { act(() => racine.unmount()); hote.remove(); };
  await act(async () => racine.render(<App />));
  await attendre(400);
  expect(hote.textContent).toContain("Bis");

  const ouvertes = () => PAGES.filter((nom) => hote.querySelector(`main.chat-pane[aria-label="${nom}"]`));
  const cliquer = async (geste: Geste) => {
    const bouton = geste === "discussion"
      ? [...hote.querySelectorAll<HTMLButtonElement>("button.agent-nav-row")].find((b) => b.textContent?.includes("Noah"))
      : [...hote.querySelectorAll<HTMLButtonElement>("aside.side-rail button.rail-row")].find((b) => b.textContent?.trim().startsWith(geste));
    expect(bouton, `le bouton « ${geste} » de la barre de gauche`).toBeTruthy();
    await act(async () => bouton!.click());
    await attendre();
  };
  /** Attend que la page voulue soit montée (elles se chargent à la demande), puis rend ce qui est ouvert. */
  const apres = async (attendu: string[]) => { for (let i = 0; i < 60 && ouvertes().join() !== attendu.join(); i++) await attendre(50); return ouvertes(); };
  const ordres: string[] = [];
  for (const a of GESTES) for (const b of GESTES) {
    await cliquer(a);
    await cliquer(b);
    const attendu = b === "discussion" ? [] : [b];
    ordres.push(`${a} puis ${b}`);
    expect(await apres(attendu), `${a} puis ${b}`).toEqual(attendu);
  }
  // Trois à la suite, dans l'ordre que Franck a vu superposer.
  for (const suite of [["Réglages", "Pour toi", "Rechercher"], ["Réglages", "Pour toi", "Activité"], ["Pour toi", "Réglages", "Rechercher"], ["Rechercher", "Réglages", "Pour toi"]] as Geste[][]) {
    for (const g of suite) await cliquer(g);
    expect(await apres([suite[suite.length - 1]]), suite.join(" puis ")).toEqual([suite[suite.length - 1]]);
  }
  // Ctrl K ouvre la recherche, par-dessus n'importe quelle page.
  await cliquer("Réglages");
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true })); });
  await attendre();
  expect(await apres(["Rechercher"])).toEqual(["Rechercher"]);
  expect(ordres.length).toBe(25);
}, 120000);
