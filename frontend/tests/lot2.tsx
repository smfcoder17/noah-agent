// Banc servi uniquement par Vite, absent des fichiers de production.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AssistantRuntimeProvider, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import { Thread } from "../src/components/Thread";
import { Shell } from "../src/components/Shell";
import { ChatPane } from "../src/components/ChatPane";
import { BottomTabs } from "../src/components/mobile/BottomTabs";
import { MobileHeader } from "../src/components/mobile/MobileHeader";
import { SideRail } from "../src/components/desktop/SideRail";
import { Providers } from "../src/components/Providers";
import { SettingsDialog } from "../src/components/Settings";
import { Competences } from "../src/components/Competences";
import { ElementCard } from "../src/components/elements/ElementCard";
import { SandboxedFrame } from "../src/components/elements/SandboxedFrame";
import { ViewerProvider } from "../src/components/Viewer";
import { SensitiveProvider } from "../src/components/SensitiveText";
import { AgentContext } from "../src/lib/agentContext";
import { QuoteContext, useQuoteState } from "../src/lib/quotes";
import { ELEMENTS, type ElementKind } from "../src/lib/elements";
import type { Agent } from "../src/lib/api";
import "../src/index.css";
const agent = { id: "lot2-banc", name: "Noah", online: true, role: "", tasks: {}, state: "idle", color: "#6a50e0", droit: "proprietaire" } as Agent;
function DemoChat() {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({ messages: [{ role: "assistant", content: [{ type: "text", text: "marc@gmail.com\n\nhttps://exemple.org/" }] }], onNew: async () => {}, convertMessage: (m) => m });
  const quotes = useQuoteState();
  return <QuoteContext.Provider value={quotes.value}><AssistantRuntimeProvider runtime={runtime}><Thread report={null} onReportRead={() => {}} onCall={() => {}} /></AssistantRuntimeProvider></QuoteContext.Provider>;
}
function Harness() {
  const [screen, setScreen] = useState("chat"), [kind, setKind] = useState<ElementKind>("grid");
  const [sandbox, showSandbox] = useState(false);
  useEffect(() => { const open = (e: Event) => { const d = (e as CustomEvent).detail; if (d.kind) { setKind(d.kind); setScreen("elements"); } else setScreen(d.screen); if (d.sandbox) showSandbox(true); }; window.addEventListener("lot2:test", open); return () => window.removeEventListener("lot2:test", open); }, []);
  return <SensitiveProvider><AgentContext.Provider value={{ agentId: agent.id, agentName: "Noah", agentColor: "#6a50e0", agentShape: "", agentDetail: "", agentModel: "Auto", details: false, hint: "", conversationId: "lot2-conversation", say: () => {}, readOnly: false, canWatch: true }}><ViewerProvider><Shell>
    <SideRail agent={agent} tabs={["chat", "activity", "tasks", "files", "computer"]} active="chat" conversations={[]} onTab={() => {}} onAgent={() => {}} onMenu={() => {}} onThread={() => {}} onSettings={() => setScreen("settings")} onGoals={() => {}} onNew={() => {}} />
    <div className="flex min-h-0 min-w-0 flex-1 flex-col"><MobileHeader agent={agent} status="En ligne" onMenu={() => {}} onAgent={() => {}} onNew={() => {}} /><ChatPane title="Discussion" onAgent={() => {}}>
      {screen === "chat" && <DemoChat />}{screen === "competence" && <Competences agentId={agent.id} />}{screen === "connection" && <Providers />}
      {screen === "elements" && <ElementCard spec={{ type: "element", kind, title: ELEMENTS[kind], source: "noah", size: 256, version: "2", url: ["page", "pdf", "image", "video", "audio", "unknown"].includes(kind) ? "/api/agents/lot2-banc/files/raw/test." + ({ page: "html", pdf: "pdf", image: "png", video: "mp4", audio: "mp3" } as Record<string, string>)[kind] : undefined, data: { items: [{ title: "Marc", subtitle: "marc@gmail.com" }], columns: ["Nom"], rows: [["Marc"]], text: "code", options: ["Oui", "Non"] } }} />}
      {sandbox && <SandboxedFrame title="Widget isolé" srcDoc={'<script>let blocked=false;try{document.cookie}catch(e){blocked=true}parent.postMessage({lot2CookieBlocked:blocked},"*")</script>'} />}
    </ChatPane><BottomTabs tabs={["chat", "activity", "tasks", "files", "computer"]} active="chat" onSelect={() => {}} onCustomize={() => {}} /></div>
    <SettingsDialog open={screen === "settings"} tab="brain" owner onTab={() => {}} onOpenChange={(o) => !o && setScreen("chat")} onBrainSaved={() => {}} />
  </Shell></ViewerProvider></AgentContext.Provider></SensitiveProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
