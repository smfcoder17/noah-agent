// Connecteurs à clé (GitHub, Airtable, Stripe, Apify) dans l'onglet Connexions : la clé se saisit masquée, part une fois vers le
// serveur, et ne revient jamais à l'écran ; un connecteur branché montre ses outils de lecture à part de ceux qui modifient.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { Connections, KeyConnectors } from "./AgentPowers";

const CLE = "github_pat_11ABCDEFG0123456789_secretpartie";
const CATALOGUE = [
  { nom: "github", titre: "GitHub", hote: "github.com", lien: "https://github.com/settings/personal-access-tokens/new", droit: "confirmer" },
  { nom: "airtable", titre: "Airtable", hote: "airtable.com", lien: "https://airtable.com/create/tokens", droit: "confirmer" },
  { nom: "stripe-lecture", titre: "Stripe", hote: "stripe.com", lien: "https://dashboard.stripe.com/apikeys", droit: "confirmer" },
  { nom: "apify", titre: "Apify", hote: "apify.com", lien: "https://console.apify.com/settings/integrations", droit: "confirmer" },
];
const GITHUB_BRANCHE = {
  nom: "github", url: "https://api.githubcopilot.com/mcp/", hote: "github.com", auth: "jeton", jeton: true, droit: "confirmer", etat: "ok", erreur: "", connecte: true,
  outils: [
    { nom: "get_me", description: "", lecture_seule: true },
    { nom: "list_issues", description: "", lecture_seule: true },
    { nom: "create_issue", description: "", lecture_seule: false },
  ],
};

type Call = { url: string; method: string; body: string };
// jsdom n'a pas IntersectionObserver : le logo reste la lettre, ce test ne regarde pas les images.
class NoObserver { observe() {} disconnect() {} unobserve() {} }
function serve(routes: Record<string, unknown>) {
  const calls: Call[] = [];
  vi.stubGlobal("IntersectionObserver", NoObserver);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: String(init.body ?? "") });
    const path = url.split("?")[0];
    const key = `${init.method ?? "GET"} ${path}`;
    const found = key in routes ? routes[key] : path in routes ? routes[path] : undefined;
    if (found === undefined) return new Response(JSON.stringify({ detail: "absent" }), { status: 404 });
    return new Response(JSON.stringify(found), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  return calls;
}

function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
let unmount: (() => void) | null = null;
afterEach(() => { unmount?.(); unmount = null; vi.unstubAllGlobals(); });

async function render(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  await flush();
  unmount = () => { act(() => root.unmount()); host.remove(); };
  return host;
}

it("propose les quatre connecteurs ; un connecteur déjà branché n'est plus proposé", async () => {
  serve({ "/api/connections/cles": CATALOGUE });
  const host = await render(<KeyConnectors agentId="a1" shared={false} tools={[GITHUB_BRANCHE as never]} onAdded={() => {}} />);
  const text = host.textContent ?? "";
  expect(text).toContain("Avec une clé");
  for (const nom of ["Airtable", "Stripe", "Apify"]) expect(text).toContain(nom);
  expect(text).not.toContain("GitHub");
});

it("la clé GitHub se saisit masquée, part une fois vers le serveur, puis disparaît de l'écran", async () => {
  const calls = serve({ "/api/connections/cles": CATALOGUE, "POST /api/agents/a1/connections/cles/github": { nom: "github", outils: [] } });
  const added = vi.fn();
  const host = await render(<KeyConnectors agentId="a1" shared={false} tools={[]} onAdded={added} />);
  const card = [...host.querySelectorAll("div.rounded-lg")].find((d) => d.textContent?.includes("GitHub"))!;
  await act(async () => card.querySelector("button")!.click());
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Clé GitHub"]')!;
  expect(input.type).toBe("password");
  expect(input.autocomplete).toBe("off");
  const link = host.querySelector<HTMLAnchorElement>('a[href^="https://github.com/settings/personal-access-tokens"]')!;
  expect(link.rel).toContain("noopener");
  expect(host.textContent).toContain("Ce qui modifie quelque chose attend ton accord");
  await act(async () => type(input, CLE));
  await act(async () => host.querySelector<HTMLFormElement>("form")!.requestSubmit());
  await flush();
  const sent = calls.filter((c) => c.method === "POST");
  expect(sent).toHaveLength(1);
  expect(sent[0].url).toBe("/api/agents/a1/connections/cles/github");
  expect(JSON.parse(sent[0].body)).toEqual({ jeton: CLE, droit: "confirmer" });
  expect(added).toHaveBeenCalledWith("github");
  expect(host.querySelector('input[aria-label="Clé GitHub"]')).toBeNull();
  expect(host.innerHTML).not.toContain(CLE);
});

it("une clé refusée laisse le message du serveur, sans rien brancher", async () => {
  serve({ "/api/connections/cles": CATALOGUE });
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit = {}) => init.method === "POST"
    ? new Response(JSON.stringify({ detail: "Ce serveur refuse ce jeton. Rien n'a été enregistré." }), { status: 400 })
    : new Response(JSON.stringify(CATALOGUE), { status: 200 })));
  const added = vi.fn();
  const host = await render(<KeyConnectors agentId="a1" shared={false} tools={[]} onAdded={added} />);
  const card = [...host.querySelectorAll("div.rounded-lg")].find((d) => d.textContent?.includes("Airtable"))!;
  await act(async () => card.querySelector("button")!.click());
  await act(async () => type(host.querySelector<HTMLInputElement>('input[aria-label="Clé Airtable"]')!, "patXXXXXXXXXXXXXX"));
  await act(async () => host.querySelector<HTMLFormElement>("form")!.requestSubmit());
  await flush();
  expect(host.textContent).toContain("refuse ce jeton");
  expect(added).not.toHaveBeenCalled();
});

it("dans Connexions : GitHub branché, son logo, ses outils de lecture à part de ceux qui modifient", async () => {
  serve({
    "/api/agents/a1/connections": { google: { disponible: false }, applications: [], outils: [GITHUB_BRANCHE], globaux: [] },
    "/api/connections/cles": CATALOGUE,
    "/api/agents/a1/sites": [],
  });
  const host = await render(<Connections agentId="a1" />);
  const text = host.textContent ?? "";
  expect(text).toContain("GitHub");
  expect(text).toContain("Connecté");
  expect(text).toContain("2 en lecture, 1 qui modifient");
  expect(text).toContain("get_me, list_issues");
  expect(text).toContain("Qui modifient : demandent ton accord, selon ton autonomie");
  expect(text).toContain("create_issue");
  // GitHub branché ne se propose plus dans « Avec une clé » ; les trois autres oui.
  const keys = host.querySelector("[data-connecteurs-cles]")!.textContent ?? "";
  expect(keys).not.toContain("GitHub");
  expect(keys).toContain("Airtable");
  expect(host.innerHTML).not.toContain(CLE);
});
