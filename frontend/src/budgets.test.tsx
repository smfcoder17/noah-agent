// Budget B1 bis (socle.md, section 6) : les requêtes /api/ de l'ouverture d'un agent, comptées dans jsdom.
// L'application entière est montée avec un faux `fetch` qui note chaque appel. Moins fidèle qu'un navigateur sur le vrai
// serveur (B1, tools/eval/ouverture.mjs), mais ça tourne partout. Le flux /api/events envoie `pret` comme le vrai serveur :
// c'est ce signal qui déclenche la relance générale, donc les doubles.
// Cliquet : tools/eval/budgets.json (tools/eval/cliquet.mjs). Seuil visé : 1 requête au changement d'agent, 4 au chargement, 0 double.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, expect, it, vi } from "vitest";
import { jugerTout } from "../../tools/eval/cliquet.mjs";

vi.hoisted(() => {
  // jsdom n'a ni matchMedia, ni ResizeObserver, ni IntersectionObserver, ni CSS.escape. Écran d'ordinateur : 1280 px, souris.
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

type Appel = { methode: string; chemin: string; requete: string };
const appels: Appel[] = [];
const AGENTS = ["a1", "a2"].map((id, i) => ({ id, name: i ? "Bis" : "Noah", role: "", online: true, step: null, tasks: {}, state: "idle", color: "#c2410c", pinned: false, droit: "proprietaire", partage: false }));
const CONVERSATION = (agent: string) => ({ id: `c-${agent}`, title: "Conversation", updated_at: "2026-11-18 10:00:00", state: "idle", en_cours: false, main: true, archived: false, origin: "user", partagee: false, de: null });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function reponse(chemin: string): Response {
  if (chemin === "/api/status") return json({ has_account: true, model_configured: true, onboarded: true, api: 1, min_client_version: "0.1.0" });
  if (chemin === "/api/me") return json({ id: 1, username: "alice", role: "owner" });
  if (chemin === "/api/agents") return json(AGENTS);
  if (chemin === "/api/events") {
    // Ouvert pour toujours, comme le vrai : un seul signal `pret` au début.
    const octets = new TextEncoder().encode("id: 1\nevent: pret\ndata: {}\n\n");
    return new Response(new ReadableStream({ start: (c) => c.enqueue(octets) }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }
  const conversations = chemin.match(/^\/api\/agents\/(\w+)\/conversations$/);
  if (conversations) return json([CONVERSATION(conversations[1])]);
  if (/\/messages$/.test(chemin)) return json([{ id: 1, role: "agent", text: "Bonjour.", created_at: "2026-11-18 10:00:00" }]);
  if (/\/en-cours$/.test(chemin)) return json({ occupe: false, activite: null, run_id: null, file: [], accord: null });
  if (/\/appel$/.test(chemin)) return json({ appel: null });
  if (chemin === "/api/calls/pending") return json({ appels: [] });
  if (/\/taches-confiees$/.test(chemin)) return json({ taches: [] });
  if (/\/routines$/.test(chemin) || chemin === "/api/accords" || chemin === "/api/a-toi") return json([]);
  if (chemin === "/api/me/interface") return json({});
  if (chemin === "/api/me/alertes-appareils") return json({ alertes: [] });
  return json({ detail: "absent" }, 404);
}

vi.stubGlobal("fetch", vi.fn(async (entree: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof entree === "string" ? entree : entree instanceof URL ? entree.href : entree.url, "http://localhost");
  if (url.pathname.startsWith("/api/")) appels.push({ methode: init?.method ?? "GET", chemin: url.pathname, requete: url.search });
  return reponse(url.pathname);
}));

const attendre = (ms: number) => act(async () => { await new Promise((fini) => setTimeout(fini, ms)); });
/** Jusqu'à 2 s sans nouvelle requête (15 s au plus). */
async function calme() {
  const debut = Date.now();
  for (let vu = -1; Date.now() - debut < 15000;) {
    if (appels.length === vu) return;
    vu = appels.length;
    await attendre(2000);
  }
}
/** Les requêtes /api/ hors flux `events`, et combien sont des doubles (même méthode, même chemin, même requête). */
function compter(depuis: number) {
  const lot = appels.slice(depuis).filter((a) => a.chemin !== "/api/events");
  const vus = new Set<string>();
  let doubles = 0;
  for (const a of lot) {
    const cle = `${a.methode} ${a.chemin}${a.requete}`;
    if (vus.has(cle)) doubles++;
    vus.add(cle);
  }
  return { requetes: lot.length, doubles, liste: lot.map((a) => `${a.methode} ${a.chemin}${a.requete}`) };
}

let unmount = () => {};
afterAll(() => unmount());

it("B1 bis : requêtes à l'ouverture d'un agent, mesurées dans jsdom, contre le cliquet de budgets.json", async () => {
  const { default: App } = await import("./App");
  const hote = document.createElement("div");
  document.body.append(hote);
  const racine = createRoot(hote);
  unmount = () => { act(() => racine.unmount()); hote.remove(); };
  await act(async () => racine.render(<App />));
  await calme();
  const chargement = compter(0);
  expect(hote.textContent, "l'application doit être montée, pas sur une erreur ni sur l'écran de connexion").toContain("Bis");

  const avant = appels.length;
  const ligne = [...hote.querySelectorAll<HTMLButtonElement>("button.agent-nav-row")].find((b) => b.textContent?.includes("Bis"));
  expect(ligne, "le bouton de l'agent « Bis » dans la barre de gauche").toBeTruthy();
  await act(async () => ligne!.click());
  await calme();
  const changement = compter(avant);

  console.log(`B1 bis chargement : ${chargement.liste.join(" | ")}`);
  console.log(`B1 bis changement : ${changement.liste.join(" | ")}`);
  const ok = jugerTout([
    ["B1bis.changement.requetes", changement.requetes],
    ["B1bis.changement.doubles", changement.doubles],
    ["B1bis.chargement.requetes", chargement.requetes],
    ["B1bis.chargement.doubles", chargement.doubles],
  ]);
  expect(ok, "au moins un budget B1 bis est pire que sa mesure gardée (voir les lignes ÉCHEC ci-dessus)").toBe(true);
}, 90000);
