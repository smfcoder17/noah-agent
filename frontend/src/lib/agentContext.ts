import { createContext } from "react";
import type { WhileBusyApi } from "./useAgentChat";

export type History = { hasOlder: boolean; loading: boolean; loadOlder: () => Promise<void>; react: (id: string, stored: number, emoji: string | null) => void };
export const HistoryContext = createContext<History>({ hasOlder: false, loading: false, loadOlder: async () => {}, react: () => {} });

export const WhileBusyContext = createContext<WhileBusyApi>({ active: false, activity: null, waiting: [], sending: [], send: () => {}, now: async () => "", cancel: () => {}, giveUp: () => {} });

// Ce que les composants du fil savent de l'agent affiché. `say` envoie un message comme si l'utilisateur l'avait tapé.
export const AgentContext = createContext<{ agentId: string; agentName: string; agentColor: string; agentShape: string; agentDetail: string; agentModel: string; details: boolean; hint: string; conversationId: string | null; say: (text: string, clientId?: string) => void; readOnly: boolean; canWatch: boolean }>({
  agentId: "",
  agentName: "",
  agentColor: "",
  agentShape: "",
  agentDetail: "", agentModel: "",
  details: false,
  hint: "",
  conversationId: null,
  say: () => {},
  readOnly: false,
  canWatch: false,
});
