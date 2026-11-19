// Le corpus des formes vues en production (0.4.0, L4 : X10), réécrites avec des contenus inventés : un JSON nu, un bloc ```json, un bloc ```noah, un bloc inconnu,
// un tableau Markdown, des flèches. Jamais de JSON brut à l'écran : une carte, ou un libellé lisible.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

vi.mock("@assistant-ui/react", () => ({ useAuiState: (pick: (s: unknown) => unknown) => pick({ message: { id: "m", index: 0, status: { type: "complete" }, createdAt: new Date() }, thread: { isRunning: false, messages: [{ id: "m" }] } }) }));
vi.mock("@/lib/api", () => ({ mediaUrl: (_a: string, p: string) => `/api/media?path=${p}`, previewRenewIn: () => 1e9, previewUrl: async () => "", rawFileUrl: (_a: string, p: string) => `/raw${p}`, get: vi.fn(async () => ({})), send: vi.fn(async () => ({})), currentAuthEpoch: () => "t", request: vi.fn() }));
vi.mock("@/lib/events", () => ({ subscribeUpdates: () => () => {} }));
vi.mock("@/lib/platform", () => ({ inAndroidApp: () => false, nativeSave: () => false }));
vi.mock("./Viewer", () => ({ canFrame: () => false, CopyImageButton: () => null, isImagePath: () => false, useDownload: () => () => {}, useViewer: () => () => {} }));
vi.mock("./VideoEmbed", () => ({ VideoEmbed: () => <div>vidéo</div> }));
vi.mock("./elements/ElementCard", () => ({ ElementCard: () => null }));
vi.mock("./elements/SandboxedFrame", () => ({ SandboxedFrame: () => null }));

import { normaliserBlocs } from "@/lib/blocsNus";
import { NoahWidget } from "./Widgets";
import { SENSITIVE_MARKDOWN } from "./SensitiveMarkdown";

let host: HTMLDivElement, root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const Pre = (p: React.ComponentProps<"pre">) => <pre {...p} />;
const Code = (p: React.ComponentProps<"code">) => <code {...p} />;
// Comme thread/Markdown.tsx : un bloc ```noah devient une carte, le reste du Markdown se rend tel quel.
const propsDuBloc = (code: string) => ({ code: code.replace(/\n$/, ""), language: "noah", components: { Pre, Code } }) as unknown as React.ComponentProps<typeof NoahWidget>;
const components = {
  ...(SENSITIVE_MARKDOWN as Record<string, unknown>),
  pre: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  code: ({ className, children }: { className?: string; children?: React.ReactNode }) =>
    /language-noah/.test(className ?? "") ? <NoahWidget {...propsDuBloc(String(children))} /> : <code className={className}>{children}</code>,
};
const rendre = async (texte: string, enCours = false) => {
  await act(async () => root.render(<ReactMarkdown remarkPlugins={[remarkGfm]} components={components as never}>{normaliserBlocs(texte, enCours)}</ReactMarkdown>));
};

const LIENS = { type: "links", title: "Sources", items: [{ title: "Article", url: "https://www.lemonde.fr/a", note: "les chiffres" }, { url: "https://exemple.org/b" }] };

describe("un bloc de liens écrit de trois façons donne la même carte", () => {
  it.each([
    ["JSON nu, au milieu de la réponse", `Voici mes sources.\n\n${JSON.stringify(LIENS)}\n\nDis-moi si tu en veux d'autres.`],
    ["JSON nu en pretty-print", `Voici mes sources.\n${JSON.stringify(LIENS, null, 2)}\nFin.`],
    ["bloc ```json", `Voici mes sources.\n\n\`\`\`json\n${JSON.stringify(LIENS, null, 2)}\n\`\`\`\n\nFin.`],
    ["bloc ```noah", `Voici mes sources.\n\n\`\`\`noah\n${JSON.stringify(LIENS)}\n\`\`\`\n\nFin.`],
  ])("%s", async (_nom, texte) => {
    await rendre(texte);
    expect([...host.querySelectorAll<HTMLAnchorElement>("a")].map((a) => a.getAttribute("href"))).toEqual(["https://www.lemonde.fr/a", "https://exemple.org/b"]);
    expect(host.textContent).toContain("Sources");
    expect(host.textContent).toContain("Voici mes sources.");
    expect(host.textContent).not.toContain('"type"');
    expect(host.textContent).not.toContain("{");
    expect(host.querySelector("pre, code")).toBeNull();
  });
});

describe("un bloc inconnu ou incomplet est replié sous un libellé", () => {
  it.each([
    ['{"type":"constellation","etoiles":[1,2,3]}', /constellation/],
    ['{"type":"links","items":[{"title":"sans adresse"}]}', /links/],
  ])("%s", async (json, libelle) => {
    await rendre(`Regarde :\n\n${json}\n\nVoilà.`);
    const replie = host.querySelector<HTMLDetailsElement>("[data-bloc-replie]");
    expect(replie).not.toBeNull();
    expect(replie!.open).toBe(false);
    expect(replie!.querySelector("summary")?.textContent).toMatch(libelle);
    expect(host.textContent).toContain("Regarde :");
    expect(host.textContent).toContain("Voilà.");
  });
  it("un JSON sans champ type est replié aussi, jamais montré brut", async () => {
    await rendre('Voici :\n{"nom":"x","valeur":3}\nFin.');
    expect(host.querySelector("[data-bloc-replie]")).not.toBeNull();
    expect(host.querySelector("[data-bloc-replie]")!.hasAttribute("open")).toBe(false);
  });
});

describe("ce qui n'est pas un bloc reste du texte", () => {
  it("un tableau Markdown se lit en vrai tableau", async () => {
    await rendre("| Offre | Prix |\n|---|---|\n| Mensuelle | 9 € |\n| Annuelle | 90 € |");
    expect([...host.querySelectorAll("th")].map((c) => c.textContent)).toEqual(["Offre", "Prix"]);
    expect(host.querySelectorAll("td")).toHaveLength(4);
  });
  it("des flèches restent lisibles", async () => {
    await rendre("Étape 1 -> étape 2 => résultat → fin ➡️ suite");
    expect(host.textContent).toBe("Étape 1 -> étape 2 => résultat → fin ➡️ suite");
  });
  it("une accolade dans une phrase, un JSON dans un vrai bloc de code, ne sont pas touchés", async () => {
    await rendre('Écris {nom} dans le champ, puis :\n\n```js\nconst a = {"type": "links", "items": []};\n```');
    expect(host.textContent).toContain("Écris {nom} dans le champ");
    expect(host.querySelector("code")?.textContent).toContain('const a = {"type": "links"');
    expect(host.querySelector("[data-bloc-replie]")).toBeNull();
  });
  it("pendant l'écriture, un objet pas encore fermé ne montre pas son JSON", async () => {
    await rendre('Je cherche.\n\n{"type":"links","title":"Sour', true);
    expect(host.textContent).toBe("Je cherche.");
  });
});
