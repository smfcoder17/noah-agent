// Types de cliquet.mjs, pour que l'interface (frontend/src/budgets.test.tsx) l'importe sous tsc.
export const FICHIER: string;
export function lire(): { budgets: Record<string, { libelle: string; unite?: string; seuil: number; mesure: number | null; bloquant: boolean; tolerance?: number }> };
export function juger(cle: string, valeur: number): { ok: boolean; ligne: string };
export function jugerTout(mesures: [string, number][]): boolean;
export function playwright(): Promise<unknown>;
