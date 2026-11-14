import { ArrowDown, ArrowUp, GripVertical } from "lucide-react";
import { useRef, useState } from "react";
import { moveTab, TAB_NAMES, type NavTab } from "@/lib/navPrefs";
import { ObjectPage } from "./ObjectPage";
import { t } from "@/i18n";

export function CustomizeTabs({ tabs, save, error, onClose }: { tabs: NavTab[]; save: (tabs: NavTab[]) => Promise<boolean>; error: string; onClose: () => void }) {
  const [draft, setDraft] = useState(tabs);
  const [busy, setBusy] = useState(false);
  const drag = useRef<number | null>(null);
  const move = (from: number, to: number) => setDraft((cur) => moveTab(cur, from, to));
  return <ObjectPage title={t("Personnaliser")} onClose={onClose}><div className="shell-group">{draft.map((tab, i) => <div className="shell-row" draggable key={tab} onDragStart={() => { drag.current = i; }} onDragOver={(e) => e.preventDefault()} onDrop={() => { if (drag.current != null) move(drag.current, i); drag.current = null; }}>
    <GripVertical size={18} aria-hidden /><span className="grow">{TAB_NAMES[tab]}</span><button className="shell-icon" aria-label={t("Monter {onglet}", { onglet: TAB_NAMES[tab] })} disabled={i === 0} onClick={() => move(i, i - 1)}><ArrowUp size={18} /></button><button className="shell-icon" aria-label={t("Descendre {onglet}", { onglet: TAB_NAMES[tab] })} disabled={i === draft.length - 1} onClick={() => move(i, i + 1)}><ArrowDown size={18} /></button>{tab !== "chat" && <button className="shell-icon" aria-label={t("Retirer {onglet}", { onglet: TAB_NAMES[tab] })} onClick={() => setDraft(draft.filter((x) => x !== tab))}>✕</button>}</div>)}</div>
    <div className="shell-group">{(Object.keys(TAB_NAMES) as NavTab[]).filter((x) => !draft.includes(x)).map((tab) => <button className="shell-row" key={tab} onClick={() => setDraft([...draft, tab])}>＋ {TAB_NAMES[tab]}</button>)}</div>
    {error && <p role="alert">{error}</p>}<button className="shell-primary" disabled={busy} onClick={async () => { setBusy(true); if (await save(draft)) onClose(); setBusy(false); }}>{t("Enregistrer")}</button></ObjectPage>;
}
