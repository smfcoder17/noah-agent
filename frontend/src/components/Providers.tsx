import { useEffect, useState } from "react";
import { del, get, send } from "@/lib/api";
import { appShell } from "@/lib/platform";
import { ProviderLogo, providerLogo } from "./ProviderLogo";
import { Button, ErrorText, Input, Label } from "./ui";
import { t } from "@/i18n";

type Provider = { id: string; label: string; connected: boolean; models: number; base_url: string; needs_key: boolean; own_url: boolean;
  /** Abonnement par l'application de bureau (Claude Code, ChatGPT) ; pret : un ordinateur de ce compte le sert en ce moment. */
  ordinateur?: boolean; pret?: boolean | null;
  /** Fournisseur « autre » (nom, adresse et clé à lui) ; en_service : c'est le cerveau, on ne le débranche pas. */
  autre?: boolean; en_service?: boolean };

// Abonnements par l'ordinateur : le lien ouvre l'application de bureau (ou la ramène au premier plan) sur l'écran de cet abonnement.
const ON_COMPUTER: Record<string, { page: string; logo: string }> = {
  "ordinateur:claude-code": { page: "claude", logo: "anthropic" },
  "ordinateur:chatgpt": { page: "chatgpt", logo: "openai" },
};
const DOWNLOAD = "https://github.com/smfcoder17/noah-agent/releases/latest";

/** Le nom à l'écran : dans l'application de bureau, « (ton ordinateur) » ; sur le web et le téléphone, « (ton ordinateur seulement) ». */
function shownLabel(p: Provider, inDesktop: boolean): string {
  if (p.id === "ordinateur:claude-code") return inDesktop ? t("Claude Code (ton ordinateur)") : t("Claude Code (ton ordinateur seulement)");
  if (p.id === "ordinateur:chatgpt") return inDesktop ? t("ChatGPT (ton ordinateur)") : t("ChatGPT (ton ordinateur seulement)");
  return p.label;
}

function CustomLogo({ id, label }: { id: string; label: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? <span className="provider-letter">{label[0]}</span> : <img className="size-[26px] rounded-[7px]" src={`/api/fournisseurs/${encodeURIComponent(id)}/icone`} alt="" onError={() => setFailed(true)} />;
}

/** Choisir un abonnement par l'ordinateur : « Continue sur ton ordinateur », le lien qui ouvre l'app, et « Brancher » quand elle est prête. */
function OnComputer({ p, label, inDesktop, busy, onConnect, onBack }: { p: Provider; label: string; inDesktop: boolean; busy: boolean; onConnect: () => void; onBack: () => void }) {
  const link = `noah-agent://abonnements/${ON_COMPUTER[p.id].page}`;
  return <div role="dialog" aria-label={label} className="flex flex-col gap-3">
    <h3>{label}</h3>
    <p className="text-sm">{t("Les tours de tes agents passent par ton abonnement, sur ton ordinateur, quand Noah Agent y est ouvert. Ordinateur éteint : ton cerveau d'avant répond. Un agent partagé n'y passe jamais.")}</p>
    <p role="status" className="text-sm text-muted-foreground">{p.pret ? t("Ton ordinateur est prêt.") : t("Aucun ordinateur n'est prêt pour l'instant.")}</p>
    {!p.pret && <div className="flex flex-col gap-2 rounded-xl border border-border p-3">
      <strong className="text-sm">{t("Continue sur ton ordinateur")}</strong>
      <p className="text-sm text-muted-foreground">{t("Dans Noah Agent, menu Abonnements : connecte-toi, puis permets-le comme cerveau.")}</p>
      <a className="text-sm text-accent hover:underline" href={link}>{t("Ouvrir Noah Agent sur cet ordinateur")}</a>
      {!inDesktop && <a className="text-sm text-muted-foreground hover:underline" href={DOWNLOAD} target="_blank" rel="noreferrer">{t("Pas encore l'application ? La télécharger")}</a>}
    </div>}
    <div className="flex gap-2"><Button type="button" variant="ghost" onClick={onBack}>{t("Retour aux fournisseurs")}</Button><Button type="button" disabled={busy} onClick={onConnect}>{busy ? t("Connexion…") : t("Brancher")}</Button></div>
  </div>;
}

export function Providers() {
  const [list, setList] = useState<Provider[] | null>(null), [selected, select] = useState<Provider | null>(null);
  const [base, setBase] = useState(""), [key, setKey] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false), [name, setName] = useState("");
  const inDesktop = appShell()?.kind === "desktop";
  const load = () => get<Provider[]>("/api/fournisseurs").then(setList).catch((e) => setError(e.message));
  useEffect(() => { void load(); }, []);
  const open = (p: Provider) => { select(p); setAdding(false); setName(p.autre ? p.label : ""); setBase(p.base_url); setKey(""); setError(""); };
  const addOther = () => { select(null); setAdding(true); setName(""); setBase(""); setKey(""); setError(""); };
  const back = () => { select(null); setAdding(false); setKey(""); setError(""); };
  const plug = async () => {
    if (!selected && !adding) return;
    setBusy(true); setError("");
    try {
      if (adding) await send("/api/fournisseurs", { nom: name, base_url: base, api_key: key || null });
      else if (selected) await send(`/api/fournisseurs/${encodeURIComponent(selected.id)}`, { api_key: selected.ordinateur ? null : key || null, base_url: selected.ordinateur ? null : base || null, ...(selected.autre ? { nom: name } : {}) }, "PUT");
      setKey(""); select(null); setAdding(false); await load();
    }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const unplug = async () => {
    if (!selected) return;
    setBusy(true); setError("");
    try { await del(`/api/fournisseurs/${encodeURIComponent(selected.id)}`); select(null); await load(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const connect = (e: React.FormEvent) => { e.preventDefault(); void plug(); };
  const logo = (p: Provider) => p.autre && !providerLogo(p.id) ? <CustomLogo id={p.id} label={p.label || p.base_url || "?"} /> : <ProviderLogo lab={ON_COMPUTER[p.id]?.logo ?? p.id} />;
  return <section aria-label={t("Fournisseurs")} className="flex flex-col gap-3">
    {!list && !error && <p role="status">{t("Chargement…")}</p>}
    {selected?.ordinateur ? <OnComputer p={selected} label={shownLabel(selected, inDesktop)} inDesktop={inDesktop} busy={busy} onConnect={plug} onBack={() => select(null)} />
      : selected || adding ? <form className="flex flex-col gap-3" onSubmit={connect}><h3>{selected ? selected.label : t("Un autre fournisseur")}</h3>{(adding || selected?.autre) && <Label>{t("Nom")}<Input aria-label={t("Nom du fournisseur")} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("Mon serveur")} /></Label>}{(adding || selected?.own_url) && <Label>{t("Adresse de l'API")}<Input type="url" aria-label={t("Adresse du fournisseur")} value={base} onChange={(e) => setBase(e.target.value)} placeholder={t("https://mon-fournisseur.fr/v1")} /></Label>}<Label>{selected?.needs_key ? t("Clé API") : t("Clé API (facultative)")}<Input aria-label={t("Clé API du fournisseur")} type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} /></Label><div className="flex flex-wrap gap-2"><Button type="button" variant="ghost" onClick={back}>{t("Retour aux fournisseurs")}</Button><Button disabled={busy}>{busy ? t("Connexion…") : t("Brancher")}</Button>{selected?.autre && !selected.en_service && <Button type="button" variant="outline" disabled={busy} onClick={unplug}>{t("Débrancher")}</Button>}</div>{selected?.autre && selected.en_service && <p className="text-sm text-muted-foreground">{t("Ce fournisseur est ton cerveau : choisis-en un autre avant de le débrancher.")}</p>}</form>
      : list && <>{[true, false].map((connected) => <div key={String(connected)} className="flex flex-col gap-2"><h3 className="section-label">{connected ? t("Branchés") : t("À brancher")}</h3><div className="shell-group">{list.filter((p) => p.connected === connected && (connected || !p.autre)).map((p) => <button key={p.id} className="shell-row" onClick={() => open(p)}>{logo(p)}<span className="grow"><span className="block">{shownLabel(p, inDesktop)}</span>{p.connected && <small className="block text-muted-foreground text-[12.5px]">{p.models ? (p.models > 1 ? t("{n} modèles", { n: p.models }) : t("{n} modèle", { n: p.models })) : t("Branché")}</small>}</span><span aria-hidden>›</span></button>)}{connected && !list.some((p) => p.connected) && <p className="shell-row">{t("Aucun fournisseur branché.")}</p>}</div></div>)}<button className="shell-row shell-group" onClick={addOther}><span aria-hidden>＋</span><span><span className="block">{t("Un autre fournisseur")}</span><small className="text-muted-foreground text-[12.5px]">{t("Nom, adresse (compatible OpenAI) et clé : autant que tu veux")}</small></span></button></>}
    <ErrorText>{error}</ErrorText>{error && !list && <Button onClick={load}>{t("Réessayer")}</Button>}
  </section>;
}
