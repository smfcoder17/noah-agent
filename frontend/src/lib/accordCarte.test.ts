import { expect, it } from "vitest";
import { fullCommand } from "./accordCarte";
import { spentLabel } from "./depense";

const card = (args: object, tool = "terminal") =>
  `Ton juge demande ton accord : je ne suis pas sûr que ce soit ce que tu veux.\nOutil : ${tool}\n${JSON.stringify(args)}`;

it("montre en entier une commande de plusieurs lignes, jamais la première seule", () => {
  const command = "mkdir -p outputs\ncd outputs\nls -la";
  expect(fullCommand(card({ command }))).toBe(command);
  expect(fullCommand(card({ code: "a = 1\nprint(a)" }, "execute_code"))).toBe("a = 1\nprint(a)");
});

it("ne change rien pour une commande d'une ligne, un autre outil ou un appel coupé", () => {
  expect(fullCommand(card({ command: "ls -la" }))).toBeNull();
  expect(fullCommand(card({ text: "a\nb" }, "send_message"))).toBeNull();
  expect(fullCommand('Outil : terminal\n{"command": "a\\nb… [empreinte 0123]')).toBeNull();
  expect(fullCommand(undefined)).toBeNull();
});

it("une dépense sans prix connu ne s'affiche jamais 0 $", () => {
  expect(spentLabel(0, 3)).not.toMatch(/0 ?\$/);
  expect(spentLabel(0, 3)).toMatch(/prix inconnu|unknown price/);
  expect(spentLabel(1.5, 2)).toMatch(/1[.,]50/);
  expect(spentLabel(1.5, 2)).toMatch(/prix inconnu|unknown price/);
  expect(spentLabel(0, 0)).toMatch(/0/);
});
