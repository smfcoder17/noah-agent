import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

// Le message envoyé garde ses pastilles : elles se réaffichent dans le fil, et une pastille de fichier ouvre son aperçu au clic.
vi.hoisted(() => {
  window.matchMedia = ((query: string) => ({ matches: false, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false })) as typeof window.matchMedia;
});
const view = vi.fn();
const download = vi.fn();
vi.mock("../Viewer", () => ({ useViewer: () => view, useDownload: () => download, canFrame: (p: string) => /\.(md|html|pdf)$/.test(p) }));
const get = vi.fn(async (_path: string): Promise<unknown> => ({ agents: [{ id: "b1", nom: "Marie", role: "Rédige les comptes rendus", color: "#c2410c", shape: "", detail: "" }] }));
vi.mock("@/lib/api", async (real) => ({ ...(await real<typeof import("@/lib/api")>()), get: (path: string) => get(path) }));
import { AgentContext } from "@/lib/agentContext";
import MentionText from "./MentionText";

const base = { agentId: "z9", agentName: "Noah", agentColor: "#c2410c", agentShape: "gomme", agentDetail: "", agentModel: "", details: false, hint: "", conversationId: null, say: () => {}, readOnly: false, canWatch: false };
const TEXT = "Résume [@plan.md](noah:fichier/outputs/plan.md) et [@brouillon.xlsx](noah:fichier/outputs/brouillon%20v2.xlsx) dans [@rapport](noah:dossier/outputs/rapport), demande à [@Marie](noah:agent/b1) avec [/Compte rendu](noah:competence/competences/compte-rendu).";

it("les pastilles du message se réaffichent : fichier, dossier, agent avec son visage, compétence", async () => {
  const host = document.createElement("div"), root = createRoot(host);
  document.body.append(host);
  await act(async () => root.render(<AgentContext.Provider value={base}><p><MentionText text={TEXT} /></p></AgentContext.Provider>));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const pills = [...host.querySelectorAll<HTMLElement>("[data-mention-pill]")];
  expect(pills.map((p) => [p.dataset.mentionPill, p.textContent])).toEqual([["fichier", "plan.md"], ["fichier", "brouillon.xlsx"], ["dossier", "rapport"], ["agent", "Marie"], ["competence", "Compte rendu"]]);
  expect(host.textContent).toBe("Résume plan.md et brouillon.xlsx dans rapport, demande à Marie avec Compte rendu."); // le texte autour est intact, sans lien
  expect(host.querySelector("[data-mention-pill=agent] svg")).not.toBeNull(); // le visage de l'agent cité
  expect(get).toHaveBeenCalledTimes(1); // une seule lecture des agents, et seulement parce qu'il y en a un
  // Un fichier qu'on peut montrer s'ouvre dans l'aperçu de l'application ; un autre se télécharge.
  await act(async () => pills[0].click());
  expect(view).toHaveBeenCalledWith({ kind: "file", url: "/api/agents/z9/files/raw/outputs/plan.md", title: "plan.md" });
  await act(async () => pills[1].click());
  expect(download).toHaveBeenCalledWith("/api/agents/z9/files/raw/outputs/brouillon%20v2.xlsx?download=1", "brouillon.xlsx");
  // Un dossier ouvre l'onglet Fichiers.
  const opened = vi.fn();
  window.addEventListener("noah:ouvrir-panneau", opened);
  await act(async () => pills[2].click());
  expect((opened.mock.calls[0][0] as CustomEvent).detail).toBe("files");
  window.removeEventListener("noah:ouvrir-panneau", opened);
  await act(async () => root.unmount());
  host.remove();
});
