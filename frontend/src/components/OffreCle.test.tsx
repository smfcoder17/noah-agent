// X17 : une clé masquée offre de se ranger au coffre ; le bouton ouvre l'ajout avec la valeur tapée dans cette fenêtre, et rien ne part ailleurs.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const ouvert = vi.hoisted(() => ({ props: null as null | { initial: Record<string, string>; description: string; onClose: () => void; onSaved: () => void } }));
vi.mock("./Vault", () => ({ VaultAddDialog: (p: NonNullable<typeof ouvert.props>) => { ouvert.props = p; return <div data-vault-dialog>{p.description}</div>; } }));

import { masquer, oublierLesCles, retenirCles } from "@/lib/nettoyage";
import { OffreCle } from "./OffreCle";

const CLE = "sk-" + "a1B2c3D4e5F6g7H8i9J0k1L2";
let host: HTMLDivElement, root: Root;
beforeEach(() => { ouvert.props = null; oublierLesCles(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const rendre = (texte: string) => act(async () => root.render(<OffreCle text={texte} />));
const bouton = () => [...host.querySelectorAll("button")].find((b) => /coffre/i.test(b.textContent ?? ""));

it("un message sans clé masquée n'offre rien", async () => {
  await rendre("Bonjour, tout va bien.");
  expect(host.innerHTML).toBe("");
});

it("une clé tapée ici : le texte est masqué, l'offre ouvre le coffre avec la valeur, jamais affichée", async () => {
  retenirCles(`voici ma clé ${CLE}`);
  const texte = masquer(`voici ma clé ${CLE}`).texte;
  await rendre(texte);
  expect(host.textContent).not.toContain(CLE);
  expect(host.textContent).toMatch(/masquée/);
  await act(async () => bouton()!.click());
  expect(ouvert.props!.initial.mot_de_passe).toBe(CLE);
  expect(ouvert.props!.initial.nom).toBe("Clé OpenAI");
  expect(host.querySelector("[data-vault-dialog]")!.textContent).not.toContain(CLE);
  await act(async () => { ouvert.props!.onSaved(); ouvert.props!.onClose(); });
  expect(host.textContent).toContain("Rangée au coffre");
  expect(bouton()).toBeUndefined();
});

it("un ancien message relu : la valeur n'existe plus à l'écran, le formulaire s'ouvre vide et le dit", async () => {
  await rendre("ma clé : ghp_•••• (clé masquée)");
  await act(async () => bouton()!.click());
  expect(ouvert.props!.initial.mot_de_passe).toBe("");
  expect(ouvert.props!.initial.nom).toBe("Clé GitHub");
  expect(ouvert.props!.description).toMatch(/Colle ta clé/);
});

it("deux clés : une offre chacune", async () => {
  await rendre("sk-•••• (clé masquée) et ghp_•••• (clé masquée)");
  expect(host.querySelectorAll("button")).toHaveLength(2);
});
