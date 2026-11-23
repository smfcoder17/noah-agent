// Banc servi uniquement par Vite, absent des fichiers de production : les écrans du lot « modèles et fournisseurs », sur de fausses réponses
// du serveur. `?vue=pour-toi | fournisseurs | cerveau | confidentialite`, `&lang=en` pour l'anglais.
import { createRoot } from "react-dom/client";
import { Inbox } from "../src/components/Inbox";
import { SettingsPage, type SettingsTab } from "../src/components/Settings";
import type { Agent } from "../src/lib/api";
import { choisirLangue } from "../src/i18n";
import "../src/index.css";

const query = new URLSearchParams(location.search);
if (query.get("lang") === "en") choisirLangue("en", false);
const vue = query.get("vue") ?? "pour-toi";

const provider = (id: string, label: string, over: object = {}) => ({ id, label, connected: true, models: 12, base_url: "", needs_key: true, own_url: false, ordinateur: false, pret: null, autre: false, en_service: false, ...over });
const fournisseurs = [
  provider("openrouter", "OpenRouter", { models: 300 }),
  provider("openai", "OpenAI", { models: 24 }),
  provider("autre:vllm", "vLLM", { models: 4, autre: true, own_url: true, needs_key: false, base_url: "http://vllm.local:8000/v1" }),
  provider("autre:ollama", "Ollama maison", { models: 2, autre: true, own_url: true, needs_key: false, base_url: "http://nas:11434/v1", en_service: true }),
  provider("autre:lm-studio", "LM Studio", { models: 1, autre: true, own_url: true, needs_key: false, base_url: "http://pc:1234/v1" }),
  provider("anthropic", "Anthropic (Claude)", { connected: false, models: 0 }),
  provider("gemini", "Google Gemini", { connected: false, models: 0 }),
];
const link = (modele: string, nom: string, fournisseur: string) => ({ modele, nom, fournisseur, price_in: 0.5, price_out: 1.5, free: false });
const modes = { niveau: "cerveau", actif: null, en_service: "qwen3", gratuit: [], custom: [], modes: [
  { id: "fast", personnalise: false, modele: link("mistral-small-3.2", "Mistral Small 3.2", "autre:vllm") },
  { id: "balanced", personnalise: false, modele: link("qwen3", "Qwen3", "autre:ollama") },
  { id: "smart", personnalise: false, modele: link("openai/gpt-5.1", "GPT 5.1", "openrouter") },
] };
const flux = [
  { quoi: "Cerveau de Noah", agent: "a1", vers: "vllm.local", detail: "vLLM · qwen3", dernier_tour: true, quand: "à chaque message et à chaque étape d'une tâche", local: false },
  { quoi: "Cerveau de Léa", agent: "a2", vers: "openrouter.ai", detail: "OpenRouter · openai/gpt-5.1", dernier_tour: true, quand: "à chaque message et à chaque étape d'une tâche", local: false },
  { quoi: "Cerveau de Max", agent: "a3", vers: "ton ordinateur", detail: "ton abonnement Claude, sur ton ordinateur · sonnet", dernier_tour: true, quand: "à chaque message et à chaque étape d'une tâche", local: true },
  { quoi: "Cerveau de Zoé", agent: "a4", vers: "selon la demande", detail: "mode auto : le modèle se choisit à chaque demande, aucun tour pour l'instant", dernier_tour: false, quand: "à chaque message et à chaque étape d'une tâche", local: false },
];
const answers = (path: string): unknown => {
  if (path === "/api/accords") return [];
  if (path === "/api/fournisseurs") return fournisseurs;
  if (path === "/api/model") return { provider: "autre:ollama", model: "qwen3", has_key: true };
  if (path === "/api/modes/cerveau") return modes;
  if (path === "/api/usage") return { month_cost: 1.2, budget: 20, daily: null, agents: [] };
  if (path === "/api/flux") return { flux };
  if (path === "/api/decision") return { modele: "mistralai/ministral-8b", nom: "Ministral 8B", secours: false, raison: "moins cher", prix_entree: 0.1, ms: 420, choisi_par: "auto", candidats: [], cerveau: "qwen3", en_cours: false, mesure: true,
    type: null, decisions: [], ecartes: [], aucun: false, petits: [{ modele: "mistralai/ministral-8b", nom: "Ministral 8B", prix_entree: 0.1 }], cles: { openrouter: true, typesafe: false, openai: false } };
  if (path === "/api/a-toi") return [{ type: "decision", id: "decision-echec", modele: "mistralai/ministral-8b", raison: "Clé refusée par OpenRouter (401).", created: 1_700_000_000, cree: 1_700_000_000 }];
  return {};
};
window.fetch = (async (input: RequestInfo | URL) => Response.json(answers(String(input)))) as typeof fetch;

const TABS: Record<string, SettingsTab> = { fournisseurs: "providers", cerveau: "brain", confidentialite: "privacy" };
const root = createRoot(document.getElementById("root")!);
if (vue === "pour-toi") root.render(<div className="flex h-dvh flex-col"><Inbox open page agents={[{ id: "a1", name: "Noah" } as Agent]} onOpenChange={() => {}} onOpenConversation={() => {}} /></div>);
else root.render(<SettingsPage tab={TABS[vue]} owner onTab={() => {}} onClose={() => {}} onBrainSaved={() => {}} />);
