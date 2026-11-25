// Lot B de la 0.3.0 (coffre) côté écran : Réglages > Coffre ne montre aucune valeur sans preuve, l'import dit pourquoi une ligne
// est refusée ; la carte de connexion propose de choisir un compte retenu ; la liste des sessions dit leur état vérifié.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { BrowserSites } from "./AgentPowers";
import { LoginCard, SavedLogins } from "./LoginCard";
import { Vault } from "./Vault";

const MDP = "valeur-Secrete-91x";
const ELEMENTS = [
  { id: "login_1", genre: "login", nom: "", site: "instagram.com", origine: "https://www.instagram.com", apercu: "fr•••", utilise_a: null },
  { id: "carte_1", genre: "carte", nom: "Visa", site: "", origine: "", apercu: "Visa •••• 4242 · 12/30", utilise_a: null },
];

type Call = { url: string; method: string; body: string };
type Route = unknown | ((body: Record<string, unknown>) => [number, unknown]);
class NoObserver { observe() {} disconnect() {} unobserve() {} }
function serve(routes: Record<string, Route>) {
  const calls: Call[] = [];
  vi.stubGlobal("IntersectionObserver", NoObserver);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: String(init.body ?? "") });
    const path = url.split("?")[0];
    const key = `${init.method ?? "GET"} ${path}`;
    const found = key in routes ? routes[key] : path in routes ? routes[path] : undefined;
    if (found === undefined) return new Response(JSON.stringify({ detail: "absent" }), { status: 404 });
    const [status, json] = typeof found === "function" ? (found as (b: Record<string, unknown>) => [number, unknown])(JSON.parse(String(init.body || "{}"))) : [200, found];
    return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
  }));
  return calls;
}

function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
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

const button = (root: ParentNode, label: string) => [...root.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === label || b.textContent === label)!;

it("B6 la liste du coffre ne porte aucune valeur ; voir demande la preuve, puis montre la valeur", async () => {
  const calls = serve({
    "/api/coffre": { elements: ELEMENTS, agents: [{ id: "a1", nom: "Noah", utiliser: true, partage: false }, { id: "a2", nom: "Équipe", utiliser: false, partage: true }] },
    "/api/me/double-verification": { active: false },
    "POST /api/coffre/login_1/voir": (b: Record<string, unknown>) => b.motdepasse === "bon" ? [200, { identifiant: "franck@exemple.fr", mot_de_passe: MDP }] : [428, { detail: "Confirme ton mot de passe pour voir ce secret." }],
  });
  const host = await render(<Vault />);
  expect(host.textContent).toContain("instagram.com");
  expect(host.textContent).toContain("Visa •••• 4242 · 12/30");
  expect(host.textContent).toContain("partagé : éteint d'office");
  expect(host.innerHTML).not.toContain(MDP);
  await act(async () => button(host, "Voir instagram.com").click());
  await flush();
  const password = document.body.querySelector<HTMLInputElement>("#proof-password")!;
  expect(password).not.toBeNull();
  expect(host.innerHTML).not.toContain(MDP);
  await act(async () => type(password, "bon"));
  await act(async () => password.form!.requestSubmit());
  await flush();
  expect(host.textContent).toContain(MDP);
  const sent = calls.filter((c) => c.url === "/api/coffre/login_1/voir").map((c) => JSON.parse(c.body));
  expect(sent[sent.length - 1]).toMatchObject({ motdepasse: "bon" });
  await act(async () => button(host, "Cacher instagram.com").click());
  expect(host.innerHTML).not.toContain(MDP);
});

it("B6 import CSV : le compte rendu dit chaque ligne refusée et sa raison", async () => {
  const calls = serve({
    "/api/coffre": { elements: [], agents: [] },
    "POST /api/coffre/import": { ajoutes: 2, remplaces: 0, refuses: [{ ligne: 3, raison: "Adresse du site manquante ou illisible." }] },
  });
  const host = await render(<Vault />);
  expect(host.textContent).toContain("Ton coffre est vide.");
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  const csv = "name,url,username,password\nA,https://www.instagram.com,x,p1\nB,,x,p2\nC,https://www.linkedin.com,x,p3\n";
  const file = new File([csv], "export.csv", { type: "text/csv" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
  await flush();
  await flush();
  expect(JSON.parse(calls.find((c) => c.url === "/api/coffre/import")!.body)).toEqual({ csv });
  expect(host.textContent).toContain("2 ajoutés, 0 mis à jour, 1 refusés");
  expect(host.textContent).toContain("Ligne 3 : Adresse du site manquante ou illisible.");
});

it("B6 ajouter un identifiant : un vrai formulaire, le mot de passe masqué", async () => {
  const calls = serve({ "/api/coffre": { elements: [], agents: [] }, "POST /api/coffre": ELEMENTS[0] });
  const host = await render(<Vault />);
  await act(async () => button(host, "Ajouter : Identifiant").click());
  const inputs = [...host.querySelectorAll<HTMLInputElement>("form input")];
  const [, origin, ident, pwd] = inputs;
  expect(pwd.type).toBe("password");
  await act(async () => { type(origin, "instagram.com"); type(ident, "franck"); type(pwd, MDP); });
  await act(async () => host.querySelector<HTMLFormElement>("form")!.requestSubmit());
  await flush();
  expect(JSON.parse(calls.find((c) => c.method === "POST" && c.url === "/api/coffre")!.body)).toEqual({ genre: "login", nom: "", origine: "instagram.com", identifiant: "franck", mot_de_passe: MDP });
  expect(host.innerHTML).not.toContain(MDP);
});

const CLE_API = "sk-faux-Zq81xKLm92pTrW";
const CLE_ELEMENT = { id: "cle_api_1", genre: "cle_api", nom: "OpenAI", site: "openai.com", origine: "https://api.openai.com", apercu: "Authorization", utilise_a: null };

it("clé d'API : la liste ne porte pas la valeur, voir demande la preuve, la suppression se confirme dans une fenêtre", async () => {
  const calls = serve({
    "/api/coffre": { elements: [CLE_ELEMENT], agents: [] },
    "/api/me/double-verification": { active: false },
    "POST /api/coffre/cle_api_1/voir": (b: Record<string, unknown>) => b.motdepasse === "bon" ? [200, { cle: CLE_API, entete: "" }] : [428, { detail: "Confirme ton mot de passe pour voir ce secret." }],
    "DELETE /api/coffre/cle_api_1": { ok: true },
  });
  const host = await render(<Vault />);
  expect(host.textContent).toContain("OpenAI");
  expect(host.textContent).toContain("Clé d'API · Authorization");
  expect(host.innerHTML).not.toContain(CLE_API);
  await act(async () => button(host, "Voir OpenAI").click());
  await flush();
  const password = document.body.querySelector<HTMLInputElement>("#proof-password")!;
  expect(password).not.toBeNull();
  expect(host.innerHTML).not.toContain(CLE_API);
  await act(async () => type(password, "bon"));
  await act(async () => password.form!.requestSubmit());
  await flush();
  expect(host.textContent).toContain(CLE_API);
  expect(host.textContent).toContain("Authorization");
  await act(async () => button(host, "Supprimer OpenAI").click());
  expect(document.body.textContent).toContain("Supprimer OpenAI du coffre ?");
  expect(calls.some((c) => c.method === "DELETE")).toBe(false); // rien ne part avant la confirmation dans la fenêtre
  await act(async () => button(document.body, "Supprimer").click());
  await flush();
  expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/coffre/cle_api_1")).toBe(true);
});

it("ajouter une clé d'API : adresse, en-tête au choix, clé masquée ; modifier avec les champs vides garde la valeur", async () => {
  const calls = serve({ "/api/coffre": { elements: [CLE_ELEMENT], agents: [] }, "POST /api/coffre": CLE_ELEMENT, "PUT /api/coffre/cle_api_1": CLE_ELEMENT });
  const host = await render(<Vault />);
  await act(async () => button(host, "Ajouter : Clé d'API").click());
  const [nom, origine, entete, cle] = [...host.querySelectorAll<HTMLInputElement>("form input")];
  expect(cle.type).toBe("password");
  await act(async () => { type(nom, "Anthropic"); type(origine, "https://api.anthropic.com"); type(entete, "x-api-key"); type(cle, CLE_API); });
  await act(async () => host.querySelector<HTMLFormElement>("form")!.requestSubmit());
  await flush();
  expect(JSON.parse(calls.find((c) => c.method === "POST" && c.url === "/api/coffre")!.body)).toEqual({ genre: "cle_api", nom: "Anthropic", origine: "https://api.anthropic.com", entete: "x-api-key", cle: CLE_API });
  expect(host.innerHTML).not.toContain(CLE_API);
  await act(async () => button(host, "Modifier OpenAI").click());
  const form = host.querySelector<HTMLFormElement>("form")!;
  expect(form.querySelector<HTMLInputElement>('input[type="password"]')!.placeholder).toBe("Inchangé si vide");
  await act(async () => form.requestSubmit());
  await flush();
  expect(JSON.parse(calls.find((c) => c.method === "PUT")!.body)).toEqual({ genre: "cle_api", nom: "OpenAI", origine: "https://api.openai.com" }); // ni clé ni en-tête : ils gardent leur valeur côté serveur
});

it("B1 deux comptes retenus : la carte demande lequel et n'envoie que le choix", async () => {
  const calls = serve({ "POST /api/agents/a1/connexions/q1": { ok: true, page: "changee" } });
  const done = vi.fn();
  const asked = { id: "q1", type: "connexion" as const, site: "instagram.com", origine: "https://www.instagram.com", chiffre: true, identifiant_requis: true,
    comptes: [{ id: "login_1", nom: "Perso", compte: "fr•••" }, { id: "login_2", nom: "Boutique", compte: "bo•••" }] };
  const host = await render(<LoginCard agentId="a1" asked={asked} onDone={done} />);
  expect(host.textContent).toContain("Quel compte ?");
  expect(host.textContent).toContain("Boutique · bo•••");
  expect(host.querySelector('input[type="password"]')).toBeNull();
  const radios = [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
  await act(async () => radios[1].click());
  await act(async () => host.querySelector<HTMLFormElement>("form")!.requestSubmit());
  await flush();
  expect(JSON.parse(calls[0].body)).toEqual({ choix: "login_2" });
  expect(done).toHaveBeenCalledWith("envoye");
});

it("B5 les sessions affichées sont celles du registre vérifié, avec leur état", async () => {
  serve({ "/api/agents/a1/sites": [
    { hote: "instagram.com", nom: "instagram.com", compte: "", vu_a: 1, etat: "connecte" },
    { hote: "linkedin.com", nom: "LinkedIn", compte: "", vu_a: 1, etat: "a_reconnecter" },
    { hote: "ancien.fr", nom: "Ancien", compte: "", vu_a: 1, etat: "non_verifie" },
  ] });
  const host = await render(<BrowserSites agentId="a1" />);
  const rows = [...host.querySelectorAll("li")].map((li) => li.textContent);
  expect(rows[0]).toContain("Connecté");
  expect(rows[1]).toContain("À reconnecter");
  expect(rows[2]).toContain("Non vérifié");
  expect(host.textContent).toContain("Sessions dans son navigateur");
});

// Relecture GLM 0.3.0 (docs/epics/0.3.0/revue-glm.md).
it("P0n5 « Retirer » une session dit que les identifiants restent dans le coffre", async () => {
  serve({ "/api/agents/a1/sites": [{ hote: "instagram.com", nom: "instagram.com", compte: "", vu_a: 1, etat: "connecte" }] });
  const host = await render(<BrowserSites agentId="a1" />);
  expect(host.textContent).toContain("Les identifiants retenus restent dans Réglages > Coffre");
});

it("P1n2 une nouvelle demande repart du premier compte proposé, jamais d'un choix d'avant", async () => {
  const calls = serve({ "POST /api/agents/a1/connexions/q2": { ok: true, page: "changee" } });
  const base = { type: "connexion" as const, site: "instagram.com", origine: "https://www.instagram.com", chiffre: true, identifiant_requis: true };
  const first = { ...base, id: "q1", comptes: [{ id: "login_1", nom: "Perso", compte: "fr•••" }, { id: "login_2", nom: "Boutique", compte: "bo•••" }] };
  const second = { ...base, id: "q2", comptes: [{ id: "login_3", nom: "Pro", compte: "pr•••" }, { id: "login_1", nom: "Perso", compte: "fr•••" }] };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  unmount = () => { act(() => root.unmount()); host.remove(); };
  await act(async () => root.render(<LoginCard agentId="a1" asked={first} onDone={vi.fn()} />));
  await act(async () => [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')][1].click());
  await act(async () => root.render(<LoginCard agentId="a1" asked={second} onDone={vi.fn()} />)); // même carte, nouvelle demande
  expect(host.querySelectorAll<HTMLInputElement>('input[type="radio"]')[0].checked).toBe(true);
  await act(async () => host.querySelector<HTMLFormElement>("form")!.requestSubmit());
  await flush();
  expect(JSON.parse(calls[0].body)).toEqual({ choix: "login_3" });
});

it("P1n3 ajouter un identifiant : l'identifiant est requis, comme le mot de passe", async () => {
  serve({ "/api/coffre": { elements: [], agents: [] } });
  const host = await render(<Vault />);
  await act(async () => button(host, "Ajouter : Identifiant").click());
  const [, , ident, pwd] = [...host.querySelectorAll<HTMLInputElement>("form input")];
  expect(ident.required).toBe(true);
  expect(pwd.required).toBe(true);
});

it("P1n5 un refus sur le droit du coffre n'efface pas la liste des identifiants retenus", async () => {
  serve({
    "/api/agents/a1/coffre-droit": () => [500, { detail: "Panne passagère" }],
    "/api/agents/a1/coffre": [{ id: "login_1", site: "instagram.com", origine: "https://www.instagram.com" }],
  });
  const host = await render(<SavedLogins agentId="a1" />);
  expect(host.textContent).toContain("instagram.com");
  expect(host.textContent).toContain("Panne passagère");
});

// Relecture 0.3.0 du coffre (B-1, D2, D6, suppression, point 12).
it("Suppression : la confirmation est dans l'interface, plus de confirm() du navigateur", async () => {
  const native = vi.fn(() => true);
  vi.stubGlobal("confirm", native);
  const calls = serve({ "/api/coffre": { elements: ELEMENTS, agents: [] }, "DELETE /api/coffre/login_1": { ok: true } });
  const host = await render(<Vault />);
  await act(async () => button(host, "Supprimer instagram.com").click());
  await flush();
  expect(native).not.toHaveBeenCalled();
  const dialog = document.body.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("Supprimer instagram.com du coffre ?");
  expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  await act(async () => button(dialog, "Supprimer").click());
  await flush();
  expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual(["/api/coffre/login_1"]);
});

it("D2 changer l'adresse d'un identifiant demande la preuve, puis repart avec elle", async () => {
  const calls = serve({
    "/api/coffre": { elements: ELEMENTS, agents: [] },
    "/api/me/double-verification": { active: false },
    "PUT /api/coffre/login_1": (b: Record<string, unknown>) => b.motdepasse === "bon" ? [200, ELEMENTS[0]] : [428, { detail: "Confirme ton mot de passe pour changer l'adresse ou l'identifiant." }],
  });
  const host = await render(<Vault />);
  await act(async () => button(host, "Modifier instagram.com").click());
  const [, origin] = [...host.querySelectorAll<HTMLInputElement>("form input")];
  await act(async () => type(origin, "https://ailleurs.exemple.net"));
  await act(async () => host.querySelector<HTMLFormElement>("form")!.requestSubmit());
  await flush();
  const password = document.body.querySelector<HTMLInputElement>("#proof-password")!;
  expect(password).not.toBeNull();
  await act(async () => type(password, "bon"));
  await act(async () => password.form!.requestSubmit());
  await flush();
  const sent = calls.filter((c) => c.method === "PUT").map((c) => JSON.parse(c.body));
  expect(sent[sent.length - 1]).toMatchObject({ origine: "https://ailleurs.exemple.net", motdepasse: "bon" });
});

it("12 et D6 Connexions : deux comptes du même site se distinguent, « Retirer de cet agent » garde l'identifiant au coffre", async () => {
  const calls = serve({
    "/api/agents/a1/coffre-droit": { utiliser: true, partage: false },
    "/api/agents/a1/coffre": [
      { id: "login_1", nom: "example.test", site: "example.test", origine: "https://example.test", compte: "fr•••" },
      { id: "login_2", nom: "example.test", site: "example.test", origine: "https://example.test", compte: "bo•••" },
    ],
    "DELETE /api/agents/a1/coffre/login_2": { ok: true },
  });
  const host = await render(<SavedLogins agentId="a1" />);
  const rows = [...host.querySelectorAll("li")].map((li) => li.textContent);
  expect(rows[0]).toContain("fr•••");
  expect(rows[1]).toContain("bo•••");
  expect(host.textContent).not.toContain("Oublier");
  expect(host.textContent).toContain("L'identifiant reste dans ton coffre");
  await act(async () => button(host, "Retirer example.test · bo••• de cet agent").click());
  await flush();
  expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual(["/api/agents/a1/coffre/login_2"]);
});

it("B-1 la carte « Quel compte ? » dit l'adresse d'un compte retenu sur un autre hôte que la page", async () => {
  serve({});
  const asked = { id: "q1", type: "connexion" as const, site: "free.fr", origine: "https://pirate.free.fr", chiffre: true, identifiant_requis: true,
    comptes: [{ id: "login_1", nom: "Freebox", compte: "fr•••", origine: "https://adsl.free.fr" }] };
  const host = await render(<LoginCard agentId="a1" asked={asked} onDone={vi.fn()} />);
  expect(host.textContent).toContain("https://pirate.free.fr");
  expect(host.textContent).toContain("Freebox · fr••• · retenu pour https://adsl.free.fr");
});
