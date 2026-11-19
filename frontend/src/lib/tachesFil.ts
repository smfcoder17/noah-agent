import type { ChatMessage } from "./useAgentChat";
import type { TacheDuFil } from "./ouverture";

/**
 * Les tâches dans le fil (0.4.0, socle.md 3.1). Une tâche prend la place de sa ligne de trace quand le fil en a écrit une ; sinon (sous-tâche
 * d'un agent, routine, initiative, discussion) elle se place avant le premier message écrit après son ancre, ou en bas si rien n'a suivi.
 * Une trace dont la tâche n'est pas connue de cet écran reste telle quelle : `TraceOutil` la lit. Les messages ne bougent pas : seul ce qui
 * s'affiche change, et la tâche y garde le même identifiant d'un affichage à l'autre.
 */
export function avecTaches(base: ChatMessage[], taches: readonly TacheDuFil[] | undefined): ChatMessage[] {
  if (!taches?.length) return base;
  const parConversation = new Map(taches.map((t) => [t.conversation_id, t]));
  const placees = new Set<string>();
  const out = base.map((m) => {
    const trace = m.content.find((p) => p.type === "tool-call" && p.toolName === "trace");
    const tache = trace && trace.type === "tool-call" ? parConversation.get(String((trace.args as { fil?: string }).fil ?? "")) : undefined;
    if (!tache) return m;
    placees.add(tache.id);
    return { ...m, trace: undefined, content: [{ type: "tool-call" as const, toolCallId: `tache-${tache.id}`, toolName: "tache", args: { tache }, result: true }] };
  });
  const libres = taches.filter((t) => !placees.has(t.id)).sort((a, b) => a.ancre - b.ancre || a.cree - b.cree);
  for (const tache of libres) {
    const line: ChatMessage = {
      id: `tache-${tache.id}`, role: "assistant", createdAt: new Date(tache.cree * 1000),
      content: [{ type: "tool-call", toolCallId: `tache-${tache.id}`, toolName: "tache", args: { tache } as never, result: true }],
    };
    let at = out.findIndex((m) => m.storedId !== undefined && m.storedId > tache.ancre);
    if (at < 0) at = out.findIndex((m) => m.running);
    if (at < 0) out.push(line);
    else out.splice(at, 0, line);
  }
  return out;
}
