// Réglages > Coffre (server/noah/coffre.py) : ce que la personne garde pour ses agents, à elle seule. La liste ne porte aucune
// valeur ; voir une valeur demande la preuve (fenêtre commune, Proof.tsx) et elle s'efface d'elle-même. Un champ de secret laissé
// vide en modification garde l'ancienne valeur : elle n'a jamais à revenir vers l'écran pour être changée. Changer l'adresse ou
// l'identifiant demande la même preuve que voir. Supprimer se confirme dans une fenêtre de l'interface, comme pour les fichiers.
import { CreditCard, Eye, EyeOff, KeyRound, Pencil, ShieldCheck, Trash2, Upload } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { t, tServeur } from "@/i18n";
import { get, request, send } from "@/lib/api";
import { useProof } from "./Proof";
import { Button, Dialog, DialogContent, ErrorText, Input, Label } from "./ui";

export type VaultGenre = "login" | "carte" | "totp" | "cle_api";
export type VaultElement = { id: string; genre: VaultGenre; nom: string; site: string; origine: string; apercu: string; utilise_a: number | null };
type VaultAgent = { id: string; nom: string; utiliser: boolean; partage: boolean };
type ImportResult = { ajoutes: number; remplaces: number; refuses: { ligne: number; raison: string }[] };
type Shown = Record<string, string>;

const SHOWN_SECONDS = 30;
const DEFAULT_HEADER = "Authorization"; // i18n-ignore : un nom d'en-tête HTTP
const API_EXAMPLE = "https://api.openai.com"; // i18n-ignore : une adresse d'exemple
const genres = (): [VaultGenre, string][] => [["login", t("Identifiant")], ["carte", t("Carte de paiement")], ["totp", t("Clé d'authentificateur")], ["cle_api", t("Clé d'API")]];

type WithProof = ReturnType<typeof useProof>["withProof"];

function ItemForm({ genre, element, initial, withProof, onSaved, onCancel }: { genre: VaultGenre; element?: VaultElement; /** Des champs déjà remplis à l'ajout (une clé collée dans une discussion). */ initial?: Record<string, string>; withProof: WithProof; onSaved: () => void; onCancel: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({ nom: element?.nom ?? "", origine: element?.origine ?? "", ...initial });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ids = useId();
  const editing = !!element;
  const keep = editing ? t("Inchangé si vide") : undefined;
  const field = (name: string, label: string, props: React.ComponentProps<"input"> = {}) => (
    <Label htmlFor={`${ids}-${name}`}>
      {label}
      <Input id={`${ids}-${name}`} value={values[name] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))} {...props} />
    </Label>
  );
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    // Seuls les champs remplis partent : vides, ils gardent l'ancienne valeur côté serveur.
    const body: Record<string, string> = { genre };
    for (const [k, v] of Object.entries(values)) if (v !== "" || k === "nom") body[k] = v;
    try {
      // Une modification de l'adresse ou de l'identifiant répond 428 : la fenêtre de preuve s'ouvre, et la même requête repart.
      if (editing) {
        if (!(await withProof(`/api/coffre/${element.id}`, body, "PUT"))) return;
      } else await send("/api/coffre", body, "POST");
      setValues({});
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} autoComplete="off" className="flex flex-col gap-2.5 rounded-xl border border-border p-3">
      {field("nom", t("Nom (facultatif)"), { maxLength: 60 })}
      {genre !== "carte" && field("origine", genre === "cle_api" ? t("Adresse de base de l'API") : t("Adresse du site"), { placeholder: keep ?? (genre === "cle_api" ? API_EXAMPLE : undefined), required: !editing, inputMode: "url", autoCapitalize: "none", spellCheck: false })}
      {genre === "login" && (
        <>
          {field("identifiant", t("Identifiant"), { maxLength: 320, required: !editing, autoCapitalize: "none", spellCheck: false, placeholder: keep, autoComplete: "off" })}
          {field("mot_de_passe", t("Mot de passe"), { type: "password", maxLength: 1024, required: !editing, placeholder: keep, autoComplete: "new-password" })}
        </>
      )}
      {genre === "carte" && (
        <>
          {field("numero", t("Numéro de la carte"), { inputMode: "numeric", maxLength: 23, required: !editing, placeholder: keep, autoComplete: "off" })}
          {field("expiration", t("Expiration (MM/AA)"), { maxLength: 7, required: !editing, autoComplete: "off" })}
          {field("titulaire", t("Titulaire"), { maxLength: 120, autoComplete: "off" })}
          <p className="text-xs text-muted-foreground">{t("Le code de sécurité n'est jamais gardé : tu le tapes toi-même à chaque paiement.")}</p>
        </>
      )}
      {genre === "cle_api" && (
        <>
          {field("entete", t("En-tête d'envoi"), { maxLength: 64, placeholder: keep ?? DEFAULT_HEADER, autoCapitalize: "none", spellCheck: false, autoComplete: "off" })}
          {field("cle", t("Clé d'API"), { type: "password", maxLength: 4096, required: !editing, placeholder: keep, autoComplete: "new-password" })}
          <p className="text-xs text-muted-foreground">{t("Authorization: Bearer <clé> par défaut. Pour un autre en-tête, écris son nom (ex. x-api-key).")} {t("Tes agents demandent à Noah d'appeler ce service avec la clé : ils ne la lisent jamais, et Noah n'envoie rien ailleurs que sur cette adresse.")}</p>
        </>
      )}
      {genre === "totp" && field("cle", t("Clé de configuration, ou adresse otpauth://"), { required: !editing, placeholder: keep, autoCapitalize: "characters", spellCheck: false, autoComplete: "off" })}
      <ErrorText>{error}</ErrorText>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy}>{editing ? t("Enregistrer") : t("Ajouter")}</Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>{t("Annuler")}</Button>
      </div>
    </form>
  );
}

function ShownValues({ genre, shown }: { genre: VaultGenre; shown: Shown }) {
  const rows: [string, string | undefined][] = genre === "login" ? [[t("Identifiant"), shown.identifiant], [t("Mot de passe"), shown.mot_de_passe]]
    : genre === "carte" ? [[t("Numéro de la carte"), shown.numero], [t("Expiration (MM/AA)"), shown.expiration], [t("Titulaire"), shown.titulaire]]
    : genre === "cle_api" ? [[t("Clé d'API"), shown.cle], [t("En-tête"), shown.entete || DEFAULT_HEADER]]
    : [[t("Code du moment"), shown.code], [t("Clé de configuration, ou adresse otpauth://"), shown.cle]];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg bg-muted/40 p-2 text-xs">
      {rows.filter(([, v]) => v).map(([label, value]) => (
        <div key={label} className="contents"><dt className="text-muted-foreground">{label}</dt><dd className="select-all break-all font-mono">{value}</dd></div>
      ))}
    </dl>
  );
}

/** FileReader plutôt que File.text() : présent partout, vieux WebView Android compris. */
function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

function VaultImport({ onDone }: { onDone: () => void }) {
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      setResult(await send<ImportResult>("/api/coffre/import", { csv: await readText(file) }));
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = ""; // le fichier ne reste pas dans le formulaire
    }
  };
  return (
    <div className="flex flex-col gap-1.5">
      <input ref={input} type="file" accept=".csv,text/csv" className="hidden" aria-label={t("Fichier CSV d'un gestionnaire de mots de passe")} onChange={(e) => pick(e.target.files?.[0])} />
      <Button variant="outline" size="sm" className="self-start" disabled={busy} onClick={() => input.current?.click()}><Upload />{t("Importer un fichier CSV")}</Button>
      <p className="text-xs text-muted-foreground">{t("Export de Chrome, Firefox, Bitwarden, 1Password… Supprime ce fichier ensuite : les mots de passe y sont en clair.")}</p>
      {result && (
        <div role="status" className="flex flex-col gap-1 text-sm">
          <span>{t("{ajoutes} ajoutés, {remplaces} mis à jour, {refuses} refusés", { ajoutes: result.ajoutes, remplaces: result.remplaces, refuses: result.refuses.length })}</span>
          {result.refuses.length > 0 && (
            <ul className="flex flex-col gap-0.5 text-xs text-danger">
              {result.refuses.map((r) => <li key={r.ligne}>{t("Ligne {ligne} : {raison}", { ligne: r.ligne, raison: tServeur(r.raison) })}</li>)}
            </ul>
          )}
        </div>
      )}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

/** L'ajout d'une clé d'API au coffre dans une fenêtre, champs déjà remplis : la carte « Ranger au coffre » d'une clé collée dans une discussion (X17).
 *  La valeur ne passe que par ce formulaire et la même route que le reste du coffre : nulle part ailleurs. */
export function VaultAddDialog({ initial, description, onClose, onSaved }: { initial: Record<string, string>; description: string; onClose: () => void; onSaved: () => void }) {
  const { withProof, proofDialog } = useProof();
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={t("Ranger cette clé au coffre")} description={description}>
        <ItemForm genre="cle_api" initial={initial} withProof={withProof} onCancel={onClose} onSaved={() => { onSaved(); onClose(); }} />
        {proofDialog}
      </DialogContent>
    </Dialog>
  );
}

export function Vault() {
  const [elements, setElements] = useState<VaultElement[] | null>(null);
  const [agents, setAgents] = useState<VaultAgent[]>([]);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState<VaultGenre | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [shown, setShown] = useState<Record<string, Shown>>({});
  const [removing, setRemoving] = useState<VaultElement | null>(null);
  const [busy, setBusy] = useState(false);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const { withProof, proofDialog } = useProof();
  const load = useCallback(() => get<{ elements: VaultElement[]; agents: VaultAgent[] }>("/api/coffre")
    .then((d) => { setElements(d.elements); setAgents(d.agents); })
    .catch((e) => setError((e as Error).message)), []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => Object.values(timers.current).forEach(clearTimeout), []);

  const hide = (id: string) => setShown((s) => { const rest = { ...s }; delete rest[id]; return rest; });
  const reveal = async (el: VaultElement) => {
    setError("");
    try {
      const values = await withProof<Shown>(`/api/coffre/${el.id}/voir`, {});
      if (!values) return;
      setShown((s) => ({ ...s, [el.id]: values }));
      clearTimeout(timers.current[el.id]);
      timers.current[el.id] = setTimeout(() => hide(el.id), SHOWN_SECONDS * 1000);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const remove = async (el: VaultElement) => {
    setError("");
    setBusy(true);
    try {
      await request(`/api/coffre/${el.id}`, { method: "DELETE" });
      hide(el.id);
      setRemoving(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
      setRemoving(null);
    } finally {
      setBusy(false);
    }
  };
  const toggle = async (agent: VaultAgent) => {
    setError("");
    try {
      await send(`/api/agents/${agent.id}/coffre-droit`, { utiliser: !agent.utiliser }, "PUT");
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const icon = (genre: VaultGenre) => genre === "carte" ? <CreditCard className="size-4 shrink-0 text-muted-foreground" />
    : genre === "totp" ? <ShieldCheck className="size-4 shrink-0 text-muted-foreground" /> : <KeyRound className="size-4 shrink-0 text-muted-foreground" />;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">{t("Tes identifiants, cartes, clés d'authentificateur et clés d'API, chiffrés sur ton serveur. Tes agents s'en servent sans jamais voir une valeur : Noah remplit la page, ou appelle l'API, lui-même.")}</p>
      {elements === null && !error && <p className="text-sm text-muted-foreground">{t("Chargement…")}</p>}
      {elements && elements.length === 0 && <p className="text-sm">{t("Ton coffre est vide.")}</p>}
      {elements && elements.length > 0 && (
        <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border">
          {elements.map((el) => (
            <li key={el.id} className="flex flex-col gap-2 p-2.5">
              <div className="flex items-center gap-2.5">
                {icon(el.genre)}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium" title={el.origine}>{el.nom || el.site}</span>
                  <span className="block truncate text-xs text-muted-foreground">{[genres().find(([g]) => g === el.genre)?.[1], el.apercu].filter(Boolean).join(" · ")}</span>
                </span>
                {shown[el.id]
                  ? <Button variant="ghost" size="sm" onClick={() => hide(el.id)} aria-label={t("Cacher {nom}", { nom: el.nom || el.site })}><EyeOff />{t("Cacher")}</Button>
                  : <Button variant="ghost" size="sm" onClick={() => reveal(el)} aria-label={t("Voir {nom}", { nom: el.nom || el.site })}><Eye />{t("Voir")}</Button>}
                <Button variant="ghost" size="sm" onClick={() => setEditing(editing === el.id ? null : el.id)} aria-label={t("Modifier {nom}", { nom: el.nom || el.site })}><Pencil /></Button>
                <Button variant="ghost" size="sm" onClick={() => setRemoving(el)} aria-label={t("Supprimer {nom}", { nom: el.nom || el.site })}><Trash2 /></Button>
              </div>
              {shown[el.id] && <ShownValues genre={el.genre} shown={shown[el.id]} />}
              {editing === el.id && <ItemForm genre={el.genre} element={el} withProof={withProof} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <ItemForm key={adding} genre={adding} withProof={withProof} onCancel={() => setAdding(null)} onSaved={() => { setAdding(null); void load(); }} />
      ) : (
        <div className="flex flex-wrap gap-2">
          {genres().map(([genre, label]) => <Button key={genre} variant="outline" size="sm" onClick={() => setAdding(genre)}>{icon(genre)}{t("Ajouter : {genre}", { genre: label })}</Button>)}
        </div>
      )}
      <VaultImport onDone={() => void load()} />
      {agents.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="text-sm font-medium">{t("Agents qui utilisent ton coffre")}</p>
          <ul className="flex flex-col gap-1">
            {agents.map((agent) => (
              <li key={agent.id} className="flex min-h-11 items-center gap-2 text-sm">
                <input id={`coffre-${agent.id}`} type="checkbox" className="size-4 accent-accent" checked={agent.utiliser} onChange={() => toggle(agent)} />
                <label htmlFor={`coffre-${agent.id}`} className="min-w-0 flex-1 truncate py-3">{agent.nom}</label>
                {agent.partage && <span className="text-xs text-muted-foreground">{t("partagé : éteint d'office")}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <ErrorText>{error}</ErrorText>
      <Dialog open={!!removing} onOpenChange={(o) => !o && !busy && setRemoving(null)}>
        {removing && (
          <DialogContent title={t("Supprimer {nom} du coffre ?", { nom: removing.nom || removing.site })} description={t("Tes agents ne pourront plus s'en servir.")}>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setRemoving(null)} disabled={busy}>{t("Annuler")}</Button>
              <Button variant="warn" onClick={() => remove(removing)} disabled={busy}><Trash2 />{t("Supprimer")}</Button>
            </div>
          </DialogContent>
        )}
      </Dialog>
      {proofDialog}
    </div>
  );
}
