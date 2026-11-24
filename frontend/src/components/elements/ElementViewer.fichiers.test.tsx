import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ previewUrl: vi.fn(async (_agent: string, path: string) => `/api/apercu/jeton.signature/${path.split("/").pop()}`) }));
vi.mock("@/lib/api", async (original) => ({ ...(await original<typeof import("@/lib/api")>()), previewUrl: api.previewUrl }));
import type { ElementSpec } from "@/lib/elements";
import { ElementViewer } from "./ElementViewer";

const WORKSPACE = "/opt/data/workspace/";
const spec = (kind: ElementSpec["kind"], path: string): ElementSpec => ({ type: "element", kind, title: path.split("/").pop() || path, source: "noah", agentId: "a1", path: WORKSPACE + path, url: `/api/agents/a1/files/raw/${path}`, size: 10 });
const flush = () => act(async () => { await new Promise((ok) => setTimeout(ok, 20)); });
afterEach(() => vi.unstubAllGlobals());

async function show(element: ElementSpec, body = "") {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
  const host = document.createElement("div"), root = createRoot(host);
  await act(async () => root.render(<ElementViewer spec={element} />));
  await flush();
  return { host, close: () => act(async () => root.unmount()) };
}

it("un texte brut garde ses lignes ; seul un fichier Markdown est rendu", async () => {
  const txt = await show(spec("code", "outputs/notes.txt"), "première ligne\nseconde ligne\n\n  indentée\n");
  const pre = txt.host.querySelector("pre");
  expect(pre?.textContent).toBe("première ligne\nseconde ligne\n\n  indentée\n");
  expect(pre?.className).toContain("whitespace-pre-wrap");
  expect(txt.host.querySelector(".prose-chat")).toBeNull();
  await txt.close();
  const md = await show(spec("code", "outputs/rapport.md"), "# Titre\n\n- un\n- deux\n");
  expect(md.host.querySelector("h1")?.textContent).toBe("Titre");
  expect(md.host.querySelectorAll("li")).toHaveLength(2);
  expect(md.host.querySelector("pre")).toBeNull();
  await md.close();
  const log = await show(spec("code", "outputs/serveur.log"), "12:00 démarré\n12:01 prêt\n");
  expect(log.host.querySelector("pre")?.textContent).toBe("12:00 démarré\n12:01 prêt\n");
  await log.close();
});

it("une page de l'agent se montre par son lien d'aperçu, toujours isolée, pour que ses images et ses scripts voisins se chargent", async () => {
  const view = await show(spec("page", "outputs/page.html"));
  expect(api.previewUrl).toHaveBeenCalledWith("a1", WORKSPACE + "outputs/page.html");
  const frame = view.host.querySelector("iframe")!;
  expect(frame.getAttribute("src")).toBe("/api/apercu/jeton.signature/page.html");
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts"); // jamais allow-same-origin
  await view.close();
});

it("si le lien d'aperçu ne vient pas, la page reste lisible par son adresse brute", async () => {
  api.previewUrl.mockRejectedValueOnce(new Error("hors ligne"));
  const view = await show(spec("page", "outputs/seule.html"));
  expect(view.host.querySelector("iframe")?.getAttribute("src")).toBe("/api/agents/a1/files/raw/outputs/seule.html");
  await view.close();
});

it("un PDF s'ouvre hors bac à sable : le lecteur de PDF du navigateur refuse un cadre isolé", async () => {
  const pdf = await show(spec("pdf", "outputs/doc.pdf"));
  const frame = pdf.host.querySelector("iframe")!;
  expect(frame.getAttribute("src")).toContain("/files/raw/outputs/doc.pdf");
  expect(frame.hasAttribute("sandbox")).toBe(false);
  await pdf.close();
  const page = await show(spec("page", "outputs/autre.html"));
  expect(page.host.querySelector("iframe")?.hasAttribute("sandbox")).toBe(true);
  await page.close();
});
