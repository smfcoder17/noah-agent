// Franck, app en anglais : le filtre des fournisseurs montrait « Claude Code (ton ordinateur) » en français, des pastilles « O » à la place des
// logos Claude/OpenAI/xAI, et des modèles nommés « Claude Code · sonnet ». Les libellés viennent du serveur (en français) : l'écran les traduit.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { choisirLangue } from "@/i18n";
import { ModelSearch } from "./Modes";
import type { ListedModel } from "@/lib/modes";

const pc = (id: string, name: string, lab: string, fournisseur: string): ListedModel => ({
  id, name, lab, created: 0, context: lab === "anthropic" ? 200000 : 0, price_in: null, price_out: null, vision: false, free: false, fournisseur,
  prix: "compris dans l'abonnement", abonnement: true,
});
const rows: ListedModel[] = [
  pc("sonnet", "Claude Sonnet 5.5", "anthropic", "ordinateur:claude-code"),
  pc("gpt-5", "GPT 5", "openai", "ordinateur:chatgpt"),
  pc("grok-4", "Grok 4", "xai", "ordinateur:grok"),
  { id: "gpt-oss-x", name: "Mon modèle", lab: "custom", created: 0, context: 0, price_in: 0, price_out: 0, vision: false, free: false, fournisseur: "custom" },
];
const fournisseurs = [
  { id: "ordinateur:claude-code", label: "Claude Code (ton ordinateur)" },
  { id: "ordinateur:chatgpt", label: "ChatGPT (ton ordinateur)" },
  { id: "ordinateur:grok", label: "Grok (ton ordinateur)" },
  { id: "custom", label: "Autre service compatible OpenAI" },
];

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  choisirLangue("en", false);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ modeles: rows, fournisseurs })));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); choisirLangue("fr", false); });

const open = async () => {
  await act(async () => root.render(<ModelSearch level="cerveau" onPick={() => {}} />));
  await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("All providers"))!.click());
};

it("anglais : le filtre et le sous-titre de chaque modèle sont traduits, aucun libellé français", async () => {
  await open();
  const bar = host.querySelector('[aria-label="Providers"]')!;
  expect([...bar.querySelectorAll('input[type="checkbox"]')].map((c) => c.getAttribute("aria-label"))).toEqual([
    "ChatGPT (your computer)", "Claude Code (your computer)", "Grok (your computer)", "Other OpenAI-compatible service"]);
  expect(host.textContent).not.toMatch(/ton ordinateur|Autre service/);
  const sonnet = [...host.querySelectorAll('[role="radio"]')].find((r) => r.textContent?.includes("Claude Sonnet 5.5"))!;
  expect(sonnet.textContent).toContain("Claude Code (your computer)");
  expect(sonnet.textContent).toContain("Included in the subscription");
});

it("chaque fournisseur a son logo (Claude, OpenAI, xAI), jamais une pastille lettre ; un modèle d'abonnement aussi", async () => {
  await open();
  const bar = host.querySelector('[aria-label="Providers"]')!;
  for (const label of ["Claude Code (your computer)", "ChatGPT (your computer)", "Grok (your computer)"]) {
    const row = bar.querySelector(`input[aria-label="${label}"]`)!.closest("label")!;
    expect(row.querySelector("img"), label).toBeTruthy();
  }
  const sonnet = [...host.querySelectorAll('[role="radio"]')].find((r) => r.textContent?.includes("Claude Sonnet 5.5"))!;
  expect(sonnet.querySelector("img")).toBeTruthy();
  const grok = [...host.querySelectorAll('[role="radio"]')].find((r) => r.textContent?.includes("Grok 4"))!;
  expect(grok.querySelector("img")).toBeTruthy();
  const heads = [...host.querySelectorAll('[role="presentation"]')].map((h) => h.textContent);
  expect(heads).toEqual(expect.arrayContaining([expect.stringContaining("xAI"), expect.stringContaining("Anthropic"), expect.stringContaining("OpenAI")]));
});
