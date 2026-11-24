import { AssistantRuntimeProvider, type ThreadMessageLike, useExternalStoreRuntime } from "@assistant-ui/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Citer avec @ et / : ouverture, filtre, touches, choix, pastille supprimable, e-mail et chemin sans déclenchement, téléphone (390 px), message envoyé.
const phone = vi.hoisted(() => {
  const state = { coarse: false };
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  globalThis.CSS ??= { escape: (s: string) => s.replace(/[^\w-]/g, "\\$&") } as unknown as typeof CSS;
  // « pointer: fine » vaut pour un ordinateur ; un téléphone est tactile et étroit.
  window.matchMedia = ((query: string) => ({ matches: state.coarse ? /coarse|max-width/.test(query) : /fine|min-width/.test(query), media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false })) as typeof window.matchMedia;
  return state;
});

const asked: string[] = [];
const AGENTS = { agents: [
  { id: "b1", nom: "Marie", role: "Rédige les comptes rendus", color: "#c2410c", shape: "", detail: "" },
  { id: "b2", nom: "Paul", role: "Tient la compta", color: "#2a47c9", shape: "", detail: "" },
] };
const SKILLS = { competences: [
  { nom: "competences/note-de-frais", titre: "Note de frais", resume: "Remplit une note de frais", origine: "enseigné par toi", desactivee: false },
  { nom: "competences/compte-rendu", titre: "Compte rendu de réunion", resume: "Résume une réunion en cinq lignes", origine: "enseigné par toi", desactivee: false },
  { nom: "apprise-seule", titre: "Facture", resume: "Prépare une facture", origine: "appris par ton agent", desactivee: true },
] };
const ROOT = { fichiers: [{ type: "fichier", chemin: "outputs/plan.md", nom: "plan.md", dossier: "outputs", modifie: 3 }, { type: "fichier", chemin: "notes.txt", nom: "notes.txt", dossier: "", modifie: 2 }], dossiers: [{ type: "dossier", chemin: "outputs", nom: "outputs", dossier: "", modifie: 3, fichiers: 2 }] };
const get = vi.fn(async (path: string): Promise<unknown> => {
  asked.push(path);
  if (path.includes("/mentions/agents")) return AGENTS;
  if (path.includes("/mentions/competences")) return SKILLS;
  if (path.includes("/mentions/fichiers")) {
    const url = new URL(path, "http://x");
    const dossier = url.searchParams.get("dossier"), q = url.searchParams.get("q") ?? "";
    if (dossier === "outputs") return { fichiers: [{ type: "fichier", chemin: "outputs/plan.md", nom: "plan.md", dossier: "outputs", modifie: 3 }], dossiers: [{ type: "dossier", chemin: "outputs/rapport", nom: "rapport", dossier: "outputs", modifie: 1, fichiers: 1 }] };
    if (q && "plan.md".includes(q.toLowerCase())) return { fichiers: ROOT.fichiers.slice(0, 1), dossiers: [] };
    if (q) return { fichiers: [], dossiers: [] };
    return ROOT;
  }
  return {};
});
vi.mock("@/lib/api", async (real) => ({ ...(await real<typeof import("@/lib/api")>()), get: (path: string) => get(path), send: vi.fn(async () => ({})) }));
import { AgentContext, WhileBusyContext } from "@/lib/agentContext";
import { lisible, mentionsOf } from "@/lib/mentionsCore";
import { serialize, splitMentions } from "@/lib/mentions";
import { Composer } from "./Composer";

let host: HTMLDivElement, root: Root, seq = 0;
const base = { agentName: "Noah", agentColor: "#c2410c", agentShape: "gomme", agentDetail: "", agentModel: "", details: false, hint: "", conversationId: null, say: () => {}, readOnly: false, canWatch: false };

function Scene({ agentId }: { agentId: string }) {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({ messages: [], isRunning: false, onNew: async () => {}, convertMessage: (m) => m });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <WhileBusyContext.Provider value={{ active: false, activity: null, waiting: [], sending: [], send: () => {}, now: async () => "", cancel: () => {}, giveUp: () => {} }}>
        <AgentContext.Provider value={{ ...base, agentId }}>
          <Composer inCall={false} />
        </AgentContext.Provider>
      </WhileBusyContext.Provider>
    </AssistantRuntimeProvider>
  );
}

const flush = async (times = 4) => { for (let i = 0; i < times; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const field = () => host.querySelector<HTMLTextAreaElement>("[data-composer-input]")!;
const list = () => host.querySelector<HTMLElement>("[role=listbox]");
const options = () => [...host.querySelectorAll<HTMLElement>("[role=option]")];
const labels = () => options().map((o) => o.querySelector(".mention-name")?.textContent);
const live = () => host.querySelector("[role=status]")?.textContent ?? "";

/** Comme la personne : le texte change, le curseur est à la fin, le champ émet son événement d'entrée. */
async function type(value: string, caret = value.length) {
  await act(async () => {
    const el = field();
    el.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
    el.setSelectionRange(caret, caret);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush(5);
}
async function press(key: string, init: KeyboardEventInit = {}) {
  let event!: KeyboardEvent;
  await act(async () => {
    event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    field().dispatchEvent(event);
  });
  await flush(1);
  return event;
}
async function mount(agentId: string) {
  await act(async () => root.render(<Scene agentId={agentId} />));
  await act(async () => { field().focus(); field().dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true })); }); // le premier geste charge la liste
  await flush(6);
}
const newAgent = () => `a${++seq}`;

beforeEach(() => {
  asked.length = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  phone.coarse = false;
  window.localStorage.removeItem("noah-mentions-aide");
});

it("@ ouvre la liste : trois groupes, role=listbox, la première ligne visée, le nombre de résultats annoncé", async () => {
  await mount(newAgent());
  expect(list()).toBeNull();
  await type("@");
  expect(list()).not.toBeNull();
  expect(list()!.getAttribute("aria-label")).toBe("Citer un agent, un fichier ou une compétence");
  expect([...host.querySelectorAll("[role=group] .mention-group")].map((g) => g.textContent)).toEqual(["Agents", "Fichiers", "Dossiers"]);
  expect(labels()).toEqual(["Marie", "Paul", "plan.md", "notes.txt", "outputs"]);
  expect(options()[0].getAttribute("aria-selected")).toBe("true");
  expect(field().getAttribute("role")).toBe("combobox");
  expect(field().getAttribute("aria-expanded")).toBe("true");
  expect(field().getAttribute("aria-activedescendant")).toBe(options()[0].id);
  expect(live()).toBe("5 résultats");
  expect(host.querySelector("[role=option] img, [role=option] svg")).not.toBeNull(); // un visage pour l'agent, une icône pour le reste
});

it("la liste se filtre en tapant : par nom, sans accent ni majuscule, par ce que fait l'agent, et par nom de fichier", async () => {
  await mount(newAgent());
  await type("@MAR");
  expect(labels()).toEqual(["Marie"]);
  expect(live()).toBe("1 résultat");
  await type("@compta"); // le rôle de Paul
  expect(labels()).toEqual(["Paul"]);
  await type("@plan");
  expect(labels()).toEqual(["plan.md"]);
  await type("@zzz");
  expect(options()).toHaveLength(0);
  expect(host.querySelector(".mention-empty")?.textContent).toBe("Aucun résultat");
  expect(field().getAttribute("aria-activedescendant")).toBeNull();
});

it("flèches, Entrée et Tab choisissent ; le choix devient une pastille dans le texte et le champ reste au clavier", async () => {
  const id = newAgent();
  await mount(id);
  await type("Demande à @");
  const down = await press("ArrowDown");
  expect(down.defaultPrevented).toBe(true);
  expect(options()[1].getAttribute("aria-selected")).toBe("true");
  expect(field().getAttribute("aria-activedescendant")).toBe(options()[1].id);
  await press("ArrowUp");
  await press("ArrowUp"); // revient à la dernière
  expect(options()[options().length - 1].getAttribute("aria-selected")).toBe("true");
  await press("ArrowDown");
  const enter = await press("Enter");
  expect(enter.defaultPrevented).toBe(true); // la saisie ne l'a pas vue : le message n'est pas parti
  expect(field().value).toBe("Demande à @Marie ");
  expect(list()).toBeNull();
  expect(mentionsOf(id).get("@Marie")).toEqual({ kind: "agent", label: "Marie", ref: "b1" });
  expect(host.querySelector(".mention-mirror mark")?.textContent).toBe("@Marie");
  expect(document.activeElement).toBe(field());
  await type("Demande à @Marie et lis @pl");
  await press("Tab");
  expect(field().value).toBe("Demande à @Marie et lis @plan.md ");
  expect([...mentionsOf(id).keys()]).toEqual(["@Marie", "@plan.md"]);
});

it("Échap ferme sans rien changer, et la liste ne revient qu'avec un nouveau mot", async () => {
  await mount(newAgent());
  await type("@ma");
  const esc = await press("Escape");
  expect(esc.defaultPrevented).toBe(true);
  expect(list()).toBeNull();
  expect(field().value).toBe("@ma");
  await type("@mar");
  expect(list()).toBeNull(); // le même mot, toujours fermé
  await type("@mar bonjour @");
  expect(list()).not.toBeNull();
});

it("un retour arrière juste après la pastille la retire en entier", async () => {
  const id = newAgent();
  await mount(id);
  await type("Salut @");
  await press("Enter");
  expect(field().value).toBe("Salut @Marie ");
  const first = await press("Backspace"); // l'espace : un retour arrière ordinaire
  expect(first.defaultPrevented).toBe(false);
  await type("Salut @Marie");
  const second = await press("Backspace");
  expect(second.defaultPrevented).toBe(true);
  expect(field().value).toBe("Salut ");
  expect(mentionsOf(id).size).toBe(0);
  expect(host.querySelector(".mention-mirror mark")).toBeNull();
});

it("une adresse e-mail, un chemin et une barre au milieu d'un mot ne déclenchent rien", async () => {
  const id = newAgent();
  await mount(id);
  for (const text of ["écris à a@b.c", "écris à paul@exemple.fr", "lis /home/user/notes", "https://exemple.fr/a", "a/b", "prix 5 @ 3 pièces", "x@"]) {
    await type(text);
    expect(list(), text).toBeNull();
  }
  await type("va dans /home");
  expect(options()).toHaveLength(0); // « home » ne ressemble à aucune compétence : rien ne s'affiche, Entrée envoie
  await press("Enter");
  expect(field().value).toBe(""); // Entrée est allée à la saisie : le message est parti
  expect(mentionsOf(id).size).toBe(0);
  expect(serialize(id, "écris à a@b.c")).toBe("écris à a@b.c");
});

it("/ en début de message ou après un espace liste les compétences ; la désactivée est dite telle et ne se choisit pas", async () => {
  const id = newAgent();
  await mount(id);
  await type("/");
  expect(labels()).toEqual(["Note de frais", "Compte rendu de réunion", "Facture"]);
  const facture = options()[2];
  expect(facture.getAttribute("aria-disabled")).toBe("true");
  expect(facture.textContent).toContain("désactivée");
  expect([...host.querySelectorAll("[role=group] .mention-group")].map((g) => g.textContent)).toEqual(["Compétences"]);
  expect(options()[0].textContent).toContain("Remplit une note de frais");
  await press("ArrowDown");
  await press("ArrowDown"); // saute la désactivée : retour à la première
  expect(options()[0].getAttribute("aria-selected")).toBe("true");
  await type("/fact");
  expect(options()).toHaveLength(1);
  await press("Enter"); // la désactivée ne se choisit pas : Entrée n'est pas prise
  expect(mentionsOf(id).size).toBe(0);
  await type("Fais ceci /reun");
  expect(labels()).toEqual(["Compte rendu de réunion"]); // après un espace, par la description ou le titre, sans accent
  await press("Enter");
  expect(field().value).toBe("Fais ceci /Compte rendu de réunion ");
  expect(mentionsOf(id).get("/Compte rendu de réunion")).toEqual({ kind: "competence", label: "Compte rendu de réunion", ref: "competences/compte-rendu" });
});

it("descendre dans un dossier : la flèche droite ou la flèche de la ligne, puis ses enfants", async () => {
  const id = newAgent();
  await mount(id);
  await type("@");
  const chevron = host.querySelector<HTMLButtonElement>("button.mention-in")!;
  expect(chevron.getAttribute("aria-label")).toBe("Ouvrir le dossier outputs");
  await act(async () => chevron.click());
  await flush();
  expect(field().value).toBe("@outputs/");
  expect(labels()).toEqual(["plan.md", "rapport"]); // plus d'agents : on est dans un dossier
  expect(asked.some((p) => p.includes("dossier=outputs") && p.includes("limite=50"))).toBe(true);
  await type("@");
  for (let i = 0; i < 4; i++) await press("ArrowDown"); // sur « outputs » (dernière ligne)
  expect(options()[options().length - 1].getAttribute("aria-selected")).toBe("true");
  const right = await press("ArrowRight");
  expect(right.defaultPrevented).toBe(true);
  expect(field().value).toBe("@outputs/");
  void id;
});

it("un toucher choisit sans enlever le focus du champ, et le message garde ses pastilles une fois sérialisé", async () => {
  const id = newAgent();
  await mount(id);
  await type("Regarde @pl");
  const option = options()[0];
  const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
  await act(async () => { option.dispatchEvent(down); });
  expect(down.defaultPrevented).toBe(true); // le clavier du téléphone reste ouvert
  await act(async () => option.click());
  await flush();
  expect(field().value).toBe("Regarde @plan.md ");
  expect(document.activeElement).toBe(field());
  await type("Regarde @plan.md avec @");
  await press("Enter");
  const sent = serialize(id, field().value.trimEnd());
  expect(sent).toBe("Regarde [@plan.md](noah:fichier/outputs/plan.md) avec [@Marie](noah:agent/b1)");
  expect(mentionsOf(id).size).toBe(0); // parties avec le message
  expect(splitMentions(sent)).toEqual(["Regarde ", { kind: "fichier", label: "plan.md", ref: "outputs/plan.md" }, " avec ", { kind: "agent", label: "Marie", ref: "b1" }]);
  expect(lisible(sent)).toBe("Regarde @plan.md avec @Marie");
});

it("le champ vidé par l'envoi n'efface pas les pastilles avant que le message ne soit écrit avec ses liens", async () => {
  const id = newAgent();
  await mount(id);
  await type("Regarde @pl");
  await press("Enter");
  await type("Regarde @plan.md ");
  await type(""); // l'envoi vide le champ ; le message est écrit juste après (un chargement de morceau, un tour de boucle)
  expect(mentionsOf(id).size).toBe(1);
  expect(serialize(id, "Regarde @plan.md ")).toBe("Regarde [@plan.md](noah:fichier/outputs/plan.md) ");
});

it("téléphone (390 px, pointeur tactile) : la liste s'ouvre, se touche, et reste dans la saisie", async () => {
  phone.coarse = true;
  Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
  try {
    const id = newAgent();
    await mount(id);
    await type("@");
    expect(list()).not.toBeNull();
    const pop = host.querySelector<HTMLElement>(".composer [data-mention-pop]");
    expect(pop).not.toBeNull(); // posée dans la saisie, pas dans la page : elle suit le clavier du téléphone
    await act(async () => options()[1].click());
    await flush();
    expect(field().value).toBe("@Paul ");
    await type("/");
    await act(async () => options()[0].click());
    await flush();
    expect(field().value).toBe("/Note de frais ");
    expect(serialize(id, field().value.trim())).toBe("[/Note de frais](noah:competence/competences%2Fnote-de-frais)".replace("%2F", "/"));
  } finally {
    Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
  }
});

it("la liste locale s'ouvre sans attendre : moins de 100 ms entre la frappe et la liste, une fois les agents lus", async () => {
  await mount(newAgent());
  await type("@"); // première ouverture : lit les agents et les fichiers
  await type("");
  const start = performance.now();
  await act(async () => {
    const el = field();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, "@");
    el.setSelectionRange(1, 1);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const took = performance.now() - start;
  expect(list()).not.toBeNull();
  expect(took).toBeLessThan(100);
  console.log(`ouverture de la liste @ depuis le cache : ${took.toFixed(1)} ms (jsdom)`);
  const calls = asked.length;
  await type("@ma");
  await type("@mar");
  expect(asked.slice(calls).filter((p) => p.includes("/mentions/agents") || p.includes("/mentions/competences")).length).toBe(0); // filtrer des agents ne demande rien de plus
});

it("la petite aide se montre au plus trois fois et jamais après un premier @", async () => {
  await mount(newAgent());
  expect(host.querySelector("[data-mention-hint]")?.textContent).toBe("@ pour citer un agent ou un fichier, / pour une compétence");
  await type("a");
  expect(host.querySelector("[data-mention-hint]")).toBeNull(); // elle ne gêne pas la saisie
  await type("");
  await type("@");
  expect(window.localStorage.getItem("noah-mentions-aide")).toBe("3");
  await type("");
  expect(host.querySelector("[data-mention-hint]")).toBeNull();
});
