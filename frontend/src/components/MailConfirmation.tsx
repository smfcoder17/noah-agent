// Réglages > Compte : le code reçu par courriel, facultatif. Chaque compte active son adresse ; le propriétaire règle l'envoi.
// Le mot de passe du serveur de courriel ne revient jamais du serveur (server/noah/courriel.py).
import { Mail } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { t, tr } from "@/i18n";
import { get, send } from "@/lib/api";
import { useProof } from "./Proof";
import { Button, ErrorText, Input, Label } from "./ui";

type Address = { adresse: string; active: boolean; en_attente: string; envoi_regle: boolean };
type Smtp = { regle: boolean; hote: string; port: number; utilisateur: string; expediteur: string; tls: "starttls" | "ssl"; mot_de_passe_enregistre: boolean };

function MyAddress({ state, owner, onChanged }: { state: Address; owner: boolean; onChanged: () => void }) {
  const [changing, setChanging] = useState(false);
  const [adresse, setAdresse] = useState(state.active ? "" : state.adresse);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const { withProof, proofDialog } = useProof();
  const act = async (job: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      if (await job()) {
        setChanging(false);
        setAdresse("");
        setCode("");
        onChanged();
      }
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };
  if (!state.envoi_regle && !state.active)
    return <p className="text-sm text-muted-foreground">{owner ? t("Règle d'abord l'envoi de courriels ci-dessous : ton adresse s'active ensuite ici.") : t("Le propriétaire de ce serveur n'a pas encore réglé l'envoi de courriels. En attendant, rien ne change pour toi.")}</p>;
  return (
    <div className="flex flex-col gap-3">
      {state.active && <p className="text-sm">{tr("Adresse active : {adresse}", { adresse: <b className="break-words">{state.adresse}</b> })}</p>}
      {state.en_attente && (
        <form onSubmit={(e) => { e.preventDefault(); act(() => send("/api/me/courriel/activer", { code })); }} className="flex flex-col gap-2 rounded-xl bg-warn-soft p-3 text-sm">
          <p>{tr("Un code vient de partir vers {adresse}. Saisis-le pour activer cette adresse. Rien ne change tant que ce n'est pas fait.", { adresse: <b className="break-words">{state.en_attente}</b> })}</p>
          <div className="flex flex-wrap items-end gap-2">
            <Label className="w-40">
              {t("Code reçu par courriel")}
              <Input id="mail-activation" required inputMode="numeric" autoComplete="one-time-code" maxLength={16} className="font-mono tracking-widest" value={code} onChange={(e) => setCode(e.target.value)} />
            </Label>
            <Button type="submit" disabled={busy}>{t("Activer")}</Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => act(() => withProof("/api/me/courriel", { adresse: state.en_attente }))}>{t("Renvoyer un code")}</Button>
            {!changing && <Button type="button" variant="ghost" disabled={busy} onClick={() => setChanging(true)}>{t("Autre adresse")}</Button>}
          </div>
        </form>
      )}
      {(changing || (!state.active && !state.en_attente)) && state.envoi_regle && (
        <form onSubmit={(e) => { e.preventDefault(); act(() => withProof("/api/me/courriel", { adresse })); }} className="flex flex-wrap items-end gap-2">
          <Label className="min-w-52 flex-1">
            {state.active ? t("Nouvelle adresse") : t("Ton adresse de courriel")}
            <Input id="mail-address" required type="email" autoComplete="email" maxLength={254} value={adresse} onChange={(e) => setAdresse(e.target.value)} />
          </Label>
          <Button type="submit" variant="outline" disabled={busy}>{t("Envoyer un code à cette adresse")}</Button>
        </form>
      )}
      {state.active && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setChanging(!changing)}>{changing ? t("Annuler") : t("Changer d'adresse")}</Button>
          <Button size="sm" variant="ghost" className="text-danger" disabled={busy} onClick={() => act(() => withProof("/api/me/courriel", {}, "DELETE"))}>{t("Retirer cette adresse")}</Button>
        </div>
      )}
      <ErrorText>{error}</ErrorText>
      {proofDialog}
    </div>
  );
}

/** Le seul endroit de l'interface qui emploie le mot SMTP : c'est le nom que donne l'hébergeur de courriel. */
function SmtpForm({ onChanged }: { onChanged: () => void }) {
  const [form, setForm] = useState<Smtp | null>(null);
  const [password, setPassword] = useState("");
  const [to, setTo] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const { withProof, proofDialog } = useProof();
  useEffect(() => {
    get<Smtp>("/api/courriel/smtp").then(setForm).catch((e) => setMessage({ ok: false, text: (e as Error).message }));
  }, []);
  const attempt = async (job: () => Promise<string | null>) => {
    setBusy(true);
    setMessage(null);
    try {
      const text = await job();
      if (text) setMessage({ ok: true, text });
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    }
    setBusy(false);
  };
  if (!form) return message ? <ErrorText>{message.text}</ErrorText> : null;
  const save = () =>
    attempt(async () => {
      const saved = await withProof<Smtp>("/api/courriel/smtp", { hote: form.hote, port: form.port, utilisateur: form.utilisateur, mot_de_passe: password, expediteur: form.expediteur, tls: form.tls }, "PUT");
      if (!saved) return null;
      setForm(saved);
      setPassword("");
      onChanged();
      return t("Enregistré. Envoie un essai pour vérifier.");
    });
  const trial = () => attempt(async () => t("Essai parti vers {adresse}. Regarde la boîte de réception.", { adresse: (await send<{ vers: string }>("/api/courriel/essai", { adresse: to.trim() })).vers }));
  const remove = () =>
    attempt(async () => {
      const saved = await withProof<Smtp>("/api/courriel/smtp", {}, "DELETE");
      if (!saved) return null;
      setForm(saved);
      onChanged();
      return t("Réglage retiré.");
    });
  const field = (name: "hote" | "utilisateur" | "expediteur", label: string, hint: string) => (
    <Label>
      {label}
      <Input id={`smtp-${name}`} required={name !== "utilisateur"} autoComplete="off" placeholder={hint} value={form[name]} onChange={(e) => setForm({ ...form, [name]: e.target.value })} />
    </Label>
  );
  return (
    <form onSubmit={(e) => { e.preventDefault(); save(); }} className="flex flex-col gap-3 border-t border-border pt-3">
      <div>
        <p className="text-sm font-semibold">{t("Envoi de courriels (SMTP)")}</p>
        <p className="text-xs text-muted-foreground">{t("Le réglage donné par ton hébergeur de courriel. La connexion est toujours chiffrée et le certificat vérifié. Réservé au propriétaire : il sert à tous les profils.")}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {field("hote", t("Serveur"), t("smtp.exemple.com"))}
        <Label>
          {t("Port")}
          <Input id="smtp-port" required type="number" min={1} max={65535} value={form.port} onChange={(e) => setForm({ ...form, port: Number(e.target.value) })} />
        </Label>
        {field("utilisateur", t("Identifiant"), t("noah@exemple.com"))}
        <Label>
          {t("Mot de passe")}
          <Input id="smtp-password" type="password" autoComplete="new-password" placeholder={form.mot_de_passe_enregistre ? t("Enregistré (laisse vide pour le garder)") : t("Aucun")} value={password} onChange={(e) => setPassword(e.target.value)} />
        </Label>
        {field("expediteur", t("Expéditeur"), t("noah@exemple.com"))}
        <Label>
          {t("Chiffrement")}
          <select id="smtp-tls" value={form.tls} onChange={(e) => setForm({ ...form, tls: e.target.value as Smtp["tls"], port: e.target.value === "ssl" ? 465 : 587 })} className="h-10 min-w-0 cursor-pointer rounded-lg border border-border bg-background px-3 text-sm font-normal">
            <option value="starttls">{t("STARTTLS (port 587 le plus souvent)")}</option>
            <option value="ssl">{t("SSL (port 465 le plus souvent)")}</option>
          </select>
        </Label>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="outline" disabled={busy}>{t("Enregistrer")}</Button>
        {form.regle && <Button type="button" variant="ghost" className="text-danger" disabled={busy} onClick={remove}>{t("Retirer ce réglage")}</Button>}
      </div>
      {form.regle && (
        <div className="flex flex-wrap items-end gap-2">
          <Label className="min-w-52 flex-1">
            {t("Adresse de l'essai")}
            <Input id="smtp-trial" type="email" autoComplete="off" placeholder={t("Laisse vide pour ton adresse")} value={to} onChange={(e) => setTo(e.target.value)} />
          </Label>
          <Button type="button" variant="outline" disabled={busy} onClick={trial}><Mail />{t("Envoyer un essai")}</Button>
        </div>
      )}
      {message && <p role="status" className={message.ok ? "text-sm text-ok" : "text-sm text-danger"}>{message.text}</p>}
      {proofDialog}
    </form>
  );
}

export function MailConfirmation({ owner }: { owner: boolean }) {
  const [state, setState] = useState<Address | null>(null);
  const load = useCallback(() => get<Address>("/api/me/courriel").then(setState).catch(() => {}), []);
  useEffect(() => {
    load();
  }, [load]);
  if (!state) return null;
  return (
    <div className="mt-4 flex flex-col gap-3 rounded-2xl border border-border p-4">
      <div className="flex items-start gap-2.5">
        <Mail className={`mt-0.5 size-4 shrink-0 ${state.active ? "text-ok" : "text-muted-foreground"}`} />
        <div className="min-w-0">
          <p className="text-sm font-semibold">{t("Code reçu par courriel")}{state.active && <span className="ml-2 text-xs font-medium text-ok">{t("activé")}</span>}</p>
          <p className="text-xs text-muted-foreground">
            {t("Facultatif. Une fois ton adresse activée, changer ton mot de passe, ajouter ou supprimer un utilisateur, ou déconnecter tous tes autres appareils demande aussi un code reçu sur cette adresse, et chaque nouvel appareil t'y est signalé.")}
          </p>
        </div>
      </div>
      <MyAddress state={state} owner={owner} onChanged={load} />
      {owner && <SmtpForm onChanged={load} />}
    </div>
  );
}
