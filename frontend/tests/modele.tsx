// Banc servi uniquement par Vite, absent des fichiers de production : une conversation écrite par deux modèles.
// `npm run dev`, puis http://localhost:5173/tests/modele.html ; ?lang=en pour l'anglais.
import { createRoot } from "react-dom/client";
import { AssistantRuntimeProvider, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import { Thread } from "../src/components/Thread";
import { Shell } from "../src/components/Shell";
import { ChatPane } from "../src/components/ChatPane";
import { BottomTabs } from "../src/components/mobile/BottomTabs";
import { MobileHeader } from "../src/components/mobile/MobileHeader";
import { SideRail } from "../src/components/desktop/SideRail";
import { ViewerProvider } from "../src/components/Viewer";
import { SensitiveProvider } from "../src/components/SensitiveText";
import { AgentContext } from "../src/lib/agentContext";
import { QuoteContext, useQuoteState } from "../src/lib/quotes";
import type { Agent } from "../src/lib/api";
import { choisirLangue } from "../src/i18n";
import "../src/index.css";

const lang = new URLSearchParams(location.search).get("lang");
if (lang === "en" || lang === "fr") choisirLangue(lang, false);

const agent = { id: "banc-modele", name: "Noah", online: true, role: "", tasks: {}, state: "idle", color: "#6a50e0", droit: "proprietaire" } as Agent;
const at = (min: number) => new Date(Date.now() - (60 - min) * 60_000);
const user = (id: string, text: string, min: number) => ({ id, role: "user", content: [{ type: "text", text }], createdAt: at(min) });
const reply = (id: string, text: string, min: number, model?: string) => ({ id, role: "assistant", content: [{ type: "text", text }], createdAt: at(min), status: { type: "complete", reason: "stop" }, metadata: { custom: { model } } });
const MESSAGES = [
  user("u1", "Résume-moi le rapport de vente de mars.", 1),
  reply("a1", "Les ventes de mars montent de 12 % sur un an, portées par la boutique en ligne.", 2, "openai/gpt-5.1"),
  user("u2", "Et les retours ?", 3),
  reply("a2", "Les retours baissent à 4 %, contre 6 % en février.", 4, "openai/gpt-5.1"),
  user("u3", "Rédige un courriel à l'équipe avec ces chiffres.", 5),
  reply("a3", "Voici un brouillon :\n\n> Bonjour à tous, mars finit à +12 % et les retours tombent à 4 %. Merci pour ce beau mois !", 6, "anthropic/claude-sonnet-4.5"),
] as unknown as ThreadMessageLike[];

function DemoChat() {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({ messages: MESSAGES, onNew: async () => {}, convertMessage: (m) => m });
  const quotes = useQuoteState();
  return <QuoteContext.Provider value={quotes.value}><AssistantRuntimeProvider runtime={runtime}><Thread report={null} onReportRead={() => {}} onCall={() => {}} /></AssistantRuntimeProvider></QuoteContext.Provider>;
}

function Harness() {
  return <SensitiveProvider><AgentContext.Provider value={{ agentId: agent.id, agentName: "Noah", agentColor: "#6a50e0", agentShape: "", agentDetail: "", agentModel: "Claude Sonnet 4.5", details: false, hint: "", conversationId: "banc-modele", say: () => {}, readOnly: false, canWatch: true }}><ViewerProvider><Shell>
    <SideRail agent={agent} tabs={["chat", "activity", "tasks", "files", "computer"]} active="chat" conversations={[]} onTab={() => {}} onAgent={() => {}} onMenu={() => {}} onThread={() => {}} onSettings={() => {}} onGoals={() => {}} onNew={() => {}} />
    <div className="flex min-h-0 min-w-0 flex-1 flex-col"><MobileHeader agent={agent} status="En ligne" onMenu={() => {}} onAgent={() => {}} onNew={() => {}} /><ChatPane title="Discussion" onAgent={() => {}}>
      <DemoChat />
    </ChatPane><BottomTabs tabs={["chat", "activity", "tasks", "files", "computer"]} active="chat" onSelect={() => {}} onCustomize={() => {}} /></div>
  </Shell></ViewerProvider></AgentContext.Provider></SensitiveProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
