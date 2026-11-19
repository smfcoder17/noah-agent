import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("@/lib/api", () => ({ send: vi.fn(async () => ({ id: "q1", etat: "repondue" })) }));
vi.mock("./ui", () => ({ ErrorText: ({ children }: { children?: React.ReactNode }) => (children ? <p role="alert">{children}</p> : null) }));
import { type QuestionCarte, send } from "@/lib/api";
import { QUESTION_REPONDUE, QuestionCard } from "./QuestionCard";

const question: QuestionCarte = {
  id: "q1", genre: "question" as const, de: "hugo", de_nom: "Hugo", tache_id: "t1", tache: "Envoi de la newsletter", conversation_id: "c1",
  titre: "Quelle heure pour l'envoi ?", pourquoi: "Deux créneaux sont libres.", choix: ["8 h", "12 h"], libre: true, reserve: "" as const,
  chemin: [{ id: "hugo", nom: "Hugo" }, { id: "noah", nom: "Noah" }], cree: 1_700_000_000,
};
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => { vi.mocked(send).mockReset().mockResolvedValue({ id: "q1" }); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const show = (props: Partial<Parameters<typeof QuestionCard>[0]> = {}, q = question) => act(async () => root.render(<QuestionCard q={q} {...props} />));
const bouton = (nom: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === nom)!;

it("dit qui demande et par qui elle est passée, pour quelle tâche, la question, le pourquoi et les choix", async () => {
  await show();
  expect(host.textContent).toContain("Hugo, transmis par Noah");
  expect(host.textContent).toContain("tâche « Envoi de la newsletter »");
  expect(host.querySelector("h2")?.textContent).toBe("Quelle heure pour l'envoi ?");
  expect(host.textContent).toContain("Deux créneaux sont libres.");
  expect(bouton("8 h")).toBeTruthy();
  expect(bouton("12 h")).toBeTruthy();
  expect(host.querySelector("input")?.getAttribute("placeholder")).toBe("Autre réponse");
});

it("un choix part sur place, la carte devient « Tu as répondu », les autres lieux sont prévenus", async () => {
  const vu = vi.fn();
  window.addEventListener(QUESTION_REPONDUE, vu);
  await show();
  await act(async () => bouton("8 h").click());
  expect(send).toHaveBeenCalledWith("/api/questions/q1/reponse", { reponse: "8 h" });
  expect(host.textContent).toContain("Tu as répondu : 8 h");
  expect(host.querySelector("button")).toBeNull();
  expect((vu.mock.calls[0][0] as CustomEvent).detail).toEqual({ id: "q1", reponse: "8 h" });
  window.removeEventListener(QUESTION_REPONDUE, vu);
});

it("« Autre réponse » : vide, rien ne part ; écrite, elle part avec « Envoyer »", async () => {
  await show();
  await act(async () => bouton("Envoyer").click());
  expect(send).not.toHaveBeenCalled();
  const champ = host.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(champ, "10 h 30");
    champ.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => bouton("Envoyer").click());
  expect(send).toHaveBeenCalledWith("/api/questions/q1/reponse", { reponse: "10 h 30" });
  expect(host.textContent).toContain("Tu as répondu : 10 h 30");
});

it("sans « Autre réponse » (libre non), seuls les choix se montrent ; un sujet réservé porte sa pastille", async () => {
  await show({}, { ...question, libre: false, reserve: "payer" });
  expect(host.querySelector("input")).toBeNull();
  expect(host.querySelector(".pill")?.textContent).toBe("Paiement");
});

it("déjà répondue ailleurs (409) : la carte se règle sans erreur ; réseau en panne : elle reste avec un mot simple", async () => {
  vi.mocked(send).mockRejectedValueOnce(Object.assign(new Error("déjà"), { status: 409 }));
  await show();
  await act(async () => bouton("8 h").click());
  expect(host.textContent).toContain("Cette question est réglée.");
  await act(async () => root.unmount());
  root = createRoot(host);
  vi.mocked(send).mockRejectedValueOnce(new Error("réseau"));
  await show();
  await act(async () => bouton("12 h").click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("La réponse n'est pas partie");
  expect(bouton("12 h")).toBeTruthy();
});

it("dans une ligne de tâche : sans cadre, le pourquoi, la question et les choix", async () => {
  await show({ dansTache: true });
  expect(host.querySelector(".card")).toBeNull();
  expect(host.textContent).toContain("Hugo a demandé à Noah. Deux créneaux sont libres.");
  expect(host.querySelector("b")?.textContent).toBe("Quelle heure pour l'envoi ?");
});
