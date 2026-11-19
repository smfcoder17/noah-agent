// Les vecteurs sont ceux de tests/agents/nettoyage_test.py : le serveur et l'écran suivent la même règle (0.4.0, L4 : X31 et X17).
import { beforeEach, describe, expect, it } from "vitest";
import type { StoredMessage } from "./api";
import { ancienMessage, aUneCleMasquee, cleRetenue, etiquettesMasquees, interne, ligne, ligneConsigne, masquer, masquerCles, oublierLesCles, retenirCles, silence } from "./nettoyage";

// Des valeurs fabriquées pour l'essai : aucune n'est une vraie clé.
const SK = "sk-" + "a1B2c3D4e5F6g7H8i9J0k1L2";
const ANT = "sk-ant-" + "api03-Zy9Xw8Vu7Ts6Rq5Po4Nm3Lk2";
const GHP = "ghp_" + "abcdefghijklmnopqrstuvwxyz0123456789";
const SLACK = "xoxb-" + "1234567890-abcdefghij";
const AIZA = "AIza" + "SyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q";
const LONGUE = "q8Zk2Lm9Xp4Rt7Vw1Yc5Bn3Hd6Fj0Sa";

beforeEach(() => oublierLesCles());

describe("les marques internes ne sortent pas", () => {
  it.each([
    ["[[👍]] Je m'en occupe.", "Je m'en occupe."],
    ["[[✅]]\n\nFait.", "Fait."],
    ["Voilà [SILENT] la suite", "Voilà  la suite"],
    ["<releve>\nTitre\n</releve>Bonjour", "Titre\nBonjour"],
    ["Prix : 5\\u00a0€", "Prix : 5 €"],
    ["Ligne\\x1b[0m fin", "Ligne fin"],
    ["Un\u200bmot", "Unmot"],
    ["Bonjour \x1b[31mrouge\x1b[0m", "Bonjour rouge"],
  ])("%j devient %j", (avant, apres) => expect(interne(avant)).toBe(apres));

  it("un [[lien]] écrit avec des mots reste, et le code n'est pas touché", () => {
    expect(interne("Voir [[Accueil]] ici")).toBe("Voir [[Accueil]] ici");
    expect(interne("Tape `[SILENT]` puis :\n```\n[[👍]] \u00a0\n```")).toBe("Tape `[SILENT]` puis :\n```\n[[👍]] \u00a0\n```");
  });

  it("[SILENT] seul, au début ou à la fin : un silence ; au milieu d'une phrase : une marque oubliée", () => {
    expect(silence("[SILENT]")).toBe(true);
    expect(silence("Rien à signaler.\n[SILENT]")).toBe(true);
    expect(silence("[silent] fini")).toBe(true);
    expect(silence("Je dis [SILENT] au milieu")).toBe(false);
    expect(silence("Bonjour")).toBe(false);
  });
});

describe("la consigne de Noah n'est pas une parole de la personne", () => {
  const consigne = "[Personne ne t'a écrit : un rappel est arrivé]\n<releve>\nRelancer le client\n</releve>";
  it("une ligne lisible, du côté de l'agent", () => {
    expect(ligneConsigne(consigne)).toBe("Noah a relevé : Relancer le client.");
    expect(ligneConsigne("[Personne ne t'a écrit : ton tour s'est coupé]")).toBe("Noah reprend ce travail là où il s'est arrêté.");
    expect(ligneConsigne("[Personne ne t'a écrit]")).toBe("Noah a relevé quelque chose à traiter.");
  });
  it("un ancien message en base devient un message de l'agent, sans le texte de la consigne", () => {
    const m = { id: 1, role: "user", text: consigne } as unknown as StoredMessage;
    const lu = ancienMessage(m)!;
    expect(lu.role).toBe("agent");
    expect(lu.text).toBe("Noah a relevé : Relancer le client.");
    expect(lu.text).not.toContain("Personne ne t'a écrit");
  });
});

describe("un ancien message relu", () => {
  const msg = (role: string, text: string, detail: unknown = null) => ({ id: 1, role, text, detail }) as unknown as StoredMessage;
  it("[SILENT] ne s'affiche pas", () => expect(ancienMessage(msg("agent", "[SILENT]"))).toBeNull());
  it("un message vide une fois nettoyé ne s'affiche pas", () => expect(ancienMessage(msg("agent", "[[👍]]"))).toBeNull());
  it("aucune marque ne reste", () => expect(ancienMessage(msg("agent", "[[✅]] Fait\\u00a0!"))!.text).toBe("Fait !"));
  it("une clé dans un message de la personne ou de l'agent est masquée", () => {
    expect(ancienMessage(msg("user", `ma clé ${SK}`))!.text).not.toContain(SK);
    expect(ancienMessage(msg("agent", `voici ${GHP}`))!.text).not.toContain(GHP);
  });
  it("une trace : l'en-tête, la consigne et l'issue sont nettoyés", () => {
    const detail = JSON.stringify({ entete: "[[👍]] Départ", consigne: `clé ${SK}`, issue: "[SILENT]fini", autre: 3 });
    const lu = ancienMessage(msg("trace", "[[👍]] Travail", detail))!;
    const d = JSON.parse(lu.detail as string);
    expect(lu.text).toBe("Travail");
    expect(d.entete).toBe("Départ");
    expect(d.consigne).not.toContain(SK);
    expect(d.issue).toBe("fini");
    expect(d.autre).toBe(3);
  });
});

describe("les clés d'API sont masquées", () => {
  it.each([["sk-", SK], ["sk-", ANT], ["ghp_", GHP], ["xoxb-", SLACK], ["AIza", AIZA]])("%s", (prefixe, cle) => {
    const out = masquerCles(`Ma clé est ${cle} merci`);
    expect(out).not.toContain(cle);
    expect(out).toContain("(clé masquée)");
    expect(out).toContain(prefixe);
    expect(aUneCleMasquee(out)).toBe(true);
    expect(etiquettesMasquees(out)).toEqual([prefixe]);
  });
  it("une clé de fournisseur longue, annoncée par un mot", () => {
    expect(masquerCles(`api_key: ${LONGUE}`)).not.toContain(LONGUE);
    expect(masquerCles(`la clé est ${LONGUE}`)).not.toContain(LONGUE);
  });
  it("ce qui n'est pas une clé reste", () => {
    for (const ok of ["le sk-8 est court", "https://exemple.org/a/b/c/d/e/f/g/h", "mon token est valide", "api_key: /opt/data/workspace/fichier-tres-long-12345.txt", "task-abc"]) expect(masquerCles(ok), ok).toBe(ok);
  });
  it("une ligne de titre sans Markdown, sans marque, sans clé", () => {
    expect(ligne(`[[👍]] **Ranger** ${SK} [le site](https://x.org)`)).not.toContain(SK);
    expect(ligne("# Titre\n\n- une **idée**")).toBe("Titre - une idée");
  });
  it("la clé tapée se retient en mémoire, pour l'offre du coffre, et seulement en mémoire", () => {
    const { texte, cles } = masquer(`prends ${SK}`);
    expect(texte).not.toContain(SK);
    expect(cles).toEqual([{ etiquette: "sk-", valeur: SK }]);
    retenirCles(`prends ${SK}`);
    expect(cleRetenue("sk-")).toBe(SK);
    expect(cleRetenue("ghp_")).toBe("");
    oublierLesCles();
    expect(cleRetenue("sk-")).toBe("");
  });
});
