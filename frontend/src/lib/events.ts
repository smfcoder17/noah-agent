// Un seul flux par fenêtre ; le fetch permet Last-Event-ID et le renouvellement Android de request().
import { useCallback, useContext, useEffect, useRef, useSyncExternalStore } from "react";
import { SeenActive } from "./seen";
import { currentAuthEpoch, get, request, type Accord, type Agent, type Conversation } from "./api";

let items: Accord[] = [];
let recent: AccordClosed[] = [];
let snapshot = { items, recent };
const listeners = new Set<() => void>();
const updates = new Set<() => unknown>();
let queued: ReturnType<typeof setTimeout> | undefined;
let lastUpdate = -Infinity;
let waiters: (() => void)[] = [];
function changed() {
  return new Promise<void>((resolve) => {
    waiters.push(resolve);
    if (queued !== undefined) return;
    queued = setTimeout(() => {
      queued = undefined;
      const pending = waiters; waiters = [];
      if (document.hidden) { pending.forEach((done) => done()); return; }
      lastUpdate = Date.now();
      void Promise.all([...updates].map((fn) => Promise.resolve().then(fn).catch(() => {})))
        .finally(() => pending.forEach((done) => done()));
    }, Math.max(0, 500 - (Date.now() - lastUpdate)));
  });
}
function cancelUpdates() {
  clearTimeout(queued); queued = undefined; lastUpdate = -Infinity;
  waiters.forEach((done) => done()); waiters = [];
}
const visible = () => { if (!document.hidden) changed(); };
let controller: AbortController | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
let revision = "";
let epoch = "";
let changes = 0;
let reads = 0;
let resyncPending = false;
function resetAccount() {
  const auth = currentAuthEpoch();
  if (auth === epoch) return;
  epoch = auth;
  changes++;
  items = [];
  recent = [];
  revision = "";
  resyncPending = false;
  cancelUpdates();
  controller?.abort();
  controller = null;
  notify();
  if (listeners.size) {
    controller = new AbortController();
    void consume(controller.signal);
  }
}
export type AccordClosed = { id: string; par: string | null; etat: string; conv_id: string; request_id: string; run_id: string; generation: number };
const notify = () => {
  snapshot = { items, recent };
  listeners.forEach((fn) => fn());
};
export const accordLabel = (a: AccordClosed) => {
  const label = ({ donne: "Accord donné", refuse: "Accord refusé" } as Record<string, string>)[a.etat];
  if (!label) return null;
  const where = ({ ordinateur: "sur l'ordinateur", téléphone: "sur le téléphone", web: "sur le web" } as Record<string, string>)[a.par ?? ""];
  return `${label}${where ? ` ${where}` : ""}`;
};

export async function refreshAccords() {
  const read = ++reads;
  const version = changes;
  const auth = currentAuthEpoch();
  const rows = await get<Accord[]>("/api/accords");
  if (read !== reads || version !== changes || auth !== currentAuthEpoch() || !listeners.size) return;
  items = rows;
  notify();
}

async function consume(signal: AbortSignal) {
  while (!signal.aborted) {
    try {
      if (resyncPending) {
        const agents = await get<Agent[]>("/api/agents");
        const conversations = await Promise.all(agents.map((a) => get<Conversation[]>(`/api/agents/${a.id}/conversations`)));
        await Promise.all(conversations.flat().map((c) => get(`/api/conversations/${c.id}/en-cours?suivi=false`)));
        if (signal.aborted) return;
        const tasks: Promise<unknown>[] = [];
        window.dispatchEvent(new CustomEvent("noah:resync", { detail: tasks }));
        await Promise.all([refreshAccords(), ...tasks]);
        await changed();
        if (signal.aborted) return;
        resyncPending = false;
      }
      if (signal.aborted) return;
      const response = await request("/api/events", { headers: revision ? { "Last-Event-ID": revision } : {}, signal });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let resync = false;
      try {
        while (!signal.aborted && !resync) {
          let silent: ReturnType<typeof setTimeout> | undefined;
          const { value, done } = await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => { silent = setTimeout(() => reject(new Error("Flux muet")), 35000); }),
          ]).finally(() => clearTimeout(silent));
          if (done || signal.aborted) break;
          buffer += decoder.decode(value, { stream: true });
          let end: number;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const chunk = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const fields = Object.fromEntries(chunk.split("\n").map((line) => [line.split(":", 1)[0], line.slice(line.indexOf(":") + 1).trim()]));
            if (!fields.event) continue;
            if (fields.event !== "resync") changed();
            revision = fields.id || revision;
            if (fields.event === "accord.clos") {
              const closed = JSON.parse(fields.data) as AccordClosed;
              changes++;
              items = items.filter((a) => a.id !== closed.id);
              recent = [...recent.filter((a) => a.id !== closed.id), closed].slice(-200);
              notify();
              window.dispatchEvent(new Event("noah:accord-repondu"));
            }
            if (fields.event === "resync") {
              changes++;
              items = [];
              recent = [];
              notify();
              resync = true;
              resyncPending = true;
              break;
            }
            if (fields.event === "pret" || fields.event === "accord.demande" || fields.event === "accord.clos") {
              if (fields.event === "accord.demande") changes++;
              await refreshAccords();
            }
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    } catch {
      // Le sondage reste actif pendant la reconnexion du flux.
    }
    if (!signal.aborted) await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(wait); signal.removeEventListener("abort", done); resolve(); };
      const wait = setTimeout(done, 1500);
      signal.addEventListener("abort", done, { once: true });
    });
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    window.addEventListener("noah:auth-epoch", resetAccount);
    window.addEventListener("storage", resetAccount);
    document.addEventListener("visibilitychange", visible);
  }
  if (!controller) {
    const auth = currentAuthEpoch();
    if (auth !== epoch) { items = []; recent = []; revision = ""; resyncPending = false; epoch = auth; notify(); }
    controller = new AbortController();
    void consume(controller.signal);
    void refreshAccords().catch(() => {});
    timer = setInterval(() => { void refreshAccords().catch(() => {}); changed(); }, 60000);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      controller?.abort(); controller = null; clearInterval(timer); changes++;
      cancelUpdates();
      window.removeEventListener("noah:auth-epoch", resetAccount);
      window.removeEventListener("storage", resetAccount);
      document.removeEventListener("visibilitychange", visible);
    }
  };
}

export const useAccords = () => useSyncExternalStore(subscribe, () => snapshot);

/** Même transport que les accords, avec secours unique à 60 s et reprise au retour de la fenêtre. */
export function subscribeUpdates(fn: () => unknown) {
  updates.add(fn);
  const stop = subscribe(() => {});
  return () => { updates.delete(fn); stop(); };
}

/** Les écrans gardés ignorent les signaux cachés et relisent au retour. */
export function useVisibleSubscription() {
  const active = useContext(SeenActive);
  const visible = useRef(active);
  visible.current = active;
  useEffect(() => { if (active) changed(); }, [active]);
  return useCallback((fn: () => unknown) => {
    return subscribeUpdates(() => { if (visible.current && !document.hidden) return fn(); });
  }, []);
}
