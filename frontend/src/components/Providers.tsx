import { useEffect, useState } from "react";
import { get, send } from "@/lib/api";
import { ProviderLogo, providerLogo } from "./ProviderLogo";
import { Button, ErrorText, Input, Label } from "./ui";
import { t } from "@/i18n";

type Provider = { id: string; label: string; connected: boolean; models: number; base_url: string; needs_key: boolean; own_url: boolean };
function CustomLogo({ id, label }: { id: string; label: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? <span className="provider-letter">{label[0]}</span> : <img className="size-[26px] rounded-[7px]" src={`/api/fournisseurs/${encodeURIComponent(id)}/icone`} alt="" onError={() => setFailed(true)} />;
}
export function Providers() {
  const [list, setList] = useState<Provider[] | null>(null), [selected, select] = useState<Provider | null>(null);
  const [base, setBase] = useState(""), [key, setKey] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const load = () => get<Provider[]>("/api/fournisseurs").then(setList).catch((e) => setError(e.message));
  useEffect(() => { void load(); }, []);
  const open = (p: Provider) => { select(p); setBase(p.base_url); setKey(""); setError(""); };
  const connect = async (e: React.FormEvent) => {
    e.preventDefault(); if (!selected) return;
    setBusy(true); setError("");
    try { await send(`/api/fournisseurs/${selected.id}`, { api_key: key || null, base_url: base || null }, "PUT"); setKey(""); select(null); await load(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <section aria-label={t("Fournisseurs")} className="flex flex-col gap-3">
    {!list && !error && <p role="status">{t("Chargement…")}</p>}
    {selected ? <form className="flex flex-col gap-3" onSubmit={connect}><h3>{selected.label}</h3>{selected.own_url && <Label>{t("Adresse de l'API")}<Input type="url" aria-label={t("Adresse du fournisseur")} value={base} onChange={(e) => setBase(e.target.value)} placeholder={t("https://mon-fournisseur.fr/v1")} /></Label>}<Label>{selected.needs_key ? t("Clé API") : t("Clé API (facultative)")}<Input aria-label={t("Clé API du fournisseur")} type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} /></Label><div className="flex gap-2"><Button type="button" variant="ghost" onClick={() => { select(null); setKey(""); }}>{t("Retour aux fournisseurs")}</Button><Button disabled={busy}>{busy ? t("Connexion…") : t("Brancher")}</Button></div></form>
      : list && <>{[true, false].map((connected) => <div key={String(connected)} className="flex flex-col gap-2"><h3 className="section-label">{connected ? t("Branchés") : t("À brancher")}</h3><div className="shell-group">{list.filter((p) => p.connected === connected && p.id !== "custom").map((p) => <button key={p.id} className="shell-row" onClick={() => open(p)}><ProviderLogo lab={p.id} /><span className="grow"><span className="block">{p.label}</span>{p.connected && <small className="block text-muted-foreground text-[12.5px]">{p.models ? (p.models > 1 ? t("{n} modèles", { n: p.models }) : t("{n} modèle", { n: p.models })) : t("Branché")}</small>}</span><span aria-hidden>›</span></button>)}{connected && !list.some((p) => p.connected && p.id !== "custom") && <p className="shell-row">{t("Aucun fournisseur branché.")}</p>}</div></div>)}{list.filter((p) => p.id === "custom").map((p) => <button key={p.id} className="shell-row shell-group" onClick={() => open(p)}>{p.connected && !providerLogo(p.id) ? <CustomLogo id={p.id} label={p.base_url || p.label} /> : <span aria-hidden>＋</span>}<span><span className="block">{t("Un autre fournisseur")}</span><small className="text-muted-foreground text-[12.5px]">{t("Colle son adresse (compatible OpenAI)")}</small></span></button>)}</>}
    <ErrorText>{error}</ErrorText>{error && !list && <Button onClick={load}>{t("Réessayer")}</Button>}
  </section>;
}
