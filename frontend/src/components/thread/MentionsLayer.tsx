// Citer avec @ et / dans la saisie : la liste qui s'ouvre sous le curseur, ses touches, et la pastille qui reste dans le texte.
// Chargé au premier clic dans la saisie (voir Composer.tsx) : rien de tout cela n'est du premier écran. Il se branche sur le champ
// (écouteurs natifs) sans que la saisie ne change : Entrée, flèches et Échap ne vont à la saisie que si la liste est fermée.
import "@/styles/mentions.css";
import { useAuiState } from "@assistant-ui/react";
import { ChevronRight, FileText, Folder, Sparkles } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AgentFace } from "../Noah";
import { t } from "@/i18n";
import {
  AGENTS_TTL, FILES_TTL, SKILLS_TTL, agentsKey, agentsPath, cleanLabel, detectTrigger, display, filesKey, filesPath, occurrences, plain, prune,
  scoreOf, skillsKey, skillsPath, splitQuery, useCached,
  type AgentHit, type FilesAnswer, type Mention, type SkillHit, type Trigger,
} from "@/lib/mentions";
import { mentionsOf } from "@/lib/mentionsCore";

const HINT_KEY = "noah-mentions-aide";
const HINT_TIMES = 3; // la petite aide se montre trois fois au plus, et plus jamais après un premier @ ou /

type Item = {
  id: string; group: "agents" | "fichiers" | "dossiers" | "competences"; mention: Mention; label: string; sub: string;
  agent?: AgentHit; disabled?: boolean; folder?: string;
};

const groupName = (g: Item["group"]) => (g === "agents" ? t("Agents") : g === "fichiers" ? t("Fichiers") : g === "dossiers" ? t("Dossiers") : t("Compétences"));

const readHint = () => { try { return Number(localStorage.getItem(HINT_KEY) || 0); } catch { return HINT_TIMES; } };
const writeHint = (n: number) => { try { localStorage.setItem(HINT_KEY, String(n)); } catch { /* stockage indisponible : l'aide reste */ } };

/** Écrit dans le champ comme si la personne l'avait tapé : la saisie de l'application le lit par son événement d'entrée. */
function typeInto(el: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

const sameTrigger = (a: Trigger | null, b: Trigger | null) => a === b || (!!a && !!b && a.char === b.char && a.start === b.start && a.query === b.query);

export default function MentionsLayer({ field, agentId }: { field: HTMLElement; agentId: string }) {
  const el = useMemo(() => field.querySelector("textarea"), [field]);
  const root = field.closest<HTMLElement>(".composer") ?? field;
  const known = mentionsOf(agentId);
  const listId = useId();
  const composerText = useAuiState((s) => s.composer.text);
  const [text, setText] = useState(el?.value ?? "");
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [active, setActive] = useState(0);
  const [focused, setFocused] = useState(() => !!el && document.activeElement === el);
  const dismissed = useRef<number | null>(null);
  const forgetLater = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(forgetLater.current), []);

  // --- Ce qu'on tape ---
  const sync = useCallback(() => {
    if (!el) return;
    setText(el.value);
    // Un champ vidé par l'envoi se vide avant que le message ne soit écrit avec ses liens : on n'oublie les pastilles qu'un instant après.
    clearTimeout(forgetLater.current);
    if (el.value) prune(agentId, el.value);
    else forgetLater.current = setTimeout(() => prune(agentId, el.value), 3000);
    const caret = el.selectionStart ?? el.value.length;
    const found = el.selectionEnd !== el.selectionStart ? null : detectTrigger(el.value, caret, mentionsOf(agentId));
    if (found?.start !== dismissed.current) dismissed.current = null; // un autre mot, ou plus de mot : Échap est oublié
    const next = found && dismissed.current === found.start ? null : found;
    setTrigger((cur) => (sameTrigger(cur, next) ? cur : next));
  }, [el, agentId]);
  useEffect(() => {
    if (!el) return;
    const events = ["input", "keyup", "click", "select", "focus"] as const;
    const onFocus = () => { setFocused(true); sync(); };
    const onBlur = () => { setFocused(false); setTrigger(null); };
    events.forEach((e) => el.addEventListener(e, e === "focus" ? onFocus : sync));
    el.addEventListener("blur", onBlur);
    sync();
    return () => { events.forEach((e) => el.removeEventListener(e, e === "focus" ? onFocus : sync)); el.removeEventListener("blur", onBlur); };
  }, [el, sync]);
  useEffect(sync, [composerText, sync]); // le message est parti, ou rappelé de l'historique : le champ a changé sans qu'on tape
  useEffect(() => { setActive(0); }, [trigger?.char, trigger?.query, trigger?.start]);

  // --- Les suggestions ---
  const q = trigger?.query ?? "";
  const wide = trigger?.char === "@" ? splitQuery(q) : { dossier: "", q: "" };
  const agents = useCached<{ agents: AgentHit[] }>(trigger?.char === "@" && !wide.dossier ? agentsKey(agentId) : null, agentsPath(agentId), AGENTS_TTL, { agents: [] });
  const files = useCached<FilesAnswer>(trigger?.char === "@" ? filesKey(agentId, wide.dossier, wide.q) : null, filesPath(agentId, wide.dossier, wide.q), FILES_TTL, { fichiers: [], dossiers: [] }, true);
  const skills = useCached<{ competences: SkillHit[] }>(trigger?.char === "/" ? skillsKey(agentId) : null, skillsPath(agentId), SKILLS_TTL, { competences: [] });

  const items = useMemo<Item[]>(() => {
    if (!trigger) return [];
    const out: Item[] = [];
    if (trigger.char === "/") {
      const hits = (skills.data?.competences ?? [])
        .map((s) => ({ s, score: Math.min(scoreOf(s.titre, q) ?? 9, scoreOf(s.nom, q) ?? 9, q && plain(s.resume).includes(plain(q)) ? 3 : 9) }))
        .filter((x) => x.score < 9)
        .sort((a, b) => Number(a.s.desactivee) - Number(b.s.desactivee) || a.score - b.score);
      for (const { s } of hits) out.push({ id: `c:${s.nom}`, group: "competences", mention: { kind: "competence", label: cleanLabel(s.titre || s.nom), ref: s.nom }, label: s.titre || s.nom, sub: s.desactivee ? t("désactivée") : s.resume, disabled: s.desactivee });
      return out;
    }
    if (!wide.dossier) {
      const hits = (agents.data?.agents ?? [])
        .map((a) => ({ a, score: scoreOf(a.nom, wide.q) ?? (wide.q && plain(a.role).includes(plain(wide.q)) ? 3 : null) }))
        .filter((x): x is { a: AgentHit; score: number } => x.score !== null)
        .sort((x, y) => x.score - y.score)
        .slice(0, wide.q ? 8 : 5);
      for (const { a } of hits) out.push({ id: `a:${a.id}`, group: "agents", mention: { kind: "agent", label: cleanLabel(a.nom), ref: a.id }, label: a.nom, sub: a.role, agent: a });
    }
    const all = wide.dossier ? 50 : wide.q ? 8 : 6;
    for (const f of (files.data?.fichiers ?? []).slice(0, all)) out.push({ id: `f:${f.chemin}`, group: "fichiers", mention: { kind: "fichier", label: cleanLabel(f.nom), ref: f.chemin }, label: f.nom, sub: f.dossier });
    for (const d of (files.data?.dossiers ?? []).slice(0, wide.dossier ? 50 : 4)) out.push({ id: `d:${d.chemin}`, group: "dossiers", mention: { kind: "dossier", label: cleanLabel(d.nom), ref: d.chemin }, label: d.nom, sub: d.dossier, folder: d.chemin });
    return out;
  }, [trigger, q, wide.dossier, wide.q, agents.data, files.data, skills.data]);

  const loading = !!trigger && (trigger.char === "/" ? skills.loading : (agents.loading && !wide.dossier) || files.loading);
  const open = !!trigger && items.length > 0;
  // « Aucun résultat » seulement pour @ : un chemin tapé avec / (« /home ») ne doit rien afficher qui gêne.
  const showEmpty = !!trigger && trigger.char === "@" && !items.length && !loading;
  const showList = open || (!!trigger && loading) || showEmpty;

  // --- Choisir ---
  const replace = useCallback((start: number, end: number, insert: string) => {
    if (!el) return;
    const tail = el.value.slice(end);
    const spaced = insert.endsWith(" ") && /^\s/.test(tail) ? insert.slice(0, -1) : insert;
    typeInto(el, el.value.slice(0, start) + spaced + tail);
    const at = start + spaced.length + (spaced !== insert ? 1 : 0);
    el.setSelectionRange(at, at);
    const written = el.value; // le navigateur peut replacer le curseur après nous : on le remet, sauf si la personne a déjà retapé
    requestAnimationFrame(() => { if (el.value === written) { el.setSelectionRange(at, at); sync(); } });
    sync();
  }, [el, sync]);

  const choose = useCallback((item: Item) => {
    if (!trigger || item.disabled) return;
    const same = (m: Mention) => known.get(display(m));
    let mention = item.mention;
    const clash = same(mention);
    if (clash && clash.ref !== mention.ref) mention = { ...mention, label: cleanLabel(item.group === "fichiers" || item.group === "dossiers" ? mention.ref : item.group === "agents" ? `${mention.label} (${mention.ref})` : mention.ref) };
    known.set(display(mention), mention);
    writeHint(HINT_TIMES);
    replace(trigger.start, trigger.end, display(mention) + " ");
  }, [trigger, known, replace]);

  const descend = useCallback((item: Item) => {
    if (!trigger || !item.folder) return;
    replace(trigger.start, trigger.end, `@${item.folder}/`);
  }, [trigger, replace]);

  // --- Les touches : la liste les prend tant qu'elle est ouverte, la saisie ne les voit pas ---
  const live = useRef({ items, active, trigger, open, choose, descend });
  live.current = { items, active, trigger, open, choose, descend };
  useEffect(() => {
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      const s = live.current;
      if (e.isComposing || !s.open || !s.trigger) return;
      const take = () => { e.preventDefault(); e.stopImmediatePropagation(); };
      const usable = s.items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        if (!usable.length) return;
        take();
        const at = usable.indexOf(s.active);
        const step = e.key === "ArrowDown" ? 1 : -1;
        setActive(usable[(at < 0 ? (step > 0 ? 0 : usable.length - 1) : at + step + usable.length) % usable.length]);
      } else if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
        const item = s.items[s.active];
        if (!item || item.disabled) return;
        take();
        s.choose(item);
      } else if (e.key === "Escape") {
        take();
        dismissed.current = s.trigger.start;
        setTrigger(null);
      } else if (e.key === "ArrowRight" && !e.shiftKey && el.selectionStart === s.trigger.end) {
        const item = s.items[s.active];
        if (item?.folder) { take(); s.descend(item); }
      }
    };
    el.addEventListener("keydown", onKey, true);
    return () => el.removeEventListener("keydown", onKey, true);
  }, [el]);

  // Retour arrière juste après une pastille : elle part en entier, comme un seul caractère.
  useEffect(() => {
    if (!el) return;
    const onBack = (e: KeyboardEvent) => {
      if (e.key !== "Backspace" || e.isComposing || e.ctrlKey || e.metaKey || e.altKey || el.selectionStart !== el.selectionEnd) return;
      const caret = el.selectionStart ?? 0;
      const hit = occurrences(el.value, mentionsOf(agentId)).find((o) => o.end === caret);
      if (!hit) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      typeInto(el, el.value.slice(0, hit.start) + el.value.slice(hit.end));
      el.setSelectionRange(hit.start, hit.start);
      const written = el.value;
      requestAnimationFrame(() => { if (el.value === written) { el.setSelectionRange(hit.start, hit.start); sync(); } });
      sync();
    };
    el.addEventListener("keydown", onBack, true);
    return () => el.removeEventListener("keydown", onBack, true);
  }, [el, agentId, sync]);

  // --- Accessibilité : le champ dit qu'il propose une liste, et laquelle de ses lignes est visée ---
  const optionId = (i: number) => `${listId}-o${i}`;
  useEffect(() => {
    if (!el) return;
    el.setAttribute("role", "combobox");
    el.setAttribute("aria-autocomplete", "list");
    el.setAttribute("aria-haspopup", "listbox");
    el.setAttribute("aria-controls", listId);
    el.setAttribute("aria-expanded", String(showList));
    if (open) el.setAttribute("aria-activedescendant", optionId(active));
    else el.removeAttribute("aria-activedescendant");
    return () => {
      ["role", "aria-autocomplete", "aria-haspopup", "aria-controls", "aria-expanded", "aria-activedescendant"].forEach((a) => el.removeAttribute(a));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [el, listId, showList, open, active]);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { listRef.current?.querySelector(`[id="${optionId(active)}"]`)?.scrollIntoView?.({ block: "nearest" }); }, [active, items]);

  // --- La petite aide, les premières fois ---
  const [seen, setSeen] = useState(readHint);
  const wantHint = seen < HINT_TIMES && focused && !text && !trigger;
  const counted = useRef(false);
  useEffect(() => {
    if (!wantHint) { counted.current = false; return; }
    if (!counted.current) { counted.current = true; writeHint(seen + 1); }
  }, [wantHint, seen]);
  useEffect(() => { if (trigger) { writeHint(HINT_TIMES); setSeen(HINT_TIMES); } }, [trigger]);

  const spans = useMemo(() => {
    const parts: { text: string; pill: boolean }[] = [];
    let at = 0;
    for (const o of occurrences(text, known)) {
      if (o.start > at) parts.push({ text: text.slice(at, o.start), pill: false });
      parts.push({ text: text.slice(o.start, o.end), pill: true });
      at = o.end;
    }
    parts.push({ text: text.slice(at), pill: false });
    return parts;
  }, [text, known]);

  if (!el) return null;
  const count = items.length;
  const announce = loading && !count ? t("Chargement…") : !count ? t("Aucun résultat") : count === 1 ? t("1 résultat") : t("{n} résultats", { n: count });
  const groups = (["agents", "fichiers", "dossiers", "competences"] as const).map((g) => ({ g, rows: items.map((item, i) => ({ item, i })).filter((r) => r.item.group === g) })).filter((x) => x.rows.length);

  return (
    <>
      {createPortal(
        <div className="mention-mirror" aria-hidden>
          {spans.map((p, i) => (p.pill ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}{"\n"}
        </div>,
        field,
      )}
      {wantHint && createPortal(<p className="mention-hint" data-mention-hint>{t("@ pour citer un agent ou un fichier, / pour une compétence")}</p>, field)}
      {showList && createPortal(
        <div className="mention-pop" data-mention-pop ref={listRef}>
          <div id={listId} role="listbox" aria-label={t("Citer un agent, un fichier ou une compétence")}>
            {groups.map(({ g, rows }) => (
              <div key={g} role="group" aria-labelledby={`${listId}-g-${g}`}>
                <div className="mention-group" id={`${listId}-g-${g}`} role="presentation">{groupName(g)}</div>
                {rows.map(({ item, i }) => (
                  <div
                    key={item.id}
                    id={optionId(i)}
                    role="option"
                    aria-selected={i === active}
                    aria-disabled={item.disabled || undefined}
                    data-mention-option
                    data-active={i === active ? "" : undefined}
                    className="mention-opt"
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseMove={() => !item.disabled && i !== active && setActive(i)}
                    onClick={() => choose(item)}
                  >
                    <span className="mention-ico" aria-hidden>
                      {item.agent ? <AgentFace agent={{ id: item.agent.id, color: item.agent.color, shape: item.agent.shape, detail: item.agent.detail }} className="size-6" /> : item.group === "dossiers" ? <Folder /> : item.group === "competences" ? <Sparkles /> : <FileText />}
                    </span>
                    <span className="mention-txt">
                      <span className="mention-name cut">{item.label}</span>
                      {item.sub && <span className="mention-sub cut">{item.sub}</span>}
                    </span>
                    {item.folder && (
                      <button type="button" tabIndex={-1} className="mention-in" aria-label={t("Ouvrir le dossier {nom}", { nom: item.label })} onMouseDown={(e) => e.preventDefault()} onClick={(e) => { e.stopPropagation(); descend(item); }}>
                        <ChevronRight aria-hidden />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            ))}
            {loading && !count && <div className="mention-empty" role="presentation">{t("Chargement…")}</div>}
            {showEmpty && <div className="mention-empty" role="presentation">{t("Aucun résultat")}</div>}
          </div>
        </div>,
        root,
      )}
      <span className="sr-only" role="status" aria-live="polite">{showList ? announce : ""}</span>
    </>
  );
}
