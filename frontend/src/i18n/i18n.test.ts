// @vitest-environment node
// Langues : aucun texte visible n'échappe à t(), aucune clé ne manque en anglais, aucune traduction n'est orpheline,
// et chaque message d'erreur fixe du serveur a sa traduction.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error module JS sans types
import { analyser, fichiers, variables } from "../../scripts/i18n-analyse.mjs";
import { PARTIES, en } from "./en";

type Analyse = { cles: { cle: string; ligne: number }[]; restes: { texte: string; ligne: number }[]; dynamiques: number[] };
const tous: [string, Analyse][] = (fichiers() as string[]).map((f) => [path.relative(process.cwd(), f), analyser(f) as Analyse]);
const SERVEUR = path.resolve(__dirname, "../../../server/noah");

describe("langues", () => {
  it("aucun texte visible écrit en dur hors de t()", () => {
    const restes = tous.flatMap(([f, a]) => a.restes.map((r) => `${f}:${r.ligne}  ${r.texte}`));
    expect(restes).toEqual([]);
  });

  it("t() et tr() reçoivent le texte français littéral", () => {
    expect(tous.flatMap(([f, a]) => a.dynamiques.map((l) => `${f}:${l}`))).toEqual([]);
  });

  it("chaque clé a sa traduction anglaise, avec les mêmes variables", () => {
    const manquantes: string[] = [];
    const variablesFausses: string[] = [];
    for (const [f, a] of tous) for (const { cle, ligne } of a.cles) {
      if (!(cle in en)) manquantes.push(`${f}:${ligne}  ${cle}`);
      else if (variables(cle).join() !== variables(en[cle]).join()) variablesFausses.push(`${f}:${ligne}  ${cle}`);
    }
    expect(manquantes).toEqual([]);
    expect(variablesFausses).toEqual([]);
  });

  it("aucune traduction orpheline, ni deux traductions pour un même texte", () => {
    const utilisees = new Set(tous.flatMap(([, a]) => a.cles.map((c) => c.cle)));
    const orphelines: string[] = [];
    const conflits: string[] = [];
    const vues = new Map<string, [string, string]>();
    for (const [partie, dico] of Object.entries(PARTIES)) for (const [fr, trad] of Object.entries(dico)) {
      if (!partie.includes("serveur") && !utilisees.has(fr)) orphelines.push(`${partie}  ${fr}`);
      if (!trad.trim()) orphelines.push(`${partie}  ${fr} (vide)`);
      const avant = vues.get(fr);
      if (avant && avant[1] !== trad) conflits.push(`${fr} : ${avant[0]} « ${avant[1]} » / ${partie} « ${trad} »`);
      vues.set(fr, [partie, trad]);
    }
    expect(orphelines).toEqual([]);
    expect(conflits).toEqual([]);
  });

  it("chaque message fixe d'erreur du serveur (HTTPException) est traduit", () => {
    const serveur = Object.entries(PARTIES).filter(([p]) => p.includes("serveur")).map(([, d]) => d);
    const normalise = (s: string) => s.replace(/\{[^}]*\}/g, "{}");
    const connus = new Set(serveur.flatMap((d) => Object.keys(d)).map(normalise));
    const manquants: string[] = [];
    const lireDossier = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? lireDossier(path.join(d, e.name)) : e.name.endsWith(".py") ? [path.join(d, e.name)] : []);
    for (const f of lireDossier(SERVEUR)) {
      const texte = fs.readFileSync(f, "utf8");
      // HTTPException(404, "…") ou HTTPException(400, f"…"), sur une ligne ; chaînes collées sur plusieurs lignes réunies.
      for (const m of texte.matchAll(/HTTPException\(\s*\d+\s*,\s*((?:f?"(?:[^"\\]|\\.)*"\s*)+)\)/g)) {
        const message = [...m[1].matchAll(/f?"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]).join("").replace(/\\"/g, '"').replace(/\\n/g, "\n");
        if (!connus.has(normalise(message))) manquants.push(`${path.relative(SERVEUR, f)}  ${message}`);
      }
    }
    expect([...new Set(manquants)]).toEqual([]);
  });
});
