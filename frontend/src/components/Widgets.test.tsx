import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const state = { running: false };
vi.mock("@assistant-ui/react", () => ({ useAuiState: (pick: (s: unknown) => unknown) => pick({ message: { id: "m", index: 0, status: { type: state.running ? "running" : "complete" }, createdAt: new Date() }, thread: { isRunning: state.running, messages: [{ id: "m" }] } }) }));
vi.mock("@/lib/api", () => ({ mediaUrl: (_a: string, p: string) => `/api/media?path=${p}`, previewRenewIn: () => 1e9, previewUrl: async () => "", rawFileUrl: (_a: string, p: string) => `/raw${p}`, get: vi.fn(async () => ({})), send: vi.fn(async () => ({})), currentAuthEpoch: () => "t", request: vi.fn() }));
vi.mock("@/lib/events", () => ({ subscribeUpdates: () => () => {} }));
vi.mock("@/lib/platform", () => ({ inAndroidApp: () => false, nativeSave: () => false }));
vi.mock("./Viewer", () => ({ canFrame: () => false, CopyImageButton: () => null, isImagePath: () => false, useDownload: () => vi.fn(), useViewer: () => vi.fn() }));
vi.mock("./VideoEmbed", () => ({ VideoEmbed: () => <div>vidéo</div> }));
vi.mock("./elements/ElementCard", () => ({ ElementCard: ({ spec }: { spec: { kind: string; title: string } }) => <div data-element={spec.kind}>{spec.title}</div> }));
vi.mock("./elements/SandboxedFrame", () => ({ SandboxedFrame: () => null }));

import { NoahWidget } from "./Widgets";
import { SENSITIVE_MARKDOWN } from "./SensitiveMarkdown";

let host: HTMLDivElement, root: Root;
beforeEach(() => { state.running = false; host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const Pre = (p: React.ComponentProps<"pre">) => <pre {...p} />;
const Code = (p: React.ComponentProps<"code">) => <code {...p} />;
const widget = async (code: unknown) => {
  const text = typeof code === "string" ? code : JSON.stringify(code);
  const props = { code: text, language: "noah", components: { Pre, Code } } as unknown as React.ComponentProps<typeof NoahWidget>;
  await act(async () => root.render(<NoahWidget {...props} />));
};

it("posts : le bilan de posts X se montre en cartes, état, texte et lien, sans jargon ajouté", async () => {
  await widget({ type: "posts", title: "Posts du 13 nov.", items: [
    { platform: "x", account: "@SmfCoder", text: "Nouveau tuto en ligne", url: "https://x.com/SmfCoder/status/2120656025690804594", state: "publié", date: "9 h" },
    { platform: "x", text: "Carrousel", state: "échec", note: "X a refusé l'image : trop lourde", image: "/opt/data/workspace/outputs/a.jpg" },
  ] });
  const cards = host.querySelectorAll("article");
  expect(cards).toHaveLength(2);
  expect(cards[0].textContent).toContain("Publié");
  expect(cards[0].textContent).toContain("Nouveau tuto en ligne");
  expect(cards[0].querySelector("a")?.getAttribute("href")).toBe("https://x.com/SmfCoder/status/2120656025690804594");
  expect(cards[1].textContent).toContain("Échec");
  expect(cards[1].textContent).toContain("trop lourde");
  expect(cards[1].querySelector("img")?.getAttribute("src")).toBe("/api/media?path=/opt/data/workspace/outputs/a.jpg");
  expect(host.querySelector("pre")).toBeNull();
});

it("products : image, prix, marchand et lien vers la fiche", async () => {
  await widget({ type: "products", note: "prix relevés le 13 nov.", items: [{ title: "Casque A", price: "129 €", merchant: "Boutique", rating: "4,6/5", url: "https://boutique.example/a", image: "https://boutique.example/a.jpg" }, { title: "Casque B", price: "99 €" }] });
  const link = host.querySelector<HTMLAnchorElement>('a[href="https://boutique.example/a"]');
  expect(link?.textContent).toContain("129 €");
  expect(link?.textContent).toContain("Boutique");
  expect(link?.querySelector("img")?.getAttribute("src")).toBe("https://boutique.example/a.jpg");
  expect(host.textContent).toContain("Casque B");
  expect(host.textContent).toContain("prix relevés le 13 nov.");
});

it("links : une liste de sources avec titre et site, chaque ligne ouvre sa page", async () => {
  await widget({ type: "links", title: "Sources", items: [{ title: "Article", url: "https://www.lemonde.fr/a", note: "les chiffres" }, { url: "https://exemple.org/b" }] });
  const links = [...host.querySelectorAll<HTMLAnchorElement>("a")];
  expect(links.map((a) => a.getAttribute("href"))).toEqual(["https://www.lemonde.fr/a", "https://exemple.org/b"]);
  expect(links[0].textContent).toContain("lemonde.fr");
  expect(host.textContent).toContain("Sources");
});

it("un bloc mal formé retombe en texte lisible une fois la réponse finie, jamais en écran vide", async () => {
  for (const bad of ['{"type": "posts", "items": [', '{"type": "choice", "question": "On y va ?", "options": "Oui ou non"}', '{"type": "grid", "items": {"title": "x"}}', '{"type": "inconnu"}', '{"type": "links", "items": [{"title": "sans adresse"}]}', "[1, 2]"]) {
    await widget(bad);
    expect(host.querySelector("pre code")?.textContent, bad).toBe(bad);
    expect(host.querySelector('[aria-label="Widget en préparation"]'), bad).toBeNull();
  }
});

it("pendant le streaming, un bloc incomplet garde sa place sans montrer le JSON", async () => {
  state.running = true;
  await widget('{"type": "posts", "items": [{"text": "Bonj');
  expect(host.querySelector('[aria-label="Widget en préparation"]')).not.toBeNull();
  expect(host.querySelector("pre")).toBeNull();
});

it("les blocs existants s'affichent toujours : choix, grille, aperçu", async () => {
  await widget({ type: "choice", question: "Je publie ?", options: ["Oui, vas-y", "Non"] });
  expect([...host.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Oui, vas-y", "Non"]);
  await widget({ type: "grid", title: "Vidéos", items: [{ title: "A" }] });
  expect(host.querySelector('[data-element="grid"]')?.textContent).toBe("Vidéos");
  await widget({ type: "preview", path: "/opt/data/workspace/outputs/rapport.pdf" });
  expect(host.querySelector("[data-element]")?.textContent).toBe("rapport.pdf");
});

it("un tableau markdown se rend en vrai tableau, en-tête compris, et masque une carte mais pas un lien de post", async () => {
  const md = "| Post | Lien | Paiement |\n|---|---|---|\n| Tuto | https://x.com/SmfCoder/status/2120957443479855511 | 4111 1111 1111 1111 |";
  await act(async () => root.render(<ReactMarkdown remarkPlugins={[remarkGfm]} components={SENSITIVE_MARKDOWN as never}>{md}</ReactMarkdown>));
  expect([...host.querySelectorAll("th")].map((t) => t.textContent)).toEqual(["Post", "Lien", "Paiement"]);
  const cells = host.querySelectorAll("td");
  expect(cells).toHaveLength(3);
  expect(cells[1].querySelector("a")?.getAttribute("href")).toBe("https://x.com/SmfCoder/status/2120957443479855511");
  expect(cells[1].textContent).toBe("https://x.com/SmfCoder/status/2120957443479855511");
  expect(cells[2].textContent).not.toContain("4111 1111 1111 1111");
});
