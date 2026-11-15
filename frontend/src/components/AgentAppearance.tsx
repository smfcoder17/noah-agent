// Apparence de l'agent, dans Détails (droit admin) : couleur, forme du visage, détail distinctif, aperçu en direct.
// Enregistré sur le serveur : le même visage sur le web, le bureau et le téléphone.
import { Check } from "lucide-react";
import { useState } from "react";
import { type Agent, send } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Section } from "./AgentPowers";
import { NOAH_COLORS, NoahTile, agentColor } from "./Noah";
import { DetailChoices, ShapeChoices, shapeId } from "./FaceChoices";
import { Button, ErrorText } from "./ui";
import { t } from "@/i18n";

const HEX = /^#[0-9a-fA-F]{6}$/;

export function AgentAppearance({ agent, onChanged }: { agent: Agent; onChanged: () => void }) {
  const saved = { color: agentColor(agent), shape: shapeId(agent.shape), detail: agent.detail || "" };
  const [color, setColor] = useState(saved.color);
  const [shape, setShape] = useState(saved.shape);
  const [detail, setDetail] = useState(saved.detail);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const changed = color !== saved.color || shape !== saved.shape || detail !== saved.detail;
  const touch = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setDone(false);
  };

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      // Seuls les réglages touchés partent : ce qui n'a pas changé reste tel quel.
      const body: Record<string, string> = {};
      if (color !== saved.color) body.color = color;
      if (shape !== saved.shape) body.shape = shape;
      if (detail !== saved.detail) body.detail = detail;
      await send(`/api/agents/${agent.id}/look`, body, "PATCH");
      setDone(true);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={t("Apparence")}>
      <div className="flex flex-col gap-4 rounded-xl bg-muted/60 p-3">
        <div className="flex items-center gap-3">
          <NoahTile color={color} shape={shape} detail={detail} className="size-20" />
          <p className="text-sm text-muted-foreground">{t("Aperçu de {nom}.", { nom: agent.name })}</p>
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-xs font-medium text-muted-foreground">{t("Couleur")}</legend>
          <div className="flex flex-wrap items-center gap-2">
            {NOAH_COLORS.map((c) => (
              <button
                key={c.hex}
                type="button"
                aria-label={c.name}
                aria-pressed={color.toLowerCase() === c.hex}
                title={c.name}
                onClick={() => touch(setColor)(c.hex)}
                className={cn("size-7 cursor-pointer rounded-full ring-offset-2 ring-offset-muted", color.toLowerCase() === c.hex && "ring-2 ring-foreground")}
                style={{ background: c.hex }}
              />
            ))}
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="color"
                aria-label={t("Couleur au choix")}
                value={HEX.test(color) ? color.toLowerCase() : NOAH_COLORS[0].hex}
                onChange={(e) => HEX.test(e.target.value) && touch(setColor)(e.target.value)}
                className="size-7 cursor-pointer rounded-full border-0 bg-transparent p-0"
              />
              {t("Au choix")}
            </label>
          </div>
        </fieldset>

        <ShapeChoices color={color} value={shape} onPick={touch(setShape)} />
        <DetailChoices value={detail} onPick={touch(setDetail)} />

        <ErrorText>{error}</ErrorText>
        <div className="flex items-center justify-end gap-2">
          {done && !changed && (
            <span role="status" className="mr-auto flex items-center gap-1 text-xs text-muted-foreground">
              <Check className="size-3.5" /> {t("Enregistré")}
            </span>
          )}
          {changed && (
            <Button type="button" variant="outline" size="sm" onClick={() => { setColor(saved.color); setShape(saved.shape); setDetail(saved.detail); }} disabled={busy}>
              {t("Annuler")}
            </Button>
          )}
          <Button type="button" size="sm" onClick={save} disabled={busy || !changed}>{t("Enregistrer")}</Button>
        </div>
      </div>
    </Section>
  );
}
