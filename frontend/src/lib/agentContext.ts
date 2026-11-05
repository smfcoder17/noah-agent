import { createContext } from "react";
import type { WhileBusyApi } from "./useAgentChat";

export const WhileBusyContext = createContext<WhileBusyApi>({ active: false, activity: null, waiting: [], sending: [], send: () => {}, now: () => {}, cancel: () => {} });

// Ce que les composants du fil savent de l'agent affiché. `say` envoie un message comme si l'utilisateur l'avait tapé.
export const AgentContext = createContext<{ agentId: string; agentName: string; agentColor: string; agentShape: string; agentDetail: string; hint: string; conversationId: string | null; say: (text: string, clientId?: string) => void; readOnly: boolean; canWatch: boolean }>({
  agentId: "",
  agentName: "",
  agentColor: "",
  agentShape: "",
  agentDetail: "",
  hint: "",
  conversationId: null,
  say: () => {},
  readOnly: false,
  canWatch: false,
});
