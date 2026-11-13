import { expect, it } from "vitest";
import { luhn, sensitiveParts } from "./sensitive";
const shown = (text: string) => sensitiveParts(text).map((p) => p.masked).join("");
it("masque courriels, téléphones et cartes vérifiées par Luhn", () => {
  const parts = sensitiveParts("Marc : marc@gmail.com, +1 514 555 1242, carte 4111 1111 1111 1111.");
  expect(parts.filter((p) => p.sensitive).length).toBe(3);
  expect(parts.map((p) => p.masked).join("")).not.toContain("marc@gmail.com");
  expect(luhn("4111 1111 1111 1111")).toBe(true);
});
it("ne masque ni date, ni prix, ni identifiant qui échoue au contrôle", () => {
  expect(sensitiveParts("2026-11-10 · 1 200 $ · version 0.1.6 · 1234567890123456").every((p) => !p.sensitive)).toBe(true);
  expect(luhn("0000000000000000")).toBe(false);
});
it("sépare un téléphone d'une carte voisine, même sans virgule", () => {
  const parts = sensitiveParts("+1 514 555 1242 4111 1111 1111 1111");
  expect(parts.filter((p) => p.sensitive)).toHaveLength(2);
});
it("laisse intacts les liens de posts X dont l'identifiant passe Luhn (cas réels)", () => {
  for (const id of ["2120656025690804594", "2120957443479855511", "2120962987821539788"]) {
    expect(luhn(id)).toBe(true);
    for (const text of [`https://x.com/SmfCoder/status/${id}`, `x.com/SmfCoder/status/${id}`, `Publié : [voir le post](https://x.com/SmfCoder/status/${id}) ce matin`]) {
      expect(sensitiveParts(text).some((p) => p.sensitive)).toBe(false);
    }
  }
});
it("un nombre dans une adresse, un chemin ou collé à un identifiant n'est ni carte ni téléphone", () => {
  for (const text of [
    "https://shop.example.com/p?id=4111111111111111",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=4111111111111111",
    "https://youtu.be/dQw4w9WgXcQ",
    "https://wa.me/15145551242",
    "www.exemple.com/commande/4111111111111111",
    "commande #4111111111111111",
    "commande 112-4567890-1234567",
    "ID_4111111111111111, ref-4111111111111111, sku4111111111111111",
    "C:\\factures\\4111111111111111.pdf et /home/franck/4111111111111111/notes",
    "4111111111111111.pdf",
    "IBAN FR7630006000011234567890189",
  ]) expect(shown(text)).toBe(text);
});
it("continue de masquer cartes, courriels et téléphones écrits dans une phrase, liens mailto: et tel: compris", () => {
  expect(shown("carte 4111-1111-1111-1111, merci")).toBe("carte •••• •••• •••• 1111, merci");
  expect(shown("Carte:4111111111111111.")).toBe("Carte:•••• •••• •••• 1111.");
  expect(shown("mailto:marc@gmail.com")).not.toContain("marc@gmail.com");
  expect(shown("tel:+15145551242")).not.toContain("5145551242");
  expect(shown("appelle +33 6 12 34 56 78 demain")).toBe("appelle +33 ••• •• 78 demain");
  expect(shown("Écris à marc@gmail.com ou va sur https://x.com/SmfCoder/status/2120656025690804594")).toBe("Écris à ma•••@g•••.com ou va sur https://x.com/SmfCoder/status/2120656025690804594");
});
it("ne prend pas pour une carte un identifiant écrit seul dans une phrase", () => {
  for (const id of ["2120656025690804594", "2120957443479855511", "2120962987821539788"]) expect(sensitiveParts(`post ${id} publié`).every((p) => !p.sensitive)).toBe(true);
  expect(sensitiveParts("carte 4111 1111 1111 1111").some((p) => p.sensitive)).toBe(true);
  expect(sensitiveParts("Amex 3782 822463 10005").some((p) => p.sensitive)).toBe(true);
});
