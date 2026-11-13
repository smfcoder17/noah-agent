import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { readFileSync } from "node:fs";

vi.mock("./Noah", () => ({ AgentFace: () => <span>Avatar</span> }));
vi.mock("./Viewer", () => ({ useDownload: () => vi.fn() }));
vi.mock("./Widgets", () => ({ Chart: () => null }));
vi.mock("@/lib/platform", () => ({ appShell: () => null, elementAction: vi.fn(), inAndroidApp: () => false }));
vi.mock("@/lib/api", () => ({ get: vi.fn(async () => []), send: vi.fn(async () => ({ title: "marc@gmail.com", site: "marc@gmail.com" })), currentAuthEpoch: () => "test", canAdmin: () => true, canTalk: () => true, request: vi.fn() }));
import { type Agent } from "@/lib/api";
import { SENSITIVE_MARKDOWN } from "./SensitiveMarkdown";
import { SensitiveContext, sensitiveChildren } from "./SensitiveText";
import { LinkCard } from "./LinkCard";
import { ElementViewer } from "./elements/ElementViewer";
import { takeAsk } from "@/lib/askAgent";
import { SideRail } from "./desktop/SideRail";
import { Drawer } from "./mobile/Drawer";
import { MobileHeader } from "./mobile/MobileHeader";
import { SettingsDialog, SettingsFrame } from "./Settings";
import { Dialog, DialogContent } from "./ui";
import { ProviderLogo, providerLogo } from "./ProviderLogo";
import { useNoahRetour } from "@/lib/useNoahRetour";

let host: HTMLDivElement, root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); takeAsk(); });
const click = async (label: string) => {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label);
  expect(button, label).toBeTruthy();
  await act(async () => button!.click());
};
const noOp = () => {};
const agent = { id: "a", name: "Noah", online: true, state: "approve", tasks: { approve: 2 }, droit: "proprietaire" } as Agent;

it("09 — À toi et son compteur ouvrent la liste depuis le rail et le tiroir", async () => {
  const open = vi.fn();
  await act(async () => root.render(<SideRail agent={agent} waiting={3} onInbox={open} tabs={["chat"]} active="chat" conversations={[]} onTab={noOp} onAgent={noOp} onMenu={noOp} onThread={noOp} onSettings={noOp} onGoals={noOp} />));
  const rail = host.querySelector('[aria-label="3 en attente"]')!.closest("button")!;
  expect(rail.textContent).toContain("À toi");
  await act(async () => rail.click());
  expect(open).toHaveBeenCalledTimes(1);
  await act(async () => root.render(<Drawer agents={[agent]} waiting={3} onInbox={open} agentId="a" conversations={[]} tabs={["chat"]} onAgent={noOp} onThread={noOp} onNewAgent={noOp} onTab={noOp} onCustomize={noOp} onSettings={noOp} onGoals={noOp} onClose={noOp} onLogout={noOp} />));
  const drawer = document.querySelector('[aria-label="3 en attente"]')!.closest("button")!;
  expect(drawer.textContent).toContain("À toi");
  await act(async () => drawer.click());
  expect(open).toHaveBeenCalledTimes(2);
});

it("11 S1 — titres, citations, code et enfants imbriqués ne révèlent rien avant le geste", async () => {
  const md = [1, 2, 3, 4, 5, 6].map((n) => `${"#".repeat(n)} marc@gmail.com`).join("\n\n") + "\n\n> ~~**marc@gmail.com**~~\n\n`marc@gmail.com`\n\n```python\nmarc@gmail.com\n```";
  await act(async () => root.render(<><ReactMarkdown remarkPlugins={[remarkGfm]} components={SENSITIVE_MARKDOWN}>{md}</ReactMarkdown>{sensitiveChildren(<span><del><em>marc@gmail.com</em></del></span>)}</>));
  expect(host.innerHTML).not.toContain("marc@gmail.com");
  for (const tag of ["h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "code", "pre"]) expect(host.querySelector(tag)?.textContent).toContain("•••");
  await act(async () => host.querySelector<HTMLButtonElement>("h1 button")!.click());
  expect(host.querySelector("h1")?.textContent).toContain("marc@gmail.com");
  await act(async () => host.querySelector<HTMLButtonElement>("h1 button")!.click());
  expect(host.innerHTML).not.toContain("marc@gmail.com");
  const Highlight = SENSITIVE_MARKDOWN.SyntaxHighlighter!;
  await act(async () => root.render(<Highlight code="marc@gmail.com" language="python" components={{ Pre: ({ children }) => <pre>{children}</pre>, Code: ({ children }) => <code>{children}</code> }} />));
  expect(host.querySelector("pre code")?.textContent).toContain("•••");
  expect(host.innerHTML).not.toContain("marc@gmail.com");
});

it("11 S2 — le nom accessible d'un lien respecte aussi le réglage", async () => {
  await act(async () => root.render(<LinkCard url="https://exemple.org/secret" />));
  expect(host.querySelector("a")?.getAttribute("aria-label")).toContain("•••");
  expect(host.innerHTML).not.toContain("marc@gmail.com");
  await act(async () => root.render(<SensitiveContext.Provider value={false}><LinkCard url="https://exemple.org/secret" /></SensitiveContext.Provider>));
  expect(host.querySelector("a")?.getAttribute("aria-label")).toContain("marc@gmail.com");
});

it("11 S1 — copier un bloc de code exige de révéler sa donnée", async () => {
  const Header = SENSITIVE_MARKDOWN.CodeHeader!, Highlight = SENSITIVE_MARKDOWN.SyntaxHighlighter!;
  const writeText = vi.fn();
  const previous = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  try {
    await act(async () => root.render(<><Header code="marc@gmail.com" language="texte" /><Highlight code="marc@gmail.com" language="texte" components={{ Pre: ({ children }) => <pre>{children}</pre>, Code: ({ children }) => <code>{children}</code> }} /></>));
    await click("Copier le code"); expect(writeText).not.toHaveBeenCalled();
    await act(async () => host.querySelector<HTMLButtonElement>("code button")!.click());
    await click("Copier le code"); expect(writeText).toHaveBeenCalledWith("marc@gmail.com");
  } finally {
    if (previous) Object.defineProperty(navigator, "clipboard", previous);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});

it("11 S3 — une carte attend révélation et envoi explicites, puis vise son agent", async () => {
  await act(async () => root.render(<ElementViewer spec={{ type: "element", kind: "email", source: "noah", title: "Courriel", agentId: "origine", data: { from: "marc@gmail.com" } }} />));
  await click("Relire le brouillon");
  expect(takeAsk("origine")).toBeNull();
  expect(document.querySelector('[role="dialog"]')?.innerHTML).not.toContain("marc@gmail.com");
  await click("Envoyer à l'agent");
  expect(takeAsk("origine")).toBeNull();
  await click("Révéler avant d'envoyer");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("marc@gmail.com");
  await click("Envoyer à l'agent");
  expect(takeAsk("autre")).toBeNull();
  expect(takeAsk("origine")).toContain("marc@gmail.com");
});

it("11 S3 — un choix sensible ne part pas en clair quand le masquage est actif", async () => {
  await act(async () => root.render(<ElementViewer spec={{ type: "element", kind: "choice", source: "noah", title: "Choix", agentId: "a", data: { options: ["marc@gmail.com"] } }} />));
  // Le libellé est lui aussi masqué ; le clic d'action ouvre la relecture.
  const action = host.querySelector<HTMLButtonElement>(".element-actions button")!;
  await act(async () => action.click());
  expect(takeAsk("a")).toBeNull();
  expect(document.querySelector('[role="dialog"]')).toBeTruthy();
});

it("11 S3 — le formulaire passe par la même relecture ; masquage coupé, l'action reste directe", async () => {
  const spec = { type: "element" as const, kind: "form" as const, source: "noah" as const, title: "marc@gmail.com", agentId: "a", data: { fields: ["Réponse"] } };
  await act(async () => root.render(<ElementViewer spec={spec} />));
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(takeAsk("a")).toBeNull();
  expect(document.querySelector('[role="dialog"]')).toBeTruthy();
  // Fermer puis désactiver le masquage autorise l'action habituelle sans relecture supplémentaire.
  const close = document.querySelector<HTMLButtonElement>('[role="dialog"] [aria-label="Fermer"]')!;
  await act(async () => close.click());
  await act(async () => root.render(<SensitiveContext.Provider value={false}><ElementViewer spec={spec} /></SensitiveContext.Provider>));
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(takeAsk("a")).toContain("marc@gmail.com");
});

it("12 — réglages modaux, focus retenu et Échap ferme seulement la couche supérieure", async () => {
  const outside = document.createElement("button"); document.body.append(outside);
  function Screen() {
    const [open, setOpen] = useState(true), [nested, setNested] = useState(false);
    return <SettingsFrame open={open} onOpenChange={setOpen} title="Réglages"><button onClick={() => setNested(true)}>Sous-écran</button><Dialog open={nested} onOpenChange={setNested}>{nested && <DialogContent title="Confirmation"><button>Dernier</button></DialogContent>}</Dialog></SettingsFrame>;
  }
  await act(async () => root.render(<Screen />));
  const parent = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(parent.getAttribute("aria-modal")).toBe("true");
  expect(parent.contains(document.activeElement)).toBe(true);
  await act(async () => outside.focus());
  expect(parent.contains(document.activeElement)).toBe(true);
  await click("Sous-écran");
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Réglages");
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(document.querySelector('[role="dialog"]')).toBeNull(); outside.remove();
});

it("12 S4 — cadre sur toute la zone de droite et liste au début, téléphone plein écran", async () => {
  await act(async () => root.render(<SettingsDialog open tab="home" owner onTab={noOp} onOpenChange={noOp} onBrainSaved={noOp} />));
  const frame = document.querySelector<HTMLElement>('.desktop-settings[role="dialog"]')!;
  const columns = frame.querySelector<HTMLElement>(":scope > .settings-two-columns")!;
  const list = columns.querySelector<HTMLElement>(":scope > .settings-list")!;
  expect(list.firstElementChild?.textContent).toBe("Apparence");
  expect(list.textContent).toContain("Modèles et budget");
  expect(columns.querySelector(":scope > .settings-detail")).toBeTruthy();
  expect(frame.scrollTop).toBe(0);
  expect(list.scrollTop).toBe(0);

  // JSDOM ne calcule pas les rectangles : ici, seulement les règles sources.
  // tools/eval/vue-reglages.mjs vérifie la vraie App après vite build + preview.
  const style = document.createElement("style");
  style.textContent = readFileSync("src/styles/desktop.css", "utf8");
  document.head.append(style);
  try {
    const rules = [...style.sheet!.cssRules];
    const media = (condition: string) => rules.flatMap((r) => r instanceof CSSMediaRule && r.conditionText === condition ? [...r.cssRules] : []);
    const rule = (group: CSSRule[], selector: string) => (group.find((r) => r instanceof CSSStyleRule && r.selectorText === selector) as CSSStyleRule).style;
    const desktop = media("(min-width:768px)");
    const frameStyle = rule(desktop, ".desktop-settings[role=dialog]");
    for (const [property, value] of Object.entries({ inset: "0 0 0 var(--rail-width)", translate: "none", width: "auto", "max-width": "none", "max-height": "none", overflow: "hidden", padding: "0" })) {
      expect(frameStyle.getPropertyValue(property), property).toBe(value);
    }
    expect(frameStyle.getPropertyValue("transform")).toBe(""); // sinon la minification retire translate:none
    expect(rule(desktop, ".desktop-settings[role=dialog] > .settings-two-columns").getPropertyValue("flex")).toBe("1");
    expect(rule(rules, ".settings-two-columns").getPropertyValue("grid-template-columns")).toBe("280px minmax(0,1fr)");
    expect(rule(rules, ".settings-list").getPropertyValue("display")).toBe("flex");
    expect(rule(rules, ".settings-list").getPropertyValue("overflow-y")).toBe("auto");
    expect(rule(rules, ".settings-detail").getPropertyValue("overflow")).toBe("auto");
    const phone = media("(max-width:767px)");
    expect(rule(phone, ".settings-list").getPropertyValue("display")).toBe("none");
    expect(rule(phone, ".settings-two-columns").getPropertyValue("flex-direction")).toBe("column");
    // Le cadre garde les classes plein écran du dialogue commun sur téléphone.
    expect(frame.classList.contains("max-md:inset-0")).toBe(true);
    expect(frame.classList.contains("max-md:h-dvh")).toBe(true);
    expect(frame.classList.contains("max-md:w-full")).toBe(true);
    expect(frame.classList.contains("max-md:translate-x-0")).toBe(true);
    expect(frame.classList.contains("max-md:translate-y-0")).toBe(true);
  } finally { style.remove(); }
});

it("13/14 B6 — aucune lecture de budget perdue dans Shell ni sélecteur CSS sans cible", () => {
  const source = readFileSync("src/App.tsx", "utf8");
  expect(source).not.toContain('"/api/usage"');
  expect(readFileSync("src/styles/elements.css", "utf8")).not.toContain(".element-download");
  expect(readFileSync("src/styles/shell.css", "utf8")).not.toContain("data-computer-tabs");
});

it("14 B5 — Retour reste stable aux rendus ordinaires et suit les niveaux courants", async () => {
  const dispatch = vi.fn(), go = vi.fn();
  function Screen({ depth }: { depth: number }) { useNoahRetour(depth, dispatch, "chat", go); return null; }
  await act(async () => root.render(<Screen depth={1} />));
  const first = window.noahRetour;
  await act(async () => root.render(<Screen depth={1} />));
  expect(window.noahRetour).toBe(first);
  expect(window.noahRetour?.()).toBe(false);
  await act(async () => root.render(<Screen depth={2} />));
  expect(window.noahRetour?.()).toBe(true);
  expect(dispatch).toHaveBeenCalledWith({ type: "back" });
});

it("18 — Mammouth utilise le SVG officiel local", async () => {
  expect(providerLogo("mammouth")).toMatch(/mammouth\.svg/);
  await act(async () => root.render(<ProviderLogo lab="mammouth" />));
  expect(host.querySelector("img")?.getAttribute("src")).toBe(providerLogo("mammouth"));
  expect(host.textContent).not.toBe("m");
});

it("19 — le badge d'état montre les accords dans le rail et l'en-tête mobile", async () => {
  await act(async () => root.render(<MobileHeader agent={agent} status="En ligne" onMenu={noOp} onAgent={noOp} onNew={noOp} />));
  expect(host.querySelector("small")?.textContent).toContain("2 accords");
  expect(host.querySelector("small span")?.className).toContain("bg-warn");
  await act(async () => root.render(<SideRail agent={agent} tabs={[]} active="chat" conversations={[]} onTab={noOp} onAgent={noOp} onMenu={noOp} onThread={noOp} onSettings={noOp} onGoals={noOp} />));
  expect(host.querySelector("small")?.textContent).toContain("2 accords");
});
