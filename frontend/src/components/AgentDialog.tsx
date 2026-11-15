import { useState } from "react";
import { type Agent, del, send } from "@/lib/api";
import { forgetPresets, type Preset, usePresets } from "@/lib/presets";
import { cn } from "@/lib/utils";
import { NOAH_COLORS, NoahTile, agentColor } from "./Noah";
import { DetailChoices, ShapeChoices, shapeId } from "./FaceChoices";
import { PresetNote, PresetPicker } from "./PresetPicker";
import { Button, Dialog, DialogContent, ErrorText, Input, Label, Textarea } from "./ui";
import { DictateButton, NO_AGENT, useCanDictate, useFieldDictation } from "./Voice";
import { t } from "@/i18n";

const ROLE_MAX = 4000;

export function AgentDialog({
  open,
  agent,
  onOpenChange,
  onSaved,
  onDeleted,
}: {
  open: boolean;
  agent: Agent | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (id: string) => void;
  onDeleted: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <DialogContent
          title={agent ? t("Personnaliser {nom}", { nom: agent.name }) : t("Nouvel agent")}
          description={t("Chaque agent a sa propre machine, son navigateur, sa mémoire et ses fichiers.")}
        >
          <AgentForm key={agent?.id ?? "new"} agent={agent} onSaved={onSaved} onDeleted={onDeleted} onCancel={() => onOpenChange(false)} />
        </DialogContent>
      )}
    </Dialog>
  );
}

function AgentForm({ agent, onSaved, onDeleted, onCancel }: { agent: Agent | null; onSaved: (id: string) => void; onDeleted: () => void; onCancel: () => void }) {
  const [name, setName] = useState(agent?.name ?? "");
  const [role, setRole] = useState(agent?.role ?? "");
  const [color, setColor] = useState(agent ? agentColor(agent) : NOAH_COLORS[0].hex);
  const [shape, setShape] = useState(shapeId(agent?.shape));
  const [detail, setDetail] = useState(agent?.detail ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [preset, setPreset] = useState<Preset | null>(null);
  const presets = usePresets();
  const canDictate = useCanDictate();
  // Un agent pas encore créé n'a pas d'identifiant : la dictée est celle du compte qui parle.
  const dictation = useFieldDictation(agent?.id ?? NO_AGENT, (text) => setRole((cur) => (cur.trim() ? `${cur.trimEnd()} ${text}` : text).slice(0, ROLE_MAX)));

  // Un modèle pré-remplit le nom, le rôle et le visage (couleur, forme, détail) ; tout reste modifiable avant « Créer ».
  const pick = (p: Preset | null) => {
    setPreset(p);
    setName(p?.nom ?? "");
    setRole(p?.role ?? "");
    setColor(p?.couleur ?? NOAH_COLORS[0].hex);
    setShape(shapeId(p?.shape));
    setDetail(p?.detail ?? "");
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    if (!agent) return create();
    try {
      // Le nom et le rôle redémarrent l'agent ; la couleur seule non.
      if (name.trim() !== agent.name || role.trim() !== agent.role)
        await send(`/api/agents/${agent.id}`, { name: name.trim(), role: role.trim() }, "PATCH");
      await send(`/api/agents/${agent.id}/look`, { color, ...(shape !== shapeId(agent.shape) && { shape }), ...(detail !== (agent.detail ?? "") && { detail }) }, "PATCH");
      onSaved(agent.id);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const create = async () => {
    let id: string;
    try {
      id = (await send<{ id: string }>("/api/agents", { name: name.trim(), role: role.trim(), preset: preset?.id ?? "" })).id;
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
      return;
    }
    forgetPresets(); // l'écran vide du nouvel agent relit son modèle
    // L'agent existe déjà : un échec du visage ne doit pas laisser recliquer « Créer » (un deuxième agent).
    // Le visage du modèle est posé par le serveur : seul ce que la personne a changé après coup repart.
    const base = { color: preset?.couleur ?? "", shape: shapeId(preset?.shape), detail: preset?.detail ?? "" };
    const look = { ...(color !== base.color && { color }), ...(shape !== base.shape && { shape }), ...(detail !== base.detail && { detail }) };
    if (Object.keys(look).length) await send(`/api/agents/${id}/look`, look, "PATCH").catch(() => {});
    onSaved(id);
  };

  const remove = async () => {
    if (!agent) return;
    if (!confirm) return setConfirm(true);
    setBusy(true);
    setError("");
    try {
      await del(`/api/agents/${agent.id}`);
    } catch (err) {
      setError(t("La suppression n'a pas abouti : {erreur}", { erreur: (err as Error).message }));
      setBusy(false);
      setConfirm(false);
      return;
    }
    onDeleted();
  };

  return (
    <form onSubmit={save} className="flex flex-col gap-4">
      {!agent && presets && presets.presets.length > 0 && <PresetPicker presets={presets.presets} value={preset?.id ?? ""} onPick={pick} />}
      <div className="flex items-center gap-4">
        <NoahTile color={color} shape={shape} detail={detail} className="size-20" />
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium">{t("Couleur")}</legend>
          <div className="flex flex-wrap gap-2">
            {NOAH_COLORS.map((c) => (
              <button
                key={c.hex}
                type="button"
                aria-label={c.name}
                aria-pressed={color === c.hex}
                title={c.name}
                onClick={() => setColor(c.hex)}
                className={cn("size-7 cursor-pointer rounded-full ring-offset-2 ring-offset-surface", color === c.hex && "ring-2 ring-foreground")}
                style={{ background: c.hex }}
              />
            ))}
          </div>
        </fieldset>
      </div>
      <ShapeChoices color={color} value={shape} onPick={setShape} />
      <DetailChoices value={detail} onPick={setDetail} />
      <Label>
        {t("Nom")}
        <Input required maxLength={40} placeholder={t("Ex. Léa, Assistant courriels, Veille")} value={name} onChange={(e) => setName(e.target.value)} />
      </Label>
      <div className="relative">
        <Label>
          {t("Rôle et consignes")}
          <Textarea
            rows={5}
            maxLength={ROLE_MAX}
            placeholder={dictation.state === "idle" ? t("Ex. Tu tries mes courriels chaque matin et tu me signales seulement ce qui demande une réponse.") : t("Parle, le texte arrive ici…")}
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className={canDictate ? "pr-12" : undefined}
          />
        </Label>
        {canDictate && (
          <span className="absolute right-1 bottom-1">
            <DictateButton dictation={dictation} what={t("le rôle")} field />
          </span>
        )}
      </div>
      {preset && <PresetNote preset={preset} />}
      <ErrorText>{error}</ErrorText>
      <div className="flex flex-wrap justify-end gap-2">
        {agent?.droit === "proprietaire" && (
          <Button type="button" variant="danger" className="mr-auto" onClick={remove} disabled={busy}>
            {confirm ? t("Confirmer la suppression") : t("Supprimer")}
          </Button>
        )}
        <Button type="button" variant="outline" onClick={onCancel}>{t("Annuler")}</Button>
        {/* Une dictée en cours écrit encore dans le rôle : l'enregistrer maintenant en perdrait la fin. */}
        <Button type="submit" disabled={busy || dictation.state !== "idle"}>{agent ? t("Enregistrer") : t("Créer l'agent")}</Button>
      </div>
    </form>
  );
}
