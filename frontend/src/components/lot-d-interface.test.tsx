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
import { ONGLETS_VISIBLES, WorkPanel } from "./WorkPanel";
import { Files } from "./Files";
import { Session, SESSION_POLL } from "./Session";
import { SideRail } from "./desktop/SideRail";
import { MobileHeader } from "./mobile/MobileHeader";
import { RAIL_KEY, MODE_VOCAL, PANEL_NAMES, panelDefault, workTabsFor } from "@/lib/workPanel";
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
/** Les onglets et le bouton des détails que le panneau reçoit de l'application. */
const panelProps = (tab: PanelTab) => ({ tabs: [{ tab, label: PANEL_NAMES[tab] }], onTab: vi.fn(), details: false, onDetails: vi.fn() });
const byLabel = (label: string) => document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
const press = async (key: string, target: EventTarget = window) => act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
/** Attend un élément (l'aperçu est chargé à la demande) : jusqu'à deux secondes. */
const until = async (selector: string) => {
  for (let i = 0; i < 100 && !host.querySelector(selector); i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  await settle();
  expect(host.querySelector(selector), selector).not.toBeNull();
};

it("D1 — en haut à droite : appeler l'agent, son ordinateur, ouvrir ou fermer le panneau", async () => {
  const open = vi.fn(), called = vi.fn();
  window.addEventListener(MODE_VOCAL, called);
  await act(async () => root.render(<WorkBar agent={agent()} active={null} onOpen={open} />));
  const icons = [...host.querySelectorAll<HTMLButtonElement>(".work-bar button")];
  expect(icons.map((b) => b.getAttribute("aria-label"))).toEqual(["Appeler Noah", "Ordinateur de Noah", "Ouvrir ou fermer le panneau"]);
  for (const b of icons) expect(b.textContent).toBe(""); // icône seule : le nom est dans aria-label et title
  await act(async () => icons[0].click());
  expect(called).toHaveBeenCalledTimes(1); // l'appel est le mode vocal, qui était à côté de la saisie
  await act(async () => icons[1].click());
  expect(open).toHaveBeenLastCalledWith("computer"); // l'écran de l'agent en un clic
  await act(async () => icons[2].click());
  expect(open).toHaveBeenLastCalledWith("activity");
  // Panneau ouvert : le bouton est marqué et rend l'onglet courant (App le referme).
  await act(async () => root.render(<WorkBar agent={agent()} active="files" onOpen={open} />));
  expect(byLabel("Ouvrir ou fermer le panneau")!.getAttribute("aria-pressed")).toBe("true");
  await act(async () => byLabel("Ouvrir ou fermer le panneau")!.click());
  expect(open).toHaveBeenLastCalledWith("files");
  // Sur ordinateur, la recherche est la première icône (comme dans le prototype) ; elle ouvre la même recherche que Ctrl K.
  const search = vi.fn();
  await act(async () => root.render(<WorkBar agent={agent()} active={null} onOpen={open} onSearch={search} />));
  expect([...host.querySelectorAll(".work-bar button")].map((b) => b.getAttribute("aria-label"))).toEqual(["Rechercher", "Appeler Noah", "Ordinateur de Noah", "Ouvrir ou fermer le panneau"]);
  await act(async () => byLabel("Rechercher")!.click());
  expect(search).toHaveBeenCalledTimes(1);
  window.removeEventListener(MODE_VOCAL, called);
});

it("D1 — les contenus de l'agent sont les onglets du panneau, dans l'ordre ; les détails techniques y ont leur interrupteur", async () => {
  const onTab = vi.fn(), onDetails = vi.fn();
  const tabs = workTabsFor(agent());
  expect(tabs.map((t) => t.label)).toEqual(["Travail", "Routines", "Fichiers", "Ordinateur", "Session"]);
  await act(async () => root.render(<WorkPanel open tab="files" title="Fichiers" tabs={tabs} onTab={onTab} details={false} onDetails={onDetails} expanded={false} onExpand={vi.fn()} onClose={vi.fn()}><p>contenu</p></WorkPanel>));
  const seg = [...host.querySelectorAll<HTMLButtonElement>('.panel-tabs [role="tab"]')];
  // Trois onglets tiennent sur une ligne à la largeur d'origine ; les moins utilisés sont dans « Plus » (jamais de défilement caché).
  expect(ONGLETS_VISIBLES).toBe(3);
  expect(seg.map((b) => b.textContent)).toEqual(["Travail", "Routines", "Fichiers"]);
  const plus = host.querySelector<HTMLButtonElement>("[data-plus]")!;
  expect(plus.textContent).toBe("Plus …");
  expect(seg[2].getAttribute("aria-selected")).toBe("true");
  const expected: PanelTab[] = ["activity", "routines", "files"];
  for (const [i, tab] of expected.entries()) { await act(async () => seg[i].click()); expect(onTab).toHaveBeenLastCalledWith(tab); }
  await act(async () => plus.click());
  const menu = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  expect(menu.map((m) => m.textContent)).toEqual(["Ordinateur", "Session"]);
  await act(async () => menu[0].click());
  expect(onTab).toHaveBeenLastCalledWith("computer");
  await act(async () => byLabel("Détails techniques")!.click());
  expect(onDetails).toHaveBeenCalledWith(true);
});

it("D1 — un profil partagé en simple lecture ne voit que les onglets qu'il peut ouvrir", () => {
  expect(workTabsFor(agent({ droit: "lecture" })).map((t) => t.label)).toEqual(["Travail", "Session"]);
});

function Panel({ onClose = vi.fn(), tab = "files" as PanelTab }) {
  const [expanded, setExpanded] = useState(false);
  return <WorkPanel open tab={tab} title="Fichiers" {...panelProps(tab)} expanded={expanded} onExpand={setExpanded} onClose={onClose}><p>contenu</p></WorkPanel>;
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

    // PDF : dans un cadre sans accès à la session (CSP inerte côté serveur), une fois son sous-dossier déplié.
    await act(async () => folder("notes").click());
    await act(async () => byLabel("Aperçu de facture.pdf")!.click());
    await until(".file-preview iframe");
    const frame = host.querySelector<HTMLIFrameElement>(".file-preview iframe")!;
    expect(frame.getAttribute("src")).toContain("/api/agents/a/files/raw/outputs/notes/facture.pdf");
    expect(frame.hasAttribute("sandbox")).toBe(false); // hors bac à sable : le lecteur de PDF du navigateur refuse un cadre isolé (le serveur donne un CSP inerte)
    await act(async () => byLabel("Retour aux fichiers")!.click());

    // HTML : rendu en bac à sable, depuis le bouton Ouvrir de l'application.
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Ouvrir")!.click());
    await until(".file-preview iframe");
    const page = host.querySelector<HTMLIFrameElement>(".file-preview iframe")!;
    expect(page.getAttribute("src")).toBe("/api/agents/a/files/raw/apps/site/index.html");
    expect(page.getAttribute("sandbox")).toBe("allow-scripts");
  } finally { vi.unstubAllGlobals(); }
// Quatre aperçus chargés à la demande, deux secondes d'attente chacun au plus : sur un poste chargé, les 5 s par défaut n'y suffisent pas,
// et le test coupé en route fait tomber les onze suivants.
}, 30_000);

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

const railProps = { agent: agent(), agents: [agent(), agent({ id: "b", name: "Veille" })], conversations: [], onAgent: vi.fn(), onPickAgent: vi.fn(), onSearch: vi.fn(), onThread: vi.fn(), onSettings: vi.fn(), onGoals: vi.fn() };

it("D5 — barre de gauche du prototype : nom et repli en haut, entrées, agents avec leur visage, état et pastille, trois petits points, plus de sous-menu", async () => {
  const page = vi.fn();
  await act(async () => root.render(<SideRail {...railProps} onAgentPage={page} />));
  expect(host.querySelector(".rail-top .rail-brand")!.textContent).toBe("Noah");
  expect(host.querySelector(".agent-nav-item.is-hero")).toBeNull(); // plus de grand visage : le visage à taille de ligne
  const first = host.querySelector<HTMLElement>(".agent-nav-item")!;
  expect(first.querySelector("svg")).not.toBeNull(); // le visage animé de l'agent, pas une lettre (demande de Franck avant la 0.4.0)
  expect(first.textContent).toContain("Noah");
  expect(first.textContent).toContain("Disponible");
  expect(first.querySelector(".dot")).not.toBeNull();
  expect(byLabel("Page de Noah")).toBeNull(); // plus d'icône de réglages
  await act(async () => byLabel("Menu de Noah")!.click());
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent === "Page de Noah")!.click());
  expect(page).toHaveBeenCalledWith("a");
  for (const label of ["Discussion", "Tâches", "Fichiers", "Ordinateur"]) expect(host.textContent).not.toContain(label);
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
  for (const label of ["Pour toi", "Activité", "Rechercher", "Réglages"]) expect(byLabel(label)?.getAttribute("title")).toBe(label);
  await act(async () => root.unmount()); root = createRoot(host); // rechargement
  await act(async () => root.render(<SideRail {...railProps} />));
  expect(rail().classList.contains("is-folded")).toBe(true);
  expect(byLabel("Déplier la barre")!.getAttribute("aria-expanded")).toBe("false");
  await act(async () => byLabel("Déplier la barre")!.click());
  expect(rail().classList.contains("is-folded")).toBe(false);
  expect(localStorage.getItem(RAIL_KEY)).toBe("0");
  // La grille suit la largeur de la barre repliée (règles sources : jsdom ne calcule pas les tailles).
  const shell = readFileSync("src/styles/shell.css", "utf8");
  expect(readFileSync("src/styles/fil-calme.css", "utf8")).toContain(":root:has(.side-rail.is-folded) { --rail-width:var(--rail); }");
  expect(shell).toContain("grid-template-columns:var(--rail-width) minmax(0,1fr)");
});

it("E1 — téléphone : Pour toi (avec son nombre), appeler, l'ordinateur et le panneau, tout à droite de l'en-tête", async () => {
  wide = false;
  const open = vi.fn(), inbox = vi.fn();
  await act(async () => root.render(<MobileHeader agent={agent()} status="En ligne" onMenu={vi.fn()} onAgent={vi.fn()}
    menu={<WorkMenu agent={agent()} active={null} onOpen={open} waiting={2} onInbox={inbox} />} />));
  const bar = host.querySelector("header")!.lastElementChild!;
  expect(bar.classList.contains("work-bar")).toBe(true); // tout à droite
  expect([...bar.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["Pour toi2", "Appeler Noah", "Ordinateur de Noah", "Ouvrir ou fermer le panneau"]);
  await act(async () => bar.querySelector<HTMLButtonElement>(".pour-toi-pill")!.click());
  expect(inbox).toHaveBeenCalledTimes(1);
  await act(async () => byLabel("Ouvrir ou fermer le panneau")!.click());
  expect(open).toHaveBeenCalledWith("activity");
  // Rien à attendre : pas de pastille.
  await act(async () => root.render(<WorkMenu agent={agent()} active={null} onOpen={open} waiting={0} onInbox={inbox} />));
  expect(host.querySelector(".pour-toi-pill")).toBeNull();
});

it("L9b — téléphone : sur une page (Activité, Réglages, Pour toi), l’en-tête porte le titre de la page, pas l’agent", async () => {
  wide = false;
  await act(async () => root.render(<MobileHeader titre="Activité" agent={agent()} status="En ligne" onMenu={vi.fn()} onAgent={vi.fn()} menu={<WorkMenu agent={agent()} active={null} onOpen={vi.fn()} waiting={2} onInbox={vi.fn()} />} />));
  expect(host.querySelector("header h1")?.textContent).toBe("Activité");
  expect(byLabel("Menu")).not.toBeNull();
  expect(host.querySelector(".mobile-agent")).toBeNull();
  expect(host.querySelector(".pour-toi-pill")).toBeNull();
});

it("E2 — cibles tactiles du téléphone : 44 px au moins", () => {
  const shell = readFileSync("src/styles/shell.css", "utf8");
  expect(readFileSync("src/styles/fil-calme.css", "utf8")).toMatch(/\.mobile-header \.shell-icon, \.mobile-header \.icon-btn \{ width:44px; height:44px; min-width:44px; \}/);
  expect(shell).toContain(".work-panel-head .shell-icon { width:44px; height:44px; min-width:44px; }");
  expect(shell).toMatch(/\.session-row \{[^}]*min-height:44px/);
});

it("F1 — 375×812 : chaque cible de la conversation fait 44 px au moins (Copier, Modifier, Réagir, +, dictée, voix, Stop), l'icône garde sa taille", () => {
  const shell = readFileSync("src/styles/shell.css", "utf8");
  const phone = shell.match(/@media\(max-width:767px\) \{[^@]*\.cible-tactile \{[^}]*\}/)?.[0] ?? "";
  expect(phone).toMatch(/\.cible-tactile \{[^}]*min-height:44px/);
  expect(phone).toMatch(/\.cible-tactile \{[^}]*min-width:44px/);
  expect(phone).not.toMatch(/\.cible-tactile[^{]*svg/); // l'icône garde sa taille ([&_svg]:size-4 du bouton)
  const sources = ["Thread.tsx", "thread/Markdown.tsx", "thread/parts.tsx", "thread/messages.tsx", "thread/Composer.tsx", "thread/panneaux.tsx", "WorkBar.tsx", "Voice.tsx", "ReportAnswer.tsx"].map((f) => readFileSync(`src/components/${f}`, "utf8")).join("\n");
  const tag = (label: string) => {
    const at = sources.indexOf(`aria-label={${label}`);
    expect(at, label).toBeGreaterThan(-1);
    const start = sources.lastIndexOf("<", at);
    return sources.slice(start, sources.indexOf(">", at));
  };
  for (const label of ['t("Copier mon message")', 't("Copier la réponse")', 't("Reprendre ce message")', 't("Réagir")', 't("Joindre des fichiers")',
    'state === "recording" ? t("Arrêter la dictée")', 't("Appeler {nom}"', 't("Arrêter")', 't("Envoyer")', 't("Signaler la réponse")', 't("Réagir {emoji}"', 't("Retirer ta réaction {emoji}"']) {
    expect(tag(label), label).toContain("cible-tactile");
  }
  expect(sources.match(/data-envoyer aria-label=\{t\("Envoyer"\)\}/g)?.length).toBe(3);
  for (const m of sources.matchAll(/<Button[^>]*data-envoyer[\s\S]*?>/g)) expect(m[0]).toContain("cible-tactile");
});

// --- Relecture GLM 0.3.0 (docs/epics/0.3.0/revue-glm.md) -----------------------------------------------------------------

it("P0n3 — un HTML ou un SVG du dossier de l'agent, ouvert par son nom, s'affiche en bac à sable sans allow-same-origin", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 200 })));
  files.push({ path: "outputs/piege.html", size: 10, modified: 1_700_000_400 }, { path: "outputs/dessin.svg", size: 10, modified: 1_700_000_350 });
  try {
    for (const path of ["outputs/piege.html", "outputs/dessin.svg"]) {
      await act(async () => root.render(<Files key={path} agentId="a" refreshKey={0} canDelete onGiven={vi.fn()} />));
      await settle();
      await act(async () => host.querySelector<HTMLButtonElement>(`button[title="${path}"]`)!.click());
      await until(".file-preview iframe");
      const frame = host.querySelector<HTMLIFrameElement>(".file-preview iframe")!;
      expect(frame.getAttribute("src")).toBe(`/api/agents/a/files/raw/${path}`);
      expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
      expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    }
  } finally { files.splice(-2); vi.unstubAllGlobals(); }
});

it("P0n4 — la liste vidée pendant un aperçu ne le remplace pas : l'aperçu et son Retour restent", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("du texte", { status: 200 })));
  const saved = files.splice(0);
  files.push(...saved);
  try {
    await act(async () => root.render(<Files agentId="a" refreshKey={0} canDelete onGiven={vi.fn()} />));
    await settle();
    await act(async () => byLabel("Aperçu de rapport.md")!.click());
    await until(".file-preview");
    files.splice(0);
    await act(async () => root.render(<Files agentId="a" refreshKey={1} canDelete onGiven={vi.fn()} />));
    await settle();
    expect(host.querySelector(".file-preview")).not.toBeNull();
    expect(byLabel("Retour aux fichiers")).not.toBeNull();
  } finally { files.splice(0); files.push(...saved); vi.unstubAllGlobals(); }
});

it("P1n1 — l'aperçu ouvert dans la session d'un agent ne passe pas à un autre agent", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("du texte", { status: 200 })));
  try {
    await act(async () => root.render(<Session agentId="a" withFiles refreshKey={0} onOpenThread={vi.fn()} />));
    await settle();
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('[aria-labelledby="session-files"] button')][0].click());
    await until(".file-preview");
    await act(async () => root.render(<Session agentId="b" withFiles refreshKey={0} onOpenThread={vi.fn()} />));
    await settle();
    expect(host.querySelector(".file-preview")).toBeNull();
    expect(host.querySelector(".session-bar")).not.toBeNull();
  } finally { vi.unstubAllGlobals(); }
});

it("P2n1 — une largeur retenue trop grande est bornée au rendu, puis à chaque redimensionnement", async () => {
  localStorage.setItem("noah:panneau", "1000");
  await act(async () => root.render(<Panel />));
  const panel = () => host.querySelector<HTMLElement>("aside.work-panel")!;
  expect(panel().style.width).toBe("1000px"); // 1600 - 560 = 1040 : elle tient
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 900 });
  await act(async () => { window.dispatchEvent(new Event("resize")); });
  expect(panel().style.width).toBe("340px"); // la conversation garde ses 560 px
  expect(host.querySelector('[role="separator"]')!.getAttribute("aria-valuenow")).toBe("340");
});

it("P2n4 — glisser le bord écrit la largeur une seule fois, au relâchement", async () => {
  await act(async () => root.render(<Panel />));
  const panel = host.querySelector<HTMLElement>("aside.work-panel")!;
  panel.getBoundingClientRect = () => ({ right: 1600, left: 1180, top: 0, bottom: 800, width: 420, height: 800, x: 1180, y: 0, toJSON() {} }) as DOMRect;
  const grip = host.querySelector<HTMLElement>('[role="separator"]')!;
  grip.setPointerCapture = vi.fn();
  const writes = vi.spyOn(Storage.prototype, "setItem");
  try {
    await act(async () => { grip.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 1180 })); });
    for (const x of [1170, 1150, 1100, 1080]) await act(async () => { grip.dispatchEvent(new MouseEvent("pointermove", { clientX: x })); });
    expect(panel.style.width).toBe("520px");
    expect(writes.mock.calls.filter(([k]) => k === "noah:panneau")).toHaveLength(0);
    await act(async () => { grip.dispatchEvent(new MouseEvent("pointerup", {})); });
    expect(writes.mock.calls.filter(([k]) => k === "noah:panneau")).toEqual([["noah:panneau", "520"]]);
  } finally { writes.mockRestore(); }
});

it("P2n5 — une couche restée montée mais masquée ne bloque pas Échap", async () => {
  const close = vi.fn();
  await act(async () => root.render(<Panel onClose={close} />));
  const hidden = document.createElement("div"); hidden.hidden = true;
  const menu = document.createElement("div"); menu.setAttribute("role", "menu"); hidden.append(menu);
  const gone = document.createElement("div"); gone.setAttribute("role", "dialog"); gone.style.display = "none";
  document.body.append(hidden, gone);
  await press("Escape");
  expect(close).toHaveBeenCalledTimes(1);
});

it("P2n2 — ouvert depuis le bouton du panneau, le panneau rend le focus à ce bouton en se fermant", async () => {
  wide = false;
  function Phone() {
    const [tab, setTab] = useState<PanelTab | null>(null);
    return <>
      <WorkMenu agent={agent()} active={tab} onOpen={setTab} />
      {tab && <WorkPanel open tab={tab} title="Fichiers" {...panelProps(tab)} expanded={false} onExpand={vi.fn()} onClose={() => setTab(null)}><p>contenu</p></WorkPanel>}
    </>;
  }
  await act(async () => root.render(<Phone />));
  const more = byLabel("Ouvrir ou fermer le panneau")!;
  more.focus();
  await act(async () => more.click());
  expect(document.activeElement).toBe(host.querySelector("aside.work-panel"));
  await press("Escape");
  expect(host.querySelector("aside.work-panel")).toBeNull();
  expect(document.activeElement).toBe(more);
});
