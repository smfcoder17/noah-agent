// Un message à l'agent depuis ailleurs que le fil (Détails → Connexions…) : App bascule sur la conversation
// principale, qui l'envoie comme si l'utilisateur l'avait tapé.
let pending: string | null = null;

export function askAgent(text: string) {
  pending = text;
  window.dispatchEvent(new Event("noah:ask"));
}

export function takeAsk(): string | null {
  const text = pending;
  pending = null;
  return text;
}
