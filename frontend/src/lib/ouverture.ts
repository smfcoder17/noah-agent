// Le magasin de l'ouverture d'un agent (socle.md, 5.2, exigence X22) : une requête, `GET /api/agents/{id}/ouverture`, rend le fil,
// ce que l'agent fait, ce qui attend, l'appel d'aide, les tâches confiées, les routines connues et la liste des conversations.
// Ce fichier est le seul à la lire. Il remplace sept lecteurs indépendants (liste des conversations, messages, en-cours, appel,
// tâches confiées, routines, relance générale au montage).
//
// Règles :
//  - une entrée par agent, en mémoire seulement (jamais sur le disque du navigateur), vidée au changement de compte ;
//  - afficher d'abord, vérifier ensuite : ce qui est gardé se montre tout de suite, la requête part derrière ;
//  - une requête à la fois par agent : une lecture demandée pendant une autre la rejoint ; un événement arrivé pendant la lecture
//    en fait partir une seule de plus ;
//  - un seul abonné au flux : sur `donnees.changees`, l'ouverture de l'agent affiché est relue, une fois ;
//  - vingt agents au plus : au-delà, le plus ancien sort.
import { useEffect, useSyncExternalStore } from "react";
import { ApiError, currentAuthEpoch, get, type Conversation, type LoginAsked, type QuestionCarte, type StoredMessage } from "./api";
import { eventRevision, subscribeUpdates } from "./events";
import { onForget, seenGeneration } from "./seen";
import type { DelegatedTask } from "@/components/DelegatedTasks";

/** La page de messages demandée : celle que la conversation lisait avant (useAgentChat.ts). */
export const OUVERTURE_PAGE = 60;
const MAX_AGENTS = 20;

export type AppelAide = { id: string; message: string; depuis: number; origine: string };
export type AccordAttendu = { summary: string; demande?: string; apercu?: string[]; request_id: string; generation: number; run_id: string };
/** Ce que fait l'agent dans cette conversation : la même forme que `GET /api/conversations/{id}/en-cours`. */
export type EnCours = { occupe: boolean; activite: string | null; run_id: string | null; file: { id: string; text: string }[]; accord: AccordAttendu | null; connexion?: LoginAsked | null };
export type TacheDuFil = {
  id: string;
  titre: string;
  genre: "demande" | "fil" | "initiative" | "sous_tache" | "routine" | "discussion";
  demandeur: { id: string; nom: string | null } | null;
  /** Celui qui fait le travail : la ligne le nomme, jamais le demandeur. */
  agent: { id: string; nom: string | null };
  etat: "encours" | "attend" | "fini" | "echec";
  resume: string;
  fichiers: unknown[];
  ancre: number;
  cree: number;
  fini_a: number | null;
  /** La conversation de la tâche : on y entre par elle (…/conversations/{id}/messages). */
  conversation_id: string;
  question: QuestionCarte | null;
  /** Le récit du travail, tiré des vrais messages du sous-fil par le serveur (12 au plus, vide sans messages). */
  etapes?: string[];
  echanges?: { id?: string; de: string; a: string; question: string; reponse: string; corrigee?: boolean; regle?: boolean }[];
};
export type Ouverture = {
  version: number;
  revision: string;
  /** Absent : ce compte n'a pas encore de fil avec cet agent. */
  fil: { id: string; updated_at: string; lecture_seule: boolean; plus: boolean; messages: StoredMessage[]; taches: TacheDuFil[] } | null;
  en_cours: EnCours;
  attentes: { questions: unknown[]; accords: number; propositions: number };
  appel: AppelAide | null;
  taches_confiees: DelegatedTask[];
  routines: { actives: { id: string; nom: string }[]; non_vues: number };
  /** Le fil, et les conversations que d'autres comptes ont rendues visibles : les tâches n'y sont plus (0.4.0). Gardé pour les
   * applications installées, qui le lisent encore. */
  conversations: Conversation[];
};

type Entree = { data: Ouverture; at: number };
type Vol = { promesse: Promise<Ouverture | null>; joignable: boolean; suite: Promise<Ouverture | null> | null };

const entrees = new Map<string, Entree>();
const vols = new Map<string, Vol>();
const affiches = new Map<string, number>();
const abonnes = new Set<() => void>();
let arreterFlux: (() => void) | null = null;

const notifier = () => abonnes.forEach((fn) => fn());
/** La donnée sans sa révision : celle-ci avance à chaque événement, même quand rien ne change à l'écran. */
const sansRevision = (data: Ouverture) => JSON.stringify({ ...data, revision: "" });

function garder(agent: string, data: Ouverture) {
  const ancienne = entrees.get(agent);
  const identique = !!ancienne && sansRevision(ancienne.data) === sansRevision(data);
  entrees.delete(agent); // le plus récemment écrit passe en dernier : au-delà de vingt, le premier sort
  entrees.set(agent, { data: identique ? ancienne!.data : data, at: Date.now() });
  while (entrees.size > MAX_AGENTS) entrees.delete(entrees.keys().next().value as string);
  if (!identique) notifier(); // même contenu : même objet, personne ne se redessine
}

function lancer(agent: string, essai = 0): Promise<Ouverture | null> {
  const generation = seenGeneration();
  const auth = currentAuthEpoch();
  return get<Ouverture>(`/api/agents/${agent}/ouverture?limit=${OUVERTURE_PAGE}`)
    .then((data) => {
      // Lue pour le compte d'avant : elle ne remplit rien pour le suivant.
      if (generation !== seenGeneration() || auth !== currentAuthEpoch()) return null;
      // Plus vieille qu'un événement déjà reçu : elle peut décrire l'état d'avant lui. Une seule nouvelle lecture.
      if (essai === 0 && Number(data.revision) < Number(eventRevision() || 0)) return lancer(agent, 1);
      garder(agent, data);
      return data;
    })
    .catch((e) => {
      // Agent disparu ou droit retiré : ce que la mémoire en gardait ne reste pas à l'écran. Une autre erreur laisse la mémoire telle quelle.
      if (e instanceof ApiError && (e.status === 403 || e.status === 404) && generation === seenGeneration() && entrees.delete(agent)) notifier();
      return null;
    });
}

function demarrer(agent: string): Promise<Ouverture | null> {
  const vol: Vol = { promesse: null as unknown as Promise<Ouverture | null>, joignable: true, suite: null };
  vol.promesse = lancer(agent).finally(() => {
    if (vols.get(agent) === vol) vols.delete(agent);
  });
  vols.set(agent, vol);
  // Rejointe seulement par les lectures parties dans le même élan (fin de tour : la liste et l'en-cours la demandent ensemble).
  setTimeout(() => { vol.joignable = false; }, 0);
  return vol.promesse;
}

/**
 * Lit l'ouverture de cet agent, une requête à la fois. \`apres\` : un événement vient d'arriver, la lecture en route peut dater d'avant
 * lui, une seule autre part derrière. \`recent\` : rien à relire si une lecture de cet agent vient d'arriver (en ms).
 * Rend ce que le serveur a rendu, ou null (erreur, ou compte changé pendant la lecture).
 */
export function verifier(agent: string, opts: { apres?: boolean; recent?: number } = {}): Promise<Ouverture | null> {
  const vol = vols.get(agent);
  if (vol) {
    if (!opts.apres || vol.joignable) return vol.promesse;
    return (vol.suite ??= vol.promesse.then(() => demarrer(agent)));
  }
  const gardee = entrees.get(agent);
  if (opts.recent && gardee && Date.now() - gardee.at < opts.recent) return Promise.resolve(gardee.data);
  return demarrer(agent);
}

/** Ce qui est gardé pour cet agent, sans rien demander. */
export const enMemoire = (agent: string | null | undefined): Ouverture | null => (agent ? entrees.get(agent)?.data ?? null : null);

const abonner = (fn: () => void) => {
  abonnes.add(fn);
  return () => { abonnes.delete(fn); };
};

/** Ce qui est gardé pour cet agent, et le redessin quand cela change. Ne lit rien : c'est `useOuvertureAffichee` qui lit. */
export const useOuverture = (agent: string | null | undefined): Ouverture | null => useSyncExternalStore(abonner, () => enMemoire(agent));

function surEvenement() {
  for (const agent of affiches.keys()) void verifier(agent, { apres: true });
}

/**
 * L'agent affiché : sa mémoire se montre tout de suite, sa lecture part derrière, et ses événements la relisent. Un seul abonnement au
 * flux pour tout l'écran, quel que soit le nombre de composants qui lisent.
 */
export function useOuvertureAffichee(agent: string | null | undefined): Ouverture | null {
  useEffect(() => {
    if (!agent) return;
    affiches.set(agent, (affiches.get(agent) ?? 0) + 1);
    arreterFlux ??= subscribeUpdates(surEvenement);
    void verifier(agent);
    return () => {
      const n = (affiches.get(agent) ?? 1) - 1;
      if (n > 0) affiches.set(agent, n);
      else affiches.delete(agent);
      if (!affiches.size) { arreterFlux?.(); arreterFlux = null; }
    };
  }, [agent]);
  return useOuverture(agent);
}

// Changement de compte : l'ouverture du précédent ne ressort pas, même un instant, et une lecture en route ne reviendra pas la remplir.
onForget(() => {
  entrees.clear();
  vols.clear();
  notifier();
});
