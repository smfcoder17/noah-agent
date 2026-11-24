import { expect, it } from "vitest";
import { brainLabel, nomAvecExact } from "./modes";

it("l'alias d'un abonnement se lit avec son nom exact quand un tour l'a fait connaître, sinon seul", () => {
  expect(nomAvecExact("haiku", "claude-haiku-5-5")).toBe("Haiku · claude-haiku-5-5");
  expect(nomAvecExact("opus", null)).toBe("Opus");
  expect(nomAvecExact("sonnet", undefined)).toBe("Sonnet");
  expect(nomAvecExact("sonnet", "sonnet")).toBe("Sonnet"); // rien à ajouter si le nom exact est l'alias
  expect(nomAvecExact("openai/gpt-5.1", null)).toBe("GPT 5.1"); // les autres fournisseurs ne changent pas
  expect(nomAvecExact(null, "claude-haiku-5-5")).toBe("");
});

it("l'étiquette sous la saisie porte le nom exact, sauf en mode Auto", () => {
  const cerveau = { mode: null, modele: "haiku", fournisseur: "ordinateur:claude-code", fournisseur_nom: "Claude Code (ton ordinateur)" };
  expect(brainLabel({ ...cerveau, modele_exact: "claude-haiku-5-5" })).toBe("Haiku · claude-haiku-5-5");
  expect(brainLabel(cerveau)).toBe("Haiku");
  expect(brainLabel({ ...cerveau, mode: "auto", modele: null, modele_exact: null })).toBe("Auto");
});
