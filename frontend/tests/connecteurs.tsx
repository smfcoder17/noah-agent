// Banc servi uniquement par Vite, absent des fichiers de production : l'onglet Connexions d'un agent, avec les connecteurs à clé.
// `npm run dev`, puis http://localhost:5173/tests/connecteurs.html ; ?lang=en pour l'anglais, ?github=1 pour GitHub déjà branché.
// Le serveur est simulé ici : une clé qui commence par « github_pat_ » est acceptée, toute autre est refusée comme le ferait GitHub.
import { createRoot } from "react-dom/client";
import { choisirLangue } from "../src/i18n";
import "../src/index.css";

const params = new URLSearchParams(location.search);
const lang = params.get("lang");
if (lang === "en" || lang === "fr") choisirLangue(lang, false);

const CATALOGUE = [
  { nom: "github", titre: "GitHub", hote: "github.com", lien: "https://github.com/settings/personal-access-tokens/new", droit: "confirmer" },
  { nom: "airtable", titre: "Airtable", hote: "airtable.com", lien: "https://airtable.com/create/tokens", droit: "confirmer" },
  { nom: "stripe-lecture", titre: "Stripe", hote: "stripe.com", lien: "https://dashboard.stripe.com/apikeys", droit: "confirmer" },
  { nom: "apify", titre: "Apify", hote: "apify.com", lien: "https://console.apify.com/settings/integrations", droit: "confirmer" },
];
const GITHUB_OUTILS = [
  ["get_me", true], ["search_repositories", true], ["list_issues", true], ["issue_read", true], ["get_file_contents", true],
  ["issue_write", false], ["add_issue_comment", false], ["create_pull_request", false], ["push_files", false],
].map(([nom, lecture]) => ({ nom, description: "", lecture_seule: lecture }));
let outils = params.get("github") ? [github("confirmer")] : [];

function github(droit: string) {
  return { nom: "github", url: "https://api.githubcopilot.com/mcp/", hote: "github.com", auth: "jeton", jeton: true, droit, etat: "ok", erreur: "", connecte: true, outils: GITHUB_OUTILS };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
window.fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const path = String(input).split("?")[0];
  const method = init.method ?? "GET";
  if (path === "/api/connections/cles") return json(CATALOGUE);
  if (path === "/api/agents/banc/connections") return json({ google: { disponible: false }, applications: [], outils, globaux: [] });
  if (method === "POST" && path.startsWith("/api/agents/banc/connections/cles/")) {
    const { jeton, droit } = JSON.parse(String(init.body));
    if (!String(jeton).startsWith("github_pat_")) return json({ detail: "Ce serveur refuse ce jeton. Rien n'a été enregistré." }, 400);
    outils = [github(droit)];
    return json({ nom: "github", outils: GITHUB_OUTILS });
  }
  if (method === "PUT" && path.endsWith("/droit")) {
    const { droit } = JSON.parse(String(init.body));
    outils = [github(droit)];
    return json({ droit });
  }
  if (path === "/api/agents/banc/sites" || path === "/api/agents/banc/coffre") return json([]);
  return json({ detail: "absent du banc" }, 404);
};

// AgentPowers calcule certains textes au chargement de son module : la langue est choisie avant de l'importer.
const { Connections } = await import("../src/components/AgentPowers");
createRoot(document.getElementById("root")!).render(
  <div className="mx-auto flex max-w-xl flex-col gap-3 p-4">
    <Connections agentId="banc" owner={false} />
  </div>,
);
