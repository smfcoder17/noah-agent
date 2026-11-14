import { useState } from "react";
import { t } from "@/i18n";
import { accordLabel, refreshAccords, useAccords } from "@/lib/events";
import { send } from "@/lib/api";
import { ObjectPage } from "./ObjectPage";

export function Approvals({ agentId }: { agentId: string }) {
  const { items, recent } = useAccords();
  const [selected, select] = useState<string | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const rows = items.filter((a) => a.agent_id === agentId).sort((a, b) => a.created - b.created);
  const current = rows.find((a) => a.id === selected);
  const answer = async (approve: boolean) => {
    if (!current || current.bureau) return;
    setBusy(true); setError("");
    try { await send(`/api/agents/${current.agent_id}/runs/${current.run_id}/approval`, { request_id: current.request_id, generation: current.generation, approve }); await refreshAccords(); select(null); }
    catch (e) { setError((e as Error).message); void refreshAccords().catch(() => {}); } finally { setBusy(false); }
  };
  return <section aria-label={t("Accords")}className="flex flex-col gap-2">{rows.map((a) => <button key={a.id} className="shell-row shell-group" onClick={() => { select(a.id); setError(""); }}><span className="grow">{a.demande}</span><span aria-hidden>›</span></button>)}{recent.slice(-2).map((a) => accordLabel(a) && <p key={a.id} className="text-[12.5px] text-muted-foreground">{accordLabel(a)}</p>)}
    {current && <ObjectPage title={t("Accord à donner")} onClose={() => select(null)}><b>{current.demande}</b>{current.pourquoi && <p>{current.pourquoi}</p>}{current.apercu.map((p, i) => <p className="rounded-xl bg-muted p-3" key={i}>{p}</p>)}{current.bureau ? <p>{t("À accepter sur ton ordinateur")}</p> : <div className="flex gap-2"><button className="shell-row shell-group" disabled={busy} onClick={() => void answer(false)}>{t("Refuser")}</button><button className="shell-primary" disabled={busy} onClick={() => void answer(true)}>{t("Autoriser")}</button></div>}{error && <p role="alert">{error}</p>}</ObjectPage>}
  </section>;
}
