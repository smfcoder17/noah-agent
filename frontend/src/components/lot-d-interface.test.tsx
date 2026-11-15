// 0.3.0, lots D et E : barre du haut à droite, panneau de droite, fichiers en arbre avec aperçu, session, barre de gauche repliable,
// menu « … » du téléphone. Scénarios du plan (docs/epics/0.3.0/plan-0.3.0.md, « Lot D », « Lot E »).
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Agent, WorkspaceFile } from "@/lib/api";

vi.mock("./Noah", () => ({ AgentFace: ({ agent, bare, className }: { agent: Agent; bare?: boolean; className?: string }) => <span data-agent={agent.id} data-bare={String(!!bare)} className={className} />, agentColor: () => "#000" }));
vi.mock("./Widgets", () => ({ Chart: () => null }));
vi.mock("@/lib/platform", () => ({ appShell: () => null, elementAction: vi.fn(), inAndroidApp: () => false, nativeElement: () => false }));
vi.mock("@/lib/events", () => ({ subscribeUpdates: () => () => {} }));
const files: WorkspaceFile[] = [
  { path: "outputs/rapport.md", size: 120, modified: 1_700_000_300 },
  { path: "outputs/graphe.png", size: 2048, modified: 1_700_000_200 },
  { path: "outputs/notes/facture.pdf", size: 4096, modified: 1_700_000_100 },
  { path: "apps/site/index.html", size: 64, modified: 1_700_000_050 },
];
const state = { session: { travaux: [], processus: [], demandes: [], confiees: [], routines: [] } as Record<string, unknown[]> };
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  get: vi.fn(async (path: string) => (path.endsWith("/files") ? files : path.endsWith("/session") ? structuredClone(state.session) : [])),
  send: vi.fn(async () => ({})),
}));

import { WorkBar, WorkMenu } from "./WorkBar";
import { WorkPanel } from "./WorkPanel";
import { Files } from "./Files";
import { Session, SESSION_POLL } from "./Session";
import { SideRail } from "./desktop/SideRail";
import { MobileHeader } from "./mobile/MobileHeader";
import { RAIL_KEY, panelDefault } from "@/lib/workPanel";
import { SEEN } from "@/lib/seen";
import type { PanelTab } from "./SidePanel";

let host: HTMLDivElement, root: Root, wide = true;
beforeEach(() => {
  wide = true;
  window.matchMedia = ((q: string) => ({ matches: q.includes("max-width") ? !wide : wide, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1600 });
  localStorage.clear(); localStorage.setItem("noah-langue", "fr");
  SEEN.clear();
  state.session = { travaux: [], processus: [], demandes: [], confiees: [], routines: [] };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); document.body.innerHTML = ""; });

const agent = (over: Partial<Agent> = {}) => ({ id: "a", name: "Noah", online: true, state: "idle", tasks: {}, droit: "proprietaire", color: "#000", pinned: false, partage: false, role: "", step: null, ...over }) as Agent;
const byLabel = (label: string) => document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
const press = async (key: string, target: EventTarget = window) => act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
/** Attend un élément (l'aperçu est chargé à la demande) : jusqu'à deux secondes. */
const until = async (selector: string) => {
  for (let i = 0; i < 100 && !host.querySelector(selector); i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  await settle();
  expect(host.querySelector(selector), selector).not.toBeNull();
};

it("D1 — chaque icône du haut à droite dit son nom en infobulle et ouvre son panneau", async () => {
  const open = vi.fn(), details = vi.fn();
  await act(async () => root.render(<WorkBar agent={agent()} active={null} onOpen={open} details={false} onDetails={details} />));
  const icons = [...host.querySelectorAll<HTMLButtonElement>(".work-bar button")];
  expect(icons.map((b) => b.getAttribute("aria-label"))).toEqual(["Activité", "Tâches", "Fichiers", "Ordinateur", "Session", "Détails techniques"]);
  for (const b of icons) {
    const tip = document.getElementById(b.getAttribute("aria-describedby")!)!;
    expect(tip.getAttribute("role")).toBe("tooltip");
    expect(tip.textContent).toBe(b.getAttribute("aria-label")); // l'infobulle dit le nom, sans autre texte visible
    expect(b.textContent).toBe(tip.textContent); // icône seule : aucun libellé hors de l'infobulle
  }
  const tabs: PanelTab[] = ["activity", "routines", "files", "computer", "session"];
  for (const [i, tab] of tabs.entries()) { await act(async () => icons[i].click()); expect(open).toHaveBeenLastCalledWith(tab); }
  await act(async () => icons[5].click());
  expect(details).toHaveBeenCalledWith(true);
  // L'icône du panneau ouvert est marquée ; les détails sont un interrupteur.
  await act(async () => root.render(<WorkBar agent={agent()} active="files" onOpen={open} details onDetails={details} />));
  expect(byLabel("Fichiers")!.getAttribute("aria-current")).toBe("true");
  expect(byLabel("Activité")!.getAttribute("aria-current")).toBeNull();
  expect(byLabel("Détails techniques")!.getAttribute("aria-pressed")).toBe("true");
});

it("D1 — un profil partagé en simple lecture ne voit que ce qu'il peut ouvrir", async () => {
  await act(async () => root.render(<WorkBar agent={agent({ droit: "lecture" })} active={null} onOpen={vi.fn()} details={false} onDetails={vi.fn()} />));
  expect([...host.querySelectorAll(".work-bar button")].map((b) => b.getAttribute("aria-label"))).toEqual(["Activité", "Session", "Détails techniques"]);
});

function Panel({ onClose = vi.fn(), tab = "files" as PanelTab }) {
  const [expanded, setExpanded] = useState(false);
  return <WorkPanel open tab={tab} title="Fichiers" expanded={expanded} onExpand={setExpanded} onClose={onClose}><p>contenu</p></WorkPanel>;
}

it("D2 — Échap ferme le panneau, sauf quand une couche est posée dessus", async () => {
  const close = vi.fn();
  await act(async () => root.render(<Panel onClose={close} />));
  const panel = host.querySelector<HTMLElement>("aside.work-panel")!;
  expect(panel.getAttribute("aria-label")).toBe("Fichiers");
  expect(document.activeElement).toBe(panel); // ouvert au clavier : le focus y entre
  const dialog = document.createElement("div"); dialog.setAttribute("role", "dialog"); document.body.append(dialog);
  await press("Escape");
  expect(close).not.toHaveBeenCalled();
  dialog.remove();
  await press("Escape");
  expect(close).toHaveBeenCalledTimes(1);
  await act(async () => byLabel("Fermer le panneau")!.click());
  expect(close).toHaveBeenCalledTimes(2);
});

it("D2 — plein écran puis retour ; largeur réglable au clavier et retenue", async () => {
  await act(async () => root.render(<Panel />));
  const panel = () => host.querySelector<HTMLElement>("aside.work-panel")!;
  expect(panel().style.width).toBe(`${panelDefault("files")}px`);
  const grip = host.querySelector<HTMLElement>('[role="separator"]')!;
  expect(grip.getAttribute("aria-label")).toBe("Largeur du panneau");
  expect(grip.tabIndex).toBe(0);
  await press("ArrowLeft", grip);
  expect(panel().style.width).toBe(`${panelDefault("files") + 32}px`);
  expect(localStorage.getItem("noah:panneau")).toBe(String(panelDefault("files") + 32));
  await act(async () => byLabel("Étendre sur toute la page")!.click());
  expect(panel().classList.contains("is-expanded")).toBe(true);
  expect(panel().style.width).toBe("");
  expect(host.querySelector('[role="separator"]')).toBeNull();
  await act(async () => byLabel("Réduire le panneau")!.click());
  expect(panel().classList.contains("is-expanded")).toBe(false);
  // Rouvert : la largeur choisie revient ; l'ordinateur a la sienne, plus large par défaut.
  await act(async () => root.unmount()); root = createRoot(host);
  await act(async () => root.render(<Panel />));
  expect(panel().style.width).toBe(`${panelDefault("files") + 32}px`);
  await act(async () => root.render(<Panel tab="computer" />));
  expect(panelDefault("computer")).toBeGreaterThan(panelDefault("files"));
  expect(panel().style.width).toBe(`${panelDefault("computer")}px`);
});

it("D2/E1 — sur un téléphone, le panneau est une feuille avec Retour, sans poignée ni plein écran", async () => {
  wide = false;
  const close = vi.fn();
  await act(async () => root.render(<Panel onClose={close} />));
  expect(host.querySelector('[role="separator"]')).toBeNull();
  expect(byLabel("Étendre sur toute la page")).toBeNull();
  await act(async () => byLabel("Retour")!.click());
  expect(close).toHaveBeenCalled();
});

it("D3 — arbre : dossiers dépliables, filtre, aperçu Markdown, image et PDF dans le panneau", async () => {
  const fetchMock = vi.fn(async () => new Response("# Titre du rapport\n\nTexte **gras**", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  try {
    await act(async () => root.render(<Files agentId="a" refreshKey={0} canDelete onGiven={vi.fn()} />));
    await settle();
    const folder = (name: string) => [...host.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find((b) => b.textContent?.includes(name))!;
    // Livrables s'ouvre de lui-même ; Applications est replié, son icône de dossier fermée.
    expect(folder("Livrables").getAttribute("aria-expanded")).toBe("true");
    expect(folder("Applications").getAttribute("aria-expanded")).toBe("false");
    expect(host.textContent).not.toContain("index.html");
    await act(async () => folder("Applications").click());
    expect(folder("Applications").getAttribute("aria-expanded")).toBe("true");
    await act(async () => folder("site").click());
    expect(host.textContent).toContain("index.html");
    // Le filtre ne garde que ce qui correspond, dossiers dépliés.
    const filter = host.querySelector<HTMLInputElement>('[aria-label="Chercher un fichier"]')!;
    await act(async () => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!; set.call(filter, "facture"); filter.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(host.textContent).toContain("facture.pdf");
    expect(host.textContent).not.toContain("rapport.md");
    await act(async () => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!; set.call(filter, ""); filter.dispatchEvent(new Event("input", { bubbles: true })); });

    // Markdown : rendu dans le panneau, pas téléchargé.
    await act(async () => byLabel("Aperçu de rapport.md")!.click());
    await until(".file-preview h1");
    const preview = host.querySelector<HTMLElement>(".file-preview")!;
    expect(preview.getAttribute("aria-label")).toBe("Aperçu de rapport.md");
    expect(fetchMock).toHaveBeenCalledWith("/api/agents/a/files/raw/outputs/rapport.md", expect.anything());
    expect(preview.querySelector("h1")?.textContent).toBe("Titre du rapport");
    expect(preview.querySelector("strong")?.textContent).toBe("gras");
    await act(async () => byLabel("Retour aux fichiers")!.click());
    expect(host.querySelector(".file-preview")).toBeNull();
    expect(folder("Applications").getAttribute("aria-expanded")).toBe("true"); // l'arbre est resté tel qu'on l'a laissé

    // Image : affichée telle quelle.
    await act(async () => byLabel("Aperçu de graphe.png")!.click());
    await until(".file-preview img");
    expect(host.querySelector<HTMLImageElement>(".file-preview img")?.getAttribute("src")).toBe("/api/agents/a/files/raw/outputs/graphe.png");
    await act(async () => byLabel("Retour aux fichiers")!.click());

    // PDF : dans un cadre sans accès à la session, une fois son sous-dossier déplié.
    await act(async () => folder("notes").click());
    await act(async () => byLabel("Aperçu de facture.pdf")!.click());
    await until(".file-preview iframe");
    const frame = host.querySelector<HTMLIFrameElement>(".file-preview iframe")!;
    expect(frame.getAttribute("src")).toContain("/api/agents/a/files/raw/outputs/notes/facture.pdf");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    await act(async () => byLabel("Retour aux fichiers")!.click());

    // HTML : rendu en bac à sable, depuis le bouton Ouvrir de l'application.
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Ouvrir")!.click());
    await until(".file-preview iframe");
    const page = host.querySelector<HTMLIFrameElement>(".file-preview iframe")!;
    expect(page.getAttribute("src")).toBe("/api/agents/a/files/raw/apps/site/index.html");
    expect(page.getAttribute("sandbox")).toBe("allow-scripts");
  } finally { vi.unstubAllGlobals(); }
});

it("D4 — session : une tâche lancée apparaît en moins de 3 s, disparaît à sa fin ; un fichier récent s'ouvre en aperçu", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("du texte", { status: 200 })));
  const openThread = vi.fn();
  try {
    await act(async () => root.render(<Session agentId="a" withFiles refreshKey={0} onOpenThread={openThread} />));
    await settle();
    expect(host.textContent).toContain("Rien en cours.");
    expect(SESSION_POLL).toBeLessThan(3000);
    state.session = {
      travaux: [{ id: "c1", titre: "Prépare le rapport", origine: "user", main: false, etat: "work", activite: "Lit rapport.md" }],
      processus: [{ id: "p1", titre: "Lance npm", debut: Date.now() / 1000 - 125, conversation_id: "c1" }],
      demandes: [{ id: "d1", agent: "Veille", titre: "Surveille les prix", debut: Date.now() / 1000 }],
      confiees: [{ id: "t1", outil: "claude", etat: "en_cours", dossier: "site", appareil: "PC", duree_s: 30, progression: [], offre: "Pro" }],
      routines: [{ id: "r1", titre: "Revue du matin", depuis: null }],
    };
    await act(async () => { vi.advanceTimersByTime(SESSION_POLL); });
    await settle();
    const rows = [...host.querySelectorAll<HTMLElement>("[data-session]")];
    expect(rows.map((r) => r.dataset.session)).toEqual(["w", "p", "r", "d", "c"]);
    expect(rows[0].textContent).toContain("Prépare le rapport");
    expect(rows[0].textContent).toContain("Lit rapport.md");
    expect(rows[1].textContent).toContain("Processus en arrière-plan · depuis 2 min");
    expect(rows[2].textContent).toContain("Routine en cours");
    expect(rows[3].textContent).toContain("Demande à Veille");
    expect(rows[4].textContent).toContain("Tâche confiée à Claude Code sur PC");
    expect(host.querySelector('[aria-label="5 en cours"]')).not.toBeNull();
    await act(async () => rows[0].querySelector("button")!.click());
    expect(openThread).toHaveBeenCalledWith("c1");
    // Fin du travail : au relevé suivant, la ligne part.
    state.session = { travaux: [], processus: [], demandes: [], confiees: [], routines: [] };
    await act(async () => { vi.advanceTimersByTime(SESSION_POLL); });
    await settle();
    expect(host.querySelectorAll("[data-session]")).toHaveLength(0);
    // Derniers fichiers, du plus récent au plus ancien ; un clic ouvre l'aperçu sans quitter la session.
    const recent = [...host.querySelectorAll<HTMLButtonElement>('[aria-labelledby="session-files"] button')];
    expect(recent.map((b) => b.title)).toEqual(files.map((f) => f.path));
    await act(async () => recent[0].click());
    await until(".file-preview .element-viewer");
    expect(host.querySelector(".file-preview")?.getAttribute("data-preview")).toBe("outputs/rapport.md");
    await act(async () => byLabel("Retour à la session")!.click());
    expect(host.querySelector(".session-bar")).not.toBeNull();
  } finally { vi.unstubAllGlobals(); }
});

const railProps = { agent: agent(), agents: [agent(), agent({ id: "b", name: "Veille" })], conversations: [], onAgent: vi.fn(), onPickAgent: vi.fn(), onMenu: vi.fn(), onThread: vi.fn(), onSettings: vi.fn(), onGoals: vi.fn() };

it("D5 — barre de gauche minimale : grand visage sans tuile, nom, état, réglages à côté, plus de sous-menu", async () => {
  const page = vi.fn();
  await act(async () => root.render(<SideRail {...railProps} onAgent={page} />));
  const hero = host.querySelector<HTMLElement>(".agent-nav-item.is-hero")!;
  expect(hero.querySelector("[data-agent]")!.getAttribute("data-bare")).toBe("true");
  expect(hero.querySelector("[data-agent]")!.className).toContain("agent-nav-hero-face");
  expect(hero.textContent).toContain("Noah");
  expect(hero.textContent).toContain("Disponible");
  expect(host.querySelector('[data-agent="b"]')!.getAttribute("data-bare")).toBe("false");
  await act(async () => byLabel("Page de Noah")!.click());
  expect(page).toHaveBeenCalled();
  for (const label of ["Discussion", "Activité", "Tâches", "Fichiers", "Ordinateur"]) expect(host.textContent).not.toContain(label);
  expect(host.querySelector('[role="group"]')).toBeNull();
});

it("D5 — repliée en icônes seules, et toujours repliée après rechargement", async () => {
  await act(async () => root.render(<SideRail {...railProps} />));
  const rail = () => host.querySelector<HTMLElement>("aside.side-rail")!;
  expect(rail().classList.contains("is-folded")).toBe(false);
  await act(async () => byLabel("Replier la barre")!.click());
  expect(rail().classList.contains("is-folded")).toBe(true);
  expect(localStorage.getItem(RAIL_KEY)).toBe("1");
  // Repliée, chaque entrée garde son nom (accessible et en infobulle).
  for (const label of ["À toi", "Objectifs", "Rechercher", "Réglages"]) expect(byLabel(label)?.getAttribute("title")).toBe(label);
  await act(async () => root.unmount()); root = createRoot(host); // rechargement
  await act(async () => root.render(<SideRail {...railProps} />));
  expect(rail().classList.contains("is-folded")).toBe(true);
  expect(byLabel("Déplier la barre")!.getAttribute("aria-expanded")).toBe("false");
  await act(async () => byLabel("Déplier la barre")!.click());
  expect(rail().classList.contains("is-folded")).toBe(false);
  expect(localStorage.getItem(RAIL_KEY)).toBe("0");
  // La grille suit la largeur de la barre repliée (règles sources : jsdom ne calcule pas les tailles).
  const desktop = readFileSync("src/styles/desktop.css", "utf8"), shell = readFileSync("src/styles/shell.css", "utf8");
  expect(desktop).toContain(":root:has(.side-rail.is-folded) { --rail-width:68px; }");
  expect(shell).toContain("grid-template-columns:var(--rail-width) minmax(0,1fr)");
});

it("E1 — téléphone : les mêmes entrées dans un menu « … » en haut à droite, au clavier aussi", async () => {
  wide = false;
  const open = vi.fn();
  await act(async () => root.render(<MobileHeader agent={agent()} status="En ligne" onMenu={vi.fn()} onAgent={vi.fn()} onNew={vi.fn()}
    menu={<WorkMenu agent={agent()} active={null} onOpen={open} details={false} onDetails={vi.fn()} />} />));
  const more = byLabel("Contenus de l'agent")!;
  expect(host.querySelector("header")!.lastElementChild!.contains(more)).toBe(true); // tout à droite
  expect(more.getAttribute("aria-expanded")).toBe("false");
  await act(async () => more.click());
  const items = [...host.querySelectorAll<HTMLButtonElement>('[role="menu"] button')];
  expect(items.map((b) => b.textContent)).toEqual(["Activité", "Tâches", "Fichiers", "Ordinateur", "Session", "Détails techniques"]);
  expect(document.activeElement).toBe(items[0]);
  await press("ArrowDown", items[0]);
  expect(document.activeElement).toBe(items[1]);
  await act(async () => items[2].click());
  expect(open).toHaveBeenCalledWith("files");
  expect(host.querySelector('[role="menu"]')).toBeNull();
  await act(async () => more.click());
  await press("Escape");
  expect(host.querySelector('[role="menu"]')).toBeNull();
});

it("E2 — cibles tactiles du téléphone : 44 px au moins", () => {
  const shell = readFileSync("src/styles/shell.css", "utf8");
  expect(shell).toContain(".mobile-header .shell-icon { width:44px; height:44px; min-width:44px; }");
  expect(shell).toContain(".work-panel-head .shell-icon { width:44px; height:44px; min-width:44px; }");
  expect(shell).toMatch(/\.work-menu-list button \{[^}]*min-height:48px/);
  expect(shell).toMatch(/\.session-row \{[^}]*min-height:44px/);
});
