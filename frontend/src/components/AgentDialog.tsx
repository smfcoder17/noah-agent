import { useState } from "react";
import { type Agent, del, send } from "@/lib/api";
import { cn } from "@/lib/utils";
import { NOAH_COLORS, NoahTile, agentColor } from "./Noah";
import { Button, Dialog, DialogContent, ErrorText, Input, Label, Textarea } from "./ui";

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
          title={agent ? `Personnaliser ${agent.name}` : "Nouvel agent"}
          description="Chaque agent a sa propre machine, son navigateur, sa mémoire et ses fichiers."
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
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      // Le nom et le rôle redémarrent l'agent ; la couleur seule non.
      let id = agent?.id;
      if (!agent) id = (await send<{ id: string }>("/api/agents", { name: name.trim(), role: role.trim() })).id;
      else if (name.trim() !== agent.name || role.trim() !== agent.role)
        await send(`/api/agents/${agent.id}`, { name: name.trim(), role: role.trim() }, "PATCH");
      await send(`/api/agents/${id}/look`, { color }, "PATCH");
      onSaved(id!);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!agent) return;
    if (!confirm) return setConfirm(true);
    setBusy(true);
    await del(`/api/agents/${agent.id}`);
    onDeleted();
  };

  return (
    <form onSubmit={save} className="flex flex-col gap-4">
      <div className="flex items-center gap-4">
        <NoahTile color={color} className="size-20" />
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium">Couleur</legend>
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
          <span className="text-xs text-muted-foreground">Forme du visage et détails : dans le panneau de l'agent, section Apparence.</span>
        </fieldset>
      </div>
      <Label>
        Nom
        <Input required maxLength={40} placeholder="Ex. Noah, Dots, Grok Bot" value={name} onChange={(e) => setName(e.target.value)} />
      </Label>
      <Label>
        Rôle et consignes
        <Textarea
          rows={5}
          maxLength={4000}
          placeholder="Ex. Tu tries mes courriels chaque matin et tu me signales seulement ce qui demande une réponse."
          value={role}
          onChange={(e) => setRole(e.target.value)}
        />
      </Label>
      <ErrorText>{error}</ErrorText>
      <div className="flex flex-wrap justify-end gap-2">
        {agent?.droit === "proprietaire" && (
          <Button type="button" variant="danger" className="mr-auto" onClick={remove} disabled={busy}>
            {confirm ? "Confirmer la suppression" : "Supprimer"}
          </Button>
        )}
        <Button type="button" variant="outline" onClick={onCancel}>Annuler</Button>
        <Button type="submit" disabled={busy}>{agent ? "Enregistrer" : "Créer l'agent"}</Button>
      </div>
    </form>
  );
}
