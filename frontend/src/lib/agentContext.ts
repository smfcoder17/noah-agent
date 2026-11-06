import { createContext } from "react";
import type { WhileBusyApi } from "./useAgentChat";

export const WhileBusyContext = createContext<WhileBusyApi>({ active: false, activity: null, waiting: [], sending: [], send: () => {}, now: async () => "", cancel: () => {}, giveUp: () => {} });

// Ce que les composants du fil savent de l'agent affiché. `say` envoie un message comme si l'utilisateur l'avait tapé.
export const AgentContext = createContext<{ agentId: string; agentName: string; agentColor: string; agentShape: string; agentDetail: string; details: boolean; hint: string; conversationId: string | null; say: (text: string, clientId?: string) => void; readOnly: boolean; canWatch: boolean }>({
  agentId: "",
  agentName: "",
  agentColor: "",
  agentShape: "",
  agentDetail: "",
  details: false,
  hint: "",
  conversationId: null,
  say: () => {},
  readOnly: false,
  canWatch: false,
});
