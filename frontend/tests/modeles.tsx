// Banc servi uniquement par Vite, absent des fichiers de production : l'étiquette du modèle sous la saisie, la fenêtre « Modèle de Noah »
// (la vraie, comme dans l'App) et 656 modèles de cinq fournisseurs. Sert à mesurer l'ouverture de la liste et le nombre de gestes
// (tools/eval/ui-modeles.mjs). `npm run dev`, puis http://localhost:5173/tests/modeles.html
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AssistantRuntimeProvider, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import { Thread } from "../src/components/Thread";
import { AgentBrain } from "../src/components/AgentBrain";
import { Dialog, DialogContent } from "../src/components/ui";
import { SensitiveProvider } from "../src/components/SensitiveText";
import { ViewerProvider } from "../src/components/Viewer";
import { AgentContext } from "../src/lib/agentContext";
import { QuoteContext, useQuoteState } from "../src/lib/quotes";
import "../src/index.css";

const COMPANIES = ["openai", "anthropic", "google", "meta-llama", "mistralai", "qwen", "deepseek", "x-ai", "z-ai", "moonshotai", "nvidia", "microsoft", "minimax", "cohere", "perplexity", "amazon", "ai21", "baidu", "tencent", "bytedance"];
type Row = { id: string; name: string; lab: string; created: number; context: number; price_in: number; price_out: number; vision: boolean; free: boolean; fournisseur: string };
const models: Row[] = [];
const add = (fournisseur: string, id: string, name: string, i: number) => models.push({ id, name, lab: id.includes("/") ? id.split("/")[0] : ({ openai: "openai", anthropic: "anthropic", gemini: "google" } as Record<string, string>)[fournisseur] ?? fournisseur, created: 1_700_000_000 + i * 86_400, context: 128_000, price_in: 0.1 + (i % 9), price_out: 0.5 + (i % 7), vision: i % 3 === 0, free: false, fournisseur });
for (let i = 0; i < 600; i++) { const c = COMPANIES[i % COMPANIES.length]; add("openrouter", `${c}/modele-${i}`, `${c}: Modèle ${i}`, i); }
for (let i = 0; i < 24; i++) add("openai", `gpt-${5 + (i >> 3)}.${i % 8}`, `GPT ${5 + (i >> 3)}.${i % 8}`, 700 + i);
for (let i = 0; i < 12; i++) add("anthropic", `claude-fable-${i}`, `Claude Fable ${i}`, 730 + i);
for (let i = 0; i < 12; i++) add("gemini", `gemini-${3 + (i >> 2)}-${["flash", "pro", "ultra", "lite"][i % 4]}`, `Gemini ${3 + (i >> 2)} ${["Flash", "Pro", "Ultra", "Lite"][i % 4]}`, 750 + i);
for (let i = 0; i < 8; i++) add("autre:vllm", `qwen3-${i}b`, `qwen3-${i}b`, 770 + i);
const brands = [["anthropic", "Anthropic (Claude)"], ["autre:vllm", "vLLM"], ["gemini", "Google Gemini"], ["openai", "OpenAI"], ["openrouter", "OpenRouter"]].map(([id, label]) => ({ id, label }));
const picked: unknown[] = [];
(window as unknown as { __picked: unknown[] }).__picked = picked;
(window as unknown as { __modeles: number }).__modeles = models.length;

// Le serveur, en une page : ce que l'App demande à l'ouverture de la fenêtre.
const answers = (path: string, init?: RequestInit): unknown => {
  if (path === "/api/model") return { provider: "openrouter", model: "openai/modele-0", has_key: true };
  if (path === "/api/modes/cerveau/modeles") return { modeles: models, fournisseurs: brands };
  if (path === "/api/modes/cerveau") return { niveau: "cerveau", actif: null, en_service: "openai/modele-0", modes: [], gratuit: [], custom: [] };
  if (/^\/api\/agents\/[^/]+\/model$/.test(path) && init?.method === "PUT") { picked.push(JSON.parse(String(init.body))); return { ok: true }; }
  return {};
};
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => Response.json(answers(String(input), init))) as typeof fetch;

function Chat() {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({ messages: [], onNew: async () => {}, convertMessage: (m) => m });
  const quotes = useQuoteState();
  return <QuoteContext.Provider value={quotes.value}><AssistantRuntimeProvider runtime={runtime}><Thread report={null} onReportRead={() => {}} onCall={() => {}} /></AssistantRuntimeProvider></QuoteContext.Provider>;
}

function Harness() {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("GPT 5.1");
  useEffect(() => { const show = () => setOpen(true); window.addEventListener("noah:choisir-modele", show); return () => window.removeEventListener("noah:choisir-modele", show); }, []);
  useEffect(() => { const heard = () => setLabel("changé"); window.addEventListener("noah:cerveau", heard); return () => window.removeEventListener("noah:cerveau", heard); }, []);
  return <SensitiveProvider><AgentContext.Provider value={{ agentId: "banc", agentName: "Noah", agentColor: "#6a50e0", agentShape: "", agentDetail: "", agentModel: label, details: false, hint: "", conversationId: "banc", say: () => {}, readOnly: false, canWatch: true }}><ViewerProvider>
    <div className="flex h-dvh min-h-0 flex-col"><Chat /></div>
    <Dialog open={open} onOpenChange={setOpen}>
      {open && <DialogContent title="Modèle de Noah" description="Ton choix vaut pour cet agent seulement, tout de suite. Ses conversations restent." className="max-w-xl">
        <AgentBrain agentId="banc" own={null} mode={null} reasoning={null} onChanged={() => setOpen(false)} openKey={1} bare precise />
      </DialogContent>}
    </Dialog>
  </ViewerProvider></AgentContext.Provider></SensitiveProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
