// Demande depuis une carte : elle reste liée à l'agent d'origine, même après navigation.
let pending: { text: string; agent?: string } | null = null;
export function askAgent(text: string, agent?: string) {
  pending = { text, agent };
  window.dispatchEvent(new CustomEvent("noah:ask", { detail: { agentId: agent } }));
}
export function takeAsk(agent?: string): string | null {
  if (!pending || (pending.agent && pending.agent !== agent)) return null;
  const text = pending.text; pending = null; return text;
}
