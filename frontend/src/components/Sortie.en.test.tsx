// La page « Sortie réseau » en anglais : chaque phrase, chaque phase, l'état du VPN et les actions, sans un mot de français ;
// ses actions appellent les routes du serveur (GET /api/sortie, PUT et DELETE /api/sortie/vpn).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { choisirLangue } from "@/i18n";

const base = {
  phase: "relais_actif", active: "maison", lanceur: true, bascules: [],
  relais: { voulu: true, connecte: true, nom: "PC-de-Franck", adresse: "203.0.113.7", lieu: "Montréal, Québec" },
  vpn: { configure: false, fournisseur: "", etat: "non_configure", adresse: "", lieu: "", ville: "" },
  serveur: { adresse: "198.51.100.2" },
};
let resume: Record<string, unknown> = base;
const appels: string[] = [];
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  get: vi.fn(async (p: string) => { appels.push(`GET ${p}`); return resume; }),
  send: vi.fn(async (p: string, _b: unknown, m?: string) => { appels.push(`${m ?? "POST"} ${p}`); return {}; }),
  del: vi.fn(async (p: string) => { appels.push(`DELETE ${p}`); return {}; }),
}));
import { Sortie } from "./Sortie";

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  choisirLangue("en", false);
  appels.length = 0;
  delete (window as { noahDesktop?: unknown }).noahDesktop;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); choisirLangue("fr", false); });
const render = async (r: Record<string, unknown>) => {
  resume = r;
  await act(async () => { root.render(<div />); });
  await act(async () => root.render(<Sortie />));
};
const FRANCAIS = /\b(Tes|tes|ton|ta|ils|sortent|ordinateur|Avancé|Retirer|Enregistrer|Prêt|Actif|serveur|Lecture)\b/;

it("anglais : chaque phase se lit en anglais", async () => {
  const eteint = { ...base.relais, connecte: false };
  const cas: [Record<string, unknown>, string][] = [
    [base, "Your agents go out through your computer (PC-de-Franck), in Montréal, Québec"],
    [{ ...base, phase: "relais_connecte", active: "direct" }, "Your computer (PC-de-Franck) is connected: your agents will go out through it in a moment"],
    [{ ...base, phase: "relais_eteint", active: "direct", relais: eteint }, "Your computer is off: they go out through the server"],
    [{ ...base, phase: "relais_eteint", active: "vpn", relais: eteint }, "Your computer is off: they go out through your VPN"],
    [{ ...base, phase: "sans_relais", active: "vpn", relais: { ...base.relais, voulu: false, connecte: false, nom: "" } }, "Your agents go out through your VPN"],
    [{ ...base, phase: "sans_relais", active: "direct", relais: { ...base.relais, voulu: false, connecte: false, nom: "" } }, "Install the Noah app on your computer to make them go out from your home"],
  ];
  for (const [r, phrase] of cas) {
    await render(r);
    expect(host.querySelector("[data-sortie-etat]")?.textContent).toBe(phrase);
  }
  expect(host.textContent).not.toMatch(FRANCAIS);
});

it("anglais : l'état du VPN, les boutons et l'aide sont traduits ; les actions appellent les bonnes routes", async () => {
  await render({ ...base, vpn: { configure: true, fournisseur: "custom", etat: "injoignable", adresse: "192.0.2.9", lieu: "Montréal", ville: "" } });
  const avance = host.querySelector("details[data-sortie-avance]")!;
  expect(avance.querySelector("summary")?.textContent).toBe("Advanced");
  expect(avance.querySelector("[data-vpn-etat]")?.textContent).toBe("A VPN is saved. Unreachable Sites see you as 192.0.2.9 (Montréal).");
  expect([...avance.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Save", "Remove"]);
  expect(host.textContent).not.toMatch(FRANCAIS);
  expect(appels).toContain("GET /api/sortie");
  const champ = avance.querySelector<HTMLTextAreaElement>("textarea")!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(champ, "[Interface]"); champ.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => [...avance.querySelectorAll("button")].find((b) => b.textContent === "Save")!.click());
  vi.spyOn(window, "confirm").mockReturnValue(true);
  await act(async () => [...avance.querySelectorAll("button")].find((b) => b.textContent === "Remove")!.click());
  expect(appels).toContain("PUT /api/sortie/vpn");
  expect(appels).toContain("DELETE /api/sortie/vpn");
});
