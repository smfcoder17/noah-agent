// Réglages > Appareils : les appareils connectés au compte (révocables), et un code à usage unique (10 min) pour en
// ajouter un : QR code pour le téléphone, code court à recopier dans l'app de bureau ou l'app mobile.
import qrcode from "qrcode-generator";
import { Globe, Laptop, Loader2, Smartphone, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { del, get, send } from "@/lib/api";
import { desktop } from "@/lib/desktop";
import { Button, ErrorText } from "./ui";

type Pairing = { adresse: string; serveur: string; code: string; expire: number; local: boolean };
type Device = { id: number; nom: string; type: string; depuis: string | null; vu: string | null; ip: string; version: string; actuel: boolean };

const ICONS: Record<string, typeof Globe> = { web: Globe, desktop: Laptop, android: Smartphone, ios: Smartphone };

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
  const load = useCallback(() => get<{ appareils: Device[] }>("/api/devices").then((r) => setList(r.appareils)).catch((e) => setError((e as Error).message)), []);
  useEffect(() => {
    load();
  }, [load, refresh]);
  const revoke = async (d: Device) => {
    if (!confirm(`Déconnecter « ${d.nom || "cet appareil"} » ? Il devra être relié de nouveau.`)) return;
    try {
      await del(`/api/devices/${d.id}`);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const revokeOthers = async () => {
    if (!confirm("Déconnecter tous les autres appareils ? Chacun devra être relié de nouveau.")) return;
    try {
      await send("/api/devices/others/revoke", {});
      load();
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
          <div key={d.id} className="flex items-center gap-2.5 rounded-lg border border-border px-3 py-2">
            <Icon className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{d.nom || "Appareil"}{d.actuel && <span className="ml-2 text-xs text-ok">cet appareil</span>}</p>
              <p className="text-xs text-muted-foreground">{[ago(d.vu), d.ip, d.version && `version ${d.version}`].filter(Boolean).join(" · ")}</p>
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
    </div>
  );
}

function QR({ text }: { text: string }) {
  const svg = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  }, [text]);
  // Fond blanc même en thème sombre : les appareils photo lisent mal un QR code inversé.
  return <div className="size-56 rounded-xl bg-white p-2 [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function PhonePairing() {
  const [refresh, setRefresh] = useState(0);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [left, setLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // App de bureau : l'adresse de l'ordinateur sur le Wi-Fi remplace « localhost » dans le QR code.
  const app = desktop();
  const [lan, setLan] = useState<{ open: boolean; url: string | null } | null>(null);
  useEffect(() => {
    app?.lanStatus().then(setLan).catch(() => {});
  }, [app]);
  const openLan = async () => {
    setBusy(true);
    try {
      setLan(await app!.openLan());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const viaLan = !!(pairing?.local && lan?.open && lan.url);
  const target = pairing && viaLan ? pairing.adresse.replace(/^https?:\/\/[^/]+/, lan!.url!) : pairing?.adresse ?? "";

  const create = async () => {
    setBusy(true);
    setError("");
    try {
      const p = await send<Pairing>("/api/pairing", {});
      setPairing(p);
      setLeft(p.expire);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

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
        Pour relier un téléphone, scanne le QR code avec l'app Noah ou l'appareil photo. Pour l'app de bureau ou un autre
        appareil, saisis l'adresse et le code court. Le code sert une seule fois ; le laisser expirer ne déconnecte aucun
        appareil déjà relié.
      </p>
      {pairing && left > 0 ? (
        <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
          <QR text={target} />
          <div className="flex min-w-0 flex-col gap-2 text-sm">
            <p>
              Valable encore <b>{Math.floor(left / 60)} min {String(left % 60).padStart(2, "0")} s</b>, pour un seul téléphone.
            </p>
            <p className="text-xs text-muted-foreground">Ou saisis dans l'app :</p>
            <p className="break-all font-mono text-xs">{viaLan ? lan!.url : pairing.serveur}</p>
            <p className="font-mono text-2xl font-semibold tracking-widest">{pairing.code}</p>
            {viaLan && <p className="text-xs text-muted-foreground">Ton téléphone doit être sur le même Wi-Fi que cet ordinateur.</p>}
            {pairing.local && app && !lan?.open && (
              <Button size="sm" className="self-start" onClick={openLan} disabled={busy || !lan?.url}>
                Ouvrir Noah à mon Wi-Fi
              </Button>
            )}
            {pairing.local && !viaLan && !app && (
              <p className="rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">
                Cette adresse ne marche que sur cet ordinateur. Pour ton téléphone, ouvre Noah depuis l'adresse de
                l'ordinateur sur ton réseau (avec <code>APOLLO_BIND=0.0.0.0</code> dans <code>.env</code>), ou installe
                Noah sur un VPS avec un domaine, puis affiche le code depuis cette adresse-là.
              </p>
            )}
            <Button variant="outline" size="sm" className="self-start" onClick={create} disabled={busy}>Nouveau code</Button>
          </div>
        </div>
      ) : (
        <Button className="self-start" onClick={create} disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Smartphone />}
          {pairing ? "Le code a expiré : en afficher un autre" : "Relier un appareil"}
        </Button>
      )}
      <ErrorText>{error}</ErrorText>
      <DeviceList refresh={refresh} />
    </div>
  );
}
