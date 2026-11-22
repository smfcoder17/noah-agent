// Rechercher (0.4.2) : un champ, les agents en puces (tous cochés), les résultats groupés par agent, un clic ouvre l'endroit trouvé.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const reponse = {
  q: "newsletter", total: 4,
  agents: [
    { id: "a", nom: "Alma", total: 3,
      messages: [{ id: 7, conversation_id: "c-a", principale: true, role: "agent", texte: "La newsletter est prête", date: "2026-11-20 10:00:00" },
        { id: 8, conversation_id: "c-sous", principale: false, role: "user", texte: "Une autre newsletter", date: "2026-11-20 10:01:00" }],
      taches: [{ id: "t1", titre: "Rédiger la newsletter", etat: "fini", conversation_id: "c-t1" }], fichiers: [] },
    { id: "c", nom: "Cléo", total: 1, messages: [], taches: [], fichiers: [{ path: "outputs/visuel-newsletter.png", size: 900, modified: 3 }] },
  ],
};
vi.mock("@/lib/api", () => ({ get: vi.fn(async () => reponse) }));
const voir = vi.fn();
vi.mock("./Viewer", () => ({ useViewer: () => voir }));
vi.mock("./FilePreview", () => ({ fileSpec: (agent: string, path: string) => ({ agent, path }) }));
import { get } from "@/lib/api";
import { RecherchePage } from "./RecherchePage";

const agents = [{ id: "a", name: "Alma" }, { id: "c", name: "Cléo" }, { id: "z", name: "Zoé" }] as never[];
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
const fil = vi.fn(), tache = vi.fn(), fichier = vi.fn();
const taper = async (texte: string) => {
  const champ = host.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(champ, texte); champ.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => { await new Promise((ok) => setTimeout(ok, 350)); });
};
beforeEach(async () => {
  vi.mocked(get).mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<RecherchePage agents={agents} onOpenFil={fil} onOpenTache={tache} onOpenFichier={fichier} />));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.clearAllMocks(); });

it("un champ et les agents en puces, tous cochés ; rien n'est cherché avant deux lettres", async () => {
  expect(host.querySelector('input[type="search"]')).toBe(document.activeElement);
  const puces = [...host.querySelectorAll<HTMLButtonElement>("button.chip")];
  expect(puces.map((p) => [p.textContent, p.getAttribute("aria-pressed")])).toEqual([["Alma", "true"], ["Cléo", "true"], ["Zoé", "true"]]);
  await taper("n");
  expect(get).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Écris au moins deux lettres");
});

it("les résultats sont groupés sous chaque agent : messages, tâches, fichiers ; le clic ouvre l'endroit trouvé", async () => {
  await taper("newsletter");
  expect(get).toHaveBeenCalledWith("/api/recherche?q=newsletter");
  expect([...host.querySelectorAll("section[data-agent] h2")].map((h) => h.textContent)).toEqual(["Alma", "Cléo"]);
  expect(host.querySelectorAll('section[data-agent="a"] button.row').length).toBe(3);
  await act(async () => host.querySelector<HTMLButtonElement>('[data-message="7"]')!.click());
  expect(fil).toHaveBeenLastCalledWith("a", null);
  await act(async () => host.querySelector<HTMLButtonElement>('[data-message="8"]')!.click());
  expect(fil).toHaveBeenLastCalledWith("a", "c-sous");
  await act(async () => host.querySelector<HTMLButtonElement>('[data-tache="t1"]')!.click());
  expect(tache).toHaveBeenCalledWith("a", "c-t1");
  await act(async () => host.querySelector<HTMLButtonElement>('[data-fichier="outputs/visuel-newsletter.png"]')!.click());
  expect(fichier).toHaveBeenCalledWith("c");
  expect(voir).toHaveBeenCalledWith({ kind: "element", element: { agent: "c", path: "outputs/visuel-newsletter.png" } });
});

it("décocher un agent restreint la recherche aux autres ; tout décoché : aucune requête", async () => {
  await act(async () => host.querySelector<HTMLButtonElement>('[data-agent-chip="z"]')!.click());
  await taper("newsletter");
  expect(get).toHaveBeenCalledWith("/api/recherche?q=newsletter&agents=a%2Cc");
  await act(async () => host.querySelector<HTMLButtonElement>('[data-agent-chip="a"]')!.click());
  await act(async () => host.querySelector<HTMLButtonElement>('[data-agent-chip="c"]')!.click());
  expect(host.textContent).toContain("Coche au moins un agent");
});

it("sans résultat, une phrase", async () => {
  vi.mocked(get).mockResolvedValueOnce({ q: "zzz", total: 0, agents: [] });
  await taper("zzz");
  expect(host.textContent).toContain("Aucun résultat pour « zzz »");
});
