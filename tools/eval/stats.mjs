#!/usr/bin/env node
// Calculs d'une évaluation, sans dépendance. Graine fixe : deux lancers donnent le même résultat.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function rng(seed = 42) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const quantile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];

function groupBy(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    const k = row[key];
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(row);
  }
  return [...groups.values()];
}

/** Intervalle à 95 % d'une moyenne, ré-échantillonnée par cas : répéter un cas ne vaut pas un nouveau cas. */
export function clusterMeanCI(rows, value, { reps = 5000, seed = 42 } = {}) {
  const random = rng(seed);
  const perCase = groupBy(rows, "case").map((g) => mean(g.map(value)));
  const samples = [];
  for (let i = 0; i < reps; i++) {
    let sum = 0;
    for (let j = 0; j < perCase.length; j++) sum += perCase[Math.floor(random() * perCase.length)];
    samples.push(sum / perCase.length);
  }
  samples.sort((x, y) => x - y);
  return { mean: mean(perCase), low: quantile(samples, 0.025), high: quantile(samples, 0.975), cases: perCase.length };
}

/** Gain apparié de b sur a. Lignes : { case, a, b }. */
export const pairedGain = (rows, opts) => clusterMeanCI(rows, (r) => r.b - r.a, opts);

/** Part de victoires. Lignes : { case, win } avec win = 1, 0,5 ou 0. */
export const winRate = (rows, opts) => clusterMeanCI(rows, (r) => r.win, opts);

/**
 * Bruit de l'état actuel. Lignes : { case, run, score }, plusieurs lancers par cas.
 * Rend l'écart moyen entre deux lancers d'un même cas et le gain minimal détectable à 95 %
 * pour `repeats` lancers de chaque côté.
 */
export function noise(rows, { repeats = 1 } = {}) {
  const groups = groupBy(rows, "case").filter((g) => g.length > 1);
  if (!groups.length) throw new Error("Il faut au moins deux lancers d'un même cas.");
  const variances = groups.map((g) => {
    const m = mean(g.map((r) => r.score));
    return g.reduce((s, r) => s + (r.score - m) ** 2, 0) / (g.length - 1);
  });
  const withinSd = Math.sqrt(mean(variances));
  const detectable = 1.96 * withinSd * Math.sqrt(2 / (repeats * groups.length));
  return { withinSd, detectable, cases: groups.length, repeats };
}

/** Alpha de Krippendorff. `units` : une liste de notes par unité (null = absent). metric : nominal | ordinal | interval. */
export function krippendorffAlpha(units, metric = "ordinal") {
  const values = [...new Set(units.flat().filter((v) => v !== null && v !== undefined))].sort((a, b) =>
    typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b)),
  );
  const index = new Map(values.map((v, i) => [v, i]));
  const k = values.length;
  const o = Array.from({ length: k }, () => new Array(k).fill(0));
  for (const unit of units) {
    const notes = unit.filter((v) => v !== null && v !== undefined);
    if (notes.length < 2) continue;
    for (let i = 0; i < notes.length; i++) {
      for (let j = 0; j < notes.length; j++) {
        if (i !== j) o[index.get(notes[i])][index.get(notes[j])] += 1 / (notes.length - 1);
      }
    }
  }
  const n = o.map((row) => row.reduce((s, x) => s + x, 0));
  const total = n.reduce((s, x) => s + x, 0);
  if (total <= 1) return null;
  const distance = (c, d) => {
    if (c === d) return 0;
    if (metric === "nominal") return 1;
    if (metric === "interval") return (values[c] - values[d]) ** 2;
    const [lo, hi] = c < d ? [c, d] : [d, c];
    let sum = 0;
    for (let g = lo; g <= hi; g++) sum += n[g];
    return (sum - (n[lo] + n[hi]) / 2) ** 2;
  };
  let observed = 0;
  let expected = 0;
  for (let c = 0; c < k; c++) {
    for (let d = 0; d < k; d++) {
      const delta = distance(c, d);
      observed += o[c][d] * delta;
      expected += n[c] * n[d] * delta;
    }
  }
  expected /= total - 1;
  if (expected === 0) return 1;
  return 1 - observed / expected;
}

function fitBradleyTerry(matches, items, iterations = 500) {
  const strength = new Map(items.map((i) => [i, 1]));
  const wins = new Map(items.map((i) => [i, 0.5]));
  for (const m of matches) {
    const share = m.winner === "tie" ? [0.5, 0.5] : m.winner === m.a ? [1, 0] : [0, 1];
    wins.set(m.a, wins.get(m.a) + share[0]);
    wins.set(m.b, wins.get(m.b) + share[1]);
  }
  for (let it = 0; it < iterations; it++) {
    const denom = new Map(items.map((i) => [i, 1 / (strength.get(i) + 1)]));
    for (const m of matches) {
      const d = 1 / (strength.get(m.a) + strength.get(m.b));
      denom.set(m.a, denom.get(m.a) + d);
      denom.set(m.b, denom.get(m.b) + d);
    }
    for (const i of items) strength.set(i, wins.get(i) / denom.get(i));
    const geo = Math.exp(mean(items.map((i) => Math.log(strength.get(i)))));
    for (const i of items) strength.set(i, strength.get(i) / geo);
  }
  return strength;
}

/**
 * Classement par comparaisons. Lignes : { a, b, winner } (winner = a, b ou "tie"), `case` facultatif.
 * Rend une note sur l'échelle Elo, relative au groupe, avec son intervalle.
 */
export function bradleyTerry(matches, { reps = 500, seed = 42 } = {}) {
  const items = [...new Set(matches.flatMap((m) => [m.a, m.b]))].sort();
  const toElo = (s) => 400 * Math.log10(s);
  const fitted = fitBradleyTerry(matches, items);
  const random = rng(seed);
  const samples = new Map(items.map((i) => [i, []]));
  for (let r = 0; r < reps; r++) {
    const resampled = matches.map(() => matches[Math.floor(random() * matches.length)]);
    const s = fitBradleyTerry(resampled, items, 100);
    for (const i of items) samples.get(i).push(toElo(s.get(i)));
  }
  return items
    .map((item) => {
      const sorted = samples.get(item).sort((x, y) => x - y);
      return { item, rating: toElo(fitted.get(item)), low: quantile(sorted, 0.025), high: quantile(sorted, 0.975) };
    })
    .sort((x, y) => y.rating - x.rating);
}

const HELP = `node stats.mjs <commande> <fichier.json>
  gain    [{case,a,b}]           gain apparié de b sur a, intervalle groupé par cas
  wins    [{case,win}]           part de victoires (1, 0.5, 0)
  noise   [{case,run,score}]     bruit de l'état actuel, gain minimal détectable
  alpha   [[note,...],...]       alpha de Krippendorff (ordinal)
  bt      [{a,b,winner}]         classement Bradley-Terry, échelle Elo relative`;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [command, file] = process.argv.slice(2);
  const commands = {
    gain: pairedGain,
    wins: winRate,
    noise: (rows) => noise(rows),
    alpha: (units) => krippendorffAlpha(units),
    bt: bradleyTerry,
  };
  if (!commands[command] || !file) {
    console.log(HELP);
  } else {
    console.log(JSON.stringify(commands[command](JSON.parse(readFileSync(file, "utf8"))), null, 2));
  }
}
