// Le score par niveau de preuve : une preuve insuffisante ne donne rien, un bloquant manquant met l'objectif à 0.
//     node tests/eval/score_test.mjs
import assert from "node:assert/strict";
import { goalScore, report } from "../../tools/eval/score.mjs";

const goal = { id: "G", nom: "Essai", seuil: 8, criteres: [
  { id: "a", requis: 3, preuve: 1 },
  { id: "b", requis: 1, preuve: 1 },
  { id: "c", b: 1, requis: 2, preuve: 2 },
] };
assert.deepEqual(goalScore(goal), { score: 7.5, brut: 7.5, bloquants: [] });
assert.equal(goalScore(goal, 1).score, 10, "le score déclaré se contente d'un test");

const blocked = { ...goal, criteres: [...goal.criteres, { id: "d", b: 1, requis: 3, preuve: 2 }] };
assert.equal(goalScore(blocked).score, 0);
assert.deepEqual(goalScore(blocked).bloquants, ["d"]);
assert.equal(goalScore(blocked).brut, 5);

const text = report({ version: 1, niveaux: { 0: "x" }, parcours: [{ id: "J", t: "t", requis: 3, preuve: 2 }], objectifs: [goal] });
assert.match(text, /Promesse : 0 parcours tenus sur 1/);
assert.match(text, /Objectifs au seuil : 0 sur 1/);
console.log("score : tout est vert");
