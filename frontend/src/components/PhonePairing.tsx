// Réglages > Appareils : les appareils connectés au compte (révocables), et un code à usage unique (10 min) pour en
// ajouter un : QR code pour le téléphone, code court à recopier dans l'app de bureau ou l'app mobile.
import qrcode from "qrcode-generator";
import { Globe, Laptop, Loader2, Smartphone, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, del, get, send } from "@/lib/api";
import { appShell } from "@/lib/platform";
import { GrantProof } from "./GrantProof";
import { useProof } from "./Proof";
import { minutes } from "./PairingTime";
import { PushToggle } from "./PushToggle";
import { Button, ErrorText } from "./ui";

type Pairing = { adresse: string; serveur: string; code: string; expire: number };
type Device = { id: string; nom: string; type: string; depuis: string | null; vu: string | null; ip: string; version: string; actuel: boolean };

type Pending = { id: string; appareil: string; type: string; ip: string; age: number; expire: number; autre_reseau: boolean };

const ICONS: Record<string, typeof Globe> = { web: Globe, desktop: Laptop, android: Smartphone, ios: Smartphone };
const KINDS: Record<string, string> = { web: "navigateur", desktop: "app de bureau", android: "Android", ios: "iPhone" };

function since(iso: string | null) {
  return iso ? `relié le ${new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" })}` : "";
}

/** Appareils qui ont saisi le code court : rien n'est accordé tant que l'utilisateur n'a pas vu qui demande. */
function PendingRequests({ refresh, onDone, onUsed }: { refresh: number; onDone: () => void; onUsed: () => void }) {
  const [list, setList] = useState<Pending[]>([]);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [proof, setProof] = useState({ preuve_requise: false, code_requis: false });
  const [password, setPassword] = useState("");
  const [secondCode, setSecondCode] = useState("");
  useEffect(() => {
    get<{ demandes: Pending[]; preuve_requise: boolean; code_requis: boolean }>("/api/pairing/pending").then((r) => {
      setList(r.demandes);
      setProof({ preuve_requise: r.preuve_requise, code_requis: r.code_requis });
      if (r.demandes.length) onUsed();
    }).catch(() => {});
  }, [refresh, onUsed]);
  const proven = !proof.preuve_requise || (password !== "" && (!proof.code_requis || secondCode !== ""));
  const decide = async (p: Pending, decision: "autoriser" | "refuser") => {
    try {
      setError("");
      await send(`/api/pairing/flow/${p.id}/${decision}`, { verification: codes[p.id] ?? "", motdepasse: password, code: secondCode });
      setList((l) => l.filter((x) => x.id !== p.id));
      setPassword("");
      setSecondCode("");
      onDone();
    } catch (e) {
      setSecondCode(""); // un code ne sert qu'une fois : le suivant, s'il faut recommencer
      setError((e as Error).message);
      if (e instanceof ApiError && e.status === 403) setList((l) => l.filter((x) => x.id !== p.id));
    }
  };
  if (!list.length) return null;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-warn bg-warn-soft p-3">
      <p className="text-sm font-semibold">Un appareil a utilisé ton code</p>
      <p className="text-xs text-muted-foreground">Il n'a encore accès à rien. Si c'est ton appareil et que tu l'as sous les yeux, recopie le nombre qu'il affiche. Sinon, refuse.</p>
      {proof.preuve_requise && <GrantProof password={password} code={secondCode} needCode={proof.code_requis} onPassword={setPassword} onCode={setSecondCode} />}
      {list.map((p) => {
        const Icon = ICONS[p.type] ?? Globe;
        return (
          <div key={p.id} className="flex flex-wrap items-center gap-2.5">
            <Icon className="size-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{p.appareil || "Appareil"}</p>
              <p className="text-xs text-muted-foreground">{[KINDS[p.type] ?? p.type, p.ip, `demande faite ${minutes(p.age)}`].filter(Boolean).join(" · ")}</p>
              {p.autre_reseau && <p className="text-xs text-warn">Ne vient pas du même réseau que cet écran.</p>}
            </div>
            <input
              inputMode="numeric" autoComplete="off" maxLength={3} placeholder="000" aria-label="Nombre affiché sur l'appareil"
              value={codes[p.id] ?? ""} onChange={(e) => setCodes((c) => ({ ...c, [p.id]: e.target.value.replace(/\D/g, "") }))}
              className="w-14 rounded-lg border border-border bg-background px-2 py-1 text-center font-mono"
            />
            <Button size="sm" onClick={() => decide(p, "autoriser")} disabled={(codes[p.id] ?? "").length !== 3 || !proven}>Autoriser</Button>
            <Button size="sm" variant="ghost" onClick={() => decide(p, "refuser")}>Refuser</Button>
          </div>
        );
      })}
      <p className="text-xs text-muted-foreground">Le nom, c'est l'appareil qui le donne : il ne prouve rien. Sans ton accord, le code ne donne accès à rien.</p>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

function ago(iso: string | null) {
  if (!iso) return "";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 6) return "actif maintenant";
  if (m < 60) return `vu il y a ${m} min`;
  if (m < 1440) return `vu il y a ${Math.round(m / 60)} h`;
  return `vu il y a ${Math.round(m / 1440)} j`;
}

function DeviceList({ refresh }: { refresh: number }) {
  const [list, setList] = useState<Device[] | null>(null);
  const [error, setError] = useState("");
  const { withProof, proofDialog } = useProof();
  const load = useCallback(() => get<{ appareils: Device[] }>("/api/devices").then((r) => setList(r.appareils)).catch((e) => setError((e as Error).message)), []);
  useEffect(() => {
    load();
  }, [load, refresh]);
  const revoke = async (d: Device) => {
    if (!confirm(`Déconnecter « ${d.nom || "cet appareil"} » ? Il devra être relié de nouveau.`)) return;
    try {
      setError("");
      if (await withProof(`/api/devices/${d.id}`, {}, "DELETE")) load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const revokeOthers = async () => {
    if (!confirm("Déconnecter tous les autres appareils ? Chacun devra être relié de nouveau.")) return;
    try {
      setError("");
      if (await withProof("/api/devices/others/revoke")) load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (!list) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs font-semibold text-muted-foreground">Appareils connectés</p>
      {list.map((d) => {
        const Icon = ICONS[d.type] ?? Globe;
        return (
          <div key={d.id} className="flex items-center gap-2.5 rounded-lg border border-border px-3 py-2" data-appareil={d.nom}>
            <Icon className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{d.nom || "Appareil"}{d.actuel && <span className="ml-2 text-xs text-ok">cet appareil</span>}</p>
              <p className="text-xs text-muted-foreground">{[KINDS[d.type] ?? d.type, since(d.depuis), ago(d.vu), d.ip, d.version && `version ${d.version}`].filter(Boolean).join(" · ")}</p>
            </div>
            {!d.actuel && (
              <Button size="sm" variant="ghost" onClick={() => revoke(d)} aria-label="Déconnecter"><Trash2 /></Button>
            )}
          </div>
        );
      })}
      {list.length > 1 && (
        <Button size="sm" variant="ghost" className="self-start text-danger" onClick={revokeOthers}>Déconnecter tous les autres appareils</Button>
      )}
      <ErrorText>{error}</ErrorText>
      {proofDialog}
    </div>
  );
}

export function QR({ text }: { text: string }) {
  const svg = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  }, [text]);
  // Fond blanc même en thème sombre : les appareils photo lisent mal un QR code inversé.
  return <div className="size-56 shrink-0 rounded-xl bg-white p-2 [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function PhonePairing() {
  const [refresh, setRefresh] = useState(0);
  const shell = appShell();
  const forget = () => {
    if (confirm("Oublier ce serveur ? Cette app sera déconnectée et sa session révoquée ; il faudra la relier de nouveau.")) shell?.forget();
  };
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [used, setUsed] = useState(false); // quelqu'un a déjà utilisé ce code : il ne marche plus, on ne le laisse pas à l'écran
  const markUsed = useCallback(() => setUsed(true), []);
  const [left, setLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // G5.1 : jamais de QR code ni d'adresse en http. Sur une IP en http, un téléphone n'a ni installation, ni micro, ni
  // notifications (contexte non sécurisé), et localhost ne mène nulle part depuis un autre appareil.
  const secure = !!pairing?.serveur.startsWith("https://");

  const create = async () => {
    setBusy(true);
    setError("");
    try {
      const p = await send<Pairing>("/api/pairing", {});
      setPairing(p);
      setLeft(p.expire);
      setUsed(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Dans l'app Android, la fenêtre n'a qu'une session courte : elle ne relie pas d'appareil (le serveur le refuse aussi).
  const pairs = shell?.kind !== "android";

  useEffect(() => {
    if (pairs) return () => void del("/api/pairing").catch(() => {});
  }, [pairs]);

  useEffect(() => {
    if (!pairing) return;
    // Le nouvel appareil apparaît dans la liste dès qu'il a servi le code.
    const t = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    const r = setInterval(() => setRefresh((n) => n + 1), 3000);
    return () => {
      clearInterval(t);
      clearInterval(r);
    };
  }, [pairing]);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        {pairs
          ? "Pour relier un téléphone, scanne le QR code avec l'app Noah ou l'appareil photo. Pour l'app de bureau ou un autre appareil, saisis l'adresse et le code court, puis autorise l'appareil ici. Le code sert une seule fois ; le laisser expirer ne déconnecte aucun appareil déjà relié."
          : "Pour relier un autre appareil, ouvre Réglages → Appareils dans un navigateur où tu es connecté."}
      </p>
      {!pairs ? null : pairing && left > 0 && !used ? (
        <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
          {secure && <QR text={pairing.adresse} />}
          <div className="flex min-w-0 flex-col gap-2 text-sm">
            <p>
              Valable encore <b>{Math.floor(left / 60)} min {String(left % 60).padStart(2, "0")} s</b>, pour un seul téléphone.
            </p>
            {secure ? (
              <>
                <p className="text-xs text-muted-foreground">Ou saisis dans l'app :</p>
                <p className="break-all font-mono text-xs">{pairing.serveur}</p>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">Code à saisir dans l'app, avec l'adresse HTTPS de ton Noah :</p>
            )}
            <p className="font-mono text-2xl font-semibold tracking-widest">{pairing.code}</p>
            {!secure && (
              <p className="rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">
                Cette page n'est pas en HTTPS : un téléphone ne peut pas s'en servir. Donne à Noah une adresse HTTPS, avec
                Tailscale (<code>tailscale serve 8080</code>) ou un VPS, ouvre-la ici, puis affiche le code depuis cette
                adresse-là.
              </p>
            )}
            <Button variant="outline" size="sm" className="self-start" onClick={create} disabled={busy}>Nouveau code</Button>
          </div>
        </div>
      ) : (
        <Button className="self-start" onClick={create} disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Smartphone />}
          {used ? "Ce code a servi : en afficher un autre" : pairing ? "Le code a expiré : en afficher un autre" : "Relier un appareil"}
        </Button>
      )}
      <ErrorText>{error}</ErrorText>
      {pairs && <PendingRequests refresh={refresh} onDone={() => setRefresh((n) => n + 1)} onUsed={markUsed} />}
      <PushToggle />
      <DeviceList refresh={refresh} />
      {shell && (
        <Button size="sm" variant="ghost" className="self-start text-danger" onClick={forget}>
          Oublier ce serveur sur cet appareil
        </Button>
      )}
    </div>
  );
}
