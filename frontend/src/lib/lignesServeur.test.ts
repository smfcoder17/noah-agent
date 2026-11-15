// m1 (audit 0.3.0) : les lignes que le serveur écrit en base, en français, se lisent dans la langue de l'interface.
import { afterEach, describe, expect, it } from "vitest";
import { choisirLangue } from "@/i18n";
import { activityResult, activityTitle, pcNote } from "./lignesServeur";

afterEach(() => choisirLangue("fr", false));

describe("lignes écrites par le serveur", () => {
  it("anglais : ordinateur éteint, jetons d'un abonnement, autorisé sur tes mots, bloqué", () => {
    choisirLangue("en", false);
    expect(pcNote("_Ton ordinateur est éteint : réponse par OpenRouter · gpt-5._\n\nBonjour")).toBe("_Your computer is off: answered by OpenRouter · gpt-5._\n\nBonjour");
    expect(activityResult("1 234 jetons · 4,9 s · compris dans l'abonnement")).toBe("1,234 tokens · 4.9 s · included in the subscription");
    expect(activityTitle("Autorisé sur tes mots : Lancer nettoyage.py")).toBe("Allowed on your words: Lancer nettoyage.py");
    expect(activityTitle("Ton juge a refusé : rm -rf /")).toBe("Blocked: rm -rf /");
    expect(activityTitle("Ton juge demande ton accord : envoyer")).toBe("Approval requested");
  });

  it("français : rien ne change ; un autre texte reste tel quel", () => {
    choisirLangue("fr", false);
    expect(pcNote("_Ton ordinateur est éteint : réponse par OpenRouter · gpt-5._\n\nBonjour")).toBe("_Ton ordinateur est éteint : réponse par OpenRouter · gpt-5._\n\nBonjour");
    expect(activityResult("1 234 jetons · 4,9 s · compris dans l'abonnement")).toMatch(/^1\s234 jetons · 4,9 s · compris dans l'abonnement$/);
    expect(activityTitle("Autorisé sur tes mots : X")).toBe("Autorisé sur tes mots : X");
    choisirLangue("en", false);
    expect(pcNote("Bonjour, ton ordinateur est éteint : réponse par moi.")).toBe("Bonjour, ton ordinateur est éteint : réponse par moi.");
    expect(activityResult("« lance le script »")).toBe("« lance le script »");
  });
});
