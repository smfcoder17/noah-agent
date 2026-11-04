import { createContext } from "react";

// Ce que les composants du fil savent de l'agent affiché. `say` envoie un message comme si l'utilisateur l'avait tapé.
export const AgentContext = createContext<{ agentId: string; agentName: string; agentColor: string; hint: string; say: (text: string) => void; readOnly: boolean; canWatch: boolean }>({
  agentId: "",
  agentName: "",
  agentColor: "",
  hint: "",
  say: () => {},
  readOnly: false,
  canWatch: false,
});
