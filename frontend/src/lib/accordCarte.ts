// Carte d'accord : une commande de plusieurs lignes se montre en entier, telle qu'elle partira. Le plugin de garde
// (agent_plugin, _shown_call) écrit « Outil : terminal » puis les arguments en JSON sur une ligne ; au-delà de ce
// qu'une carte affiche, il refuse la commande au lieu de la demander.
const TOOL_LINE = /(?:^|\n)Outil : (terminal|execute_code)\n([^\n]*)/;

export function fullCommand(summary: unknown): string | null {
  if (typeof summary !== "string") return null;
  const found = TOOL_LINE.exec(summary);
  if (!found) return null;
  try {
    const args = JSON.parse(found[2]) as Record<string, unknown>;
    const text = found[1] === "terminal" ? args.command : args.code;
    return typeof text === "string" && text.trim().includes("\n") ? text : null;
  } catch {
    return null; // coupé avec son empreinte : la carte garde ses détails
  }
}
