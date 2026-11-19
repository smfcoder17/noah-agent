// Le magasin de l'ouverture d'un agent (socle.md, 5.2) : une seule requête, une à la fois par agent, un seul abonné au flux,
// vingt agents au plus, rien ne reste d'un compte à l'autre.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class ApiError extends Error { status: number; constructor(message: string, status: number) { super(message); this.status = status; } }
  return { ApiError, get: vi.fn(), currentAuthEpoch: () => "alice" };
});
vi.mock("./api", () => api);
const flux = vi.hoisted(() => ({ subscribeUpdates: vi.fn((_fn: () => unknown) => () => {}), revision: "" }));
vi.mock("./events", () => ({ subscribeUpdates: flux.subscribeUpdates, eventRevision: () => flux.revision }));

import { enMemoire, useOuvertureAffichee, useOuverture, verifier, type Ouverture } from "./ouverture";
import { forgetSeen } from "./seen";

const ouverture = (agent: string, revision = "1", extra: Partial<Ouverture> = {}): Ouverture => ({
  version: 1, revision,
  fil: { id: `fil-${agent}`, updated_at: "2026-11-18 10:00:00", lecture_seule: false, plus: false, messages: [{ id: 1, role: "agent", text: "Bonjour", created_at: "2026-11-18 10:00:00" }], taches: [] },
  en_cours: { occupe: false, activite: null, run_id: null, file: [], accord: null },
  attentes: { questions: [], accords: 0, propositions: 0 }, appel: null, taches_confiees: [], routines: { actives: [], non_vues: 0 },
  conversations: [], ...extra,
});
const paths = () => api.get.mock.calls.map((c) => c[0] as string);
/** Une réponse qu'on libère à la main : de quoi tenir une requête en vol. */
function held() {
  let release!: (o: Ouverture) => void;
  const promise = new Promise<Ouverture>((ok) => { release = ok; });
  return { promise, release };
}
const tick = () => act(async () => { await new Promise((ok) => setTimeout(ok, 5)); });

beforeEach(() => {
  forgetSeen();
  api.get.mockReset();
  flux.subscribeUpdates.mockClear();
  flux.revision = "";
});

it("une seule requête, quel que soit le nombre de lecteurs qui la demandent au même instant", async () => {
  api.get.mockImplementation(async (path: string) => ouverture(path.split("/")[3]));
  const [a, b, c] = await Promise.all([verifier("a1"), verifier("a1"), verifier("a1", { apres: false })]);
  expect(paths()).toEqual(["/api/agents/a1/ouverture?limit=60"]);
  expect(a).toBe(b);
  expect(b).toBe(c);
  expect(enMemoire("a1")).toBe(a);
});

it("une requête à la fois par agent : un événement arrivé pendant la lecture en fait partir une seule de plus", async () => {
  const first = held();
  api.get.mockImplementationOnce(() => first.promise).mockImplementation(async () => ouverture("a1", "2"));
  const reading = verifier("a1");
  // Trois événements pendant la lecture, après l'élan de départ : une seule relecture derrière, pas trois.
  await new Promise((ok) => setTimeout(ok, 5));
  const after = [verifier("a1", { apres: true }), verifier("a1", { apres: true }), verifier("a1", { apres: true })];
  expect(paths()).toHaveLength(1);
  first.release(ouverture("a1", "1"));
  await reading;
  await Promise.all(after);
  expect(paths()).toHaveLength(2);
  // Les lectures parties dans le même élan (fin de tour : la liste et l'en-cours la demandent ensemble) n'en font qu'une.
  api.get.mockClear();
  await Promise.all([verifier("a1", { apres: true }), verifier("a1", { apres: true })]);
  expect(paths()).toHaveLength(1);
});

it("un agent lu à l'instant ne se relit pas quand on le demande « récent »", async () => {
  api.get.mockImplementation(async () => ouverture("a1"));
  await verifier("a1");
  await verifier("a1", { recent: 1500 });
  expect(paths()).toHaveLength(1);
  await verifier("a1");
  expect(paths()).toHaveLength(2);
});

it("même contenu, même objet : la révision qui avance seule ne redessine rien", async () => {
  api.get.mockImplementationOnce(async () => ouverture("a1", "1")).mockImplementationOnce(async () => ouverture("a1", "7"));
  const first = await verifier("a1");
  await verifier("a1");
  expect(enMemoire("a1")).toBe(first);
  api.get.mockImplementationOnce(async () => ouverture("a1", "8", { appel: { id: "x", message: "Connecte-toi", depuis: 1, origine: "agent" } }));
  await verifier("a1");
  expect(enMemoire("a1")).not.toBe(first);
  expect(enMemoire("a1")?.appel?.id).toBe("x");
});

it("une réponse plus vieille qu'un événement déjà reçu est jetée : une seule nouvelle lecture", async () => {
  flux.revision = "9";
  api.get.mockImplementationOnce(async () => ouverture("a1", "5")).mockImplementationOnce(async () => ouverture("a1", "9", { appel: { id: "neuf", message: "", depuis: 1, origine: "agent" } }));
  const data = await verifier("a1");
  expect(paths()).toHaveLength(2);
  expect(data?.appel?.id).toBe("neuf");
  // Toujours plus vieille : elle n'en appelle pas une troisième (pas de boucle).
  api.get.mockClear();
  api.get.mockImplementation(async () => ouverture("a1", "3"));
  await verifier("a1");
  expect(paths()).toHaveLength(2);
});

it("vingt agents au plus en mémoire : au-delà, le plus ancien sort", async () => {
  api.get.mockImplementation(async (path: string) => ouverture(path.split("/")[3]));
  for (let i = 0; i < 22; i++) await verifier(`agent${i}`);
  expect(enMemoire("agent0")).toBeNull();
  expect(enMemoire("agent1")).toBeNull();
  expect(enMemoire("agent2")).not.toBeNull();
  expect(enMemoire("agent21")).not.toBeNull();
});

it("la mémoire est vidée au changement de compte, et une lecture en route ne revient pas la remplir", async () => {
  api.get.mockImplementation(async () => ouverture("a1"));
  await verifier("a1");
  expect(enMemoire("a1")).not.toBeNull();
  const late = held();
  api.get.mockImplementationOnce(() => late.promise);
  const reading = verifier("a1");
  forgetSeen(); // un autre compte se connecte
  expect(enMemoire("a1")).toBeNull();
  late.release(ouverture("a1", "2"));
  expect(await reading).toBeNull();
  expect(enMemoire("a1")).toBeNull();
});

it("un agent disparu ou refusé (404) sort de la mémoire ; une panne la laisse telle quelle", async () => {
  api.get.mockImplementation(async () => ouverture("a1"));
  await verifier("a1");
  api.get.mockImplementationOnce(async () => { throw new Error("réseau coupé"); });
  expect(await verifier("a1")).toBeNull();
  expect(enMemoire("a1")).not.toBeNull();
  api.get.mockImplementationOnce(async () => { throw new api.ApiError("Agent introuvable", 404); });
  expect(await verifier("a1")).toBeNull();
  expect(enMemoire("a1")).toBeNull();
});

it("un seul abonné au flux pour tout l'écran ; un événement relit l'agent affiché, une fois", async () => {
  api.get.mockImplementation(async (path: string) => ouverture(path.split("/")[3]));
  const seen: (Ouverture | null)[] = [];
  function Lecteur() { seen.push(useOuverture("a1")); return null; }
  function Ecran({ agent }: { agent: string }) { useOuvertureAffichee(agent); return <><Lecteur /><Lecteur /></>; }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<><Ecran agent="a1" /><Ecran agent="a1" /></>));
  await tick();
  expect(flux.subscribeUpdates).toHaveBeenCalledTimes(1);
  expect(paths()).toEqual(["/api/agents/a1/ouverture?limit=60"]); // lue au montage, une fois, pour quatre lecteurs
  expect(seen[seen.length - 1]).toBe(enMemoire("a1"));
  // Un événement du flux : une relecture.
  api.get.mockClear();
  const surEvenement = flux.subscribeUpdates.mock.calls[0][0];
  await act(async () => { await surEvenement(); });
  await tick();
  expect(paths()).toEqual(["/api/agents/a1/ouverture?limit=60"]);
  // Changement d'agent : une requête, celle du nouvel agent, et l'ancien reste en mémoire pour son retour.
  api.get.mockClear();
  await act(async () => root.render(<Ecran agent="a2" />));
  await tick();
  expect(paths()).toEqual(["/api/agents/a2/ouverture?limit=60"]);
  expect(enMemoire("a1")).not.toBeNull();
  await act(async () => root.unmount());
});
