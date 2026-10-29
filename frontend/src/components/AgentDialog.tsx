import { useState } from "react";
import { type Agent, del, send } from "@/lib/api";
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
          title={agent ? `Réglages de ${agent.name}` : "Nouvel agent"}
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
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (agent) {
        await send(`/api/agents/${agent.id}`, { name: name.trim(), role: role.trim() }, "PATCH");
        onSaved(agent.id);
      } else {
        const { id } = await send<{ id: string }>("/api/agents", { name: name.trim(), role: role.trim() });
        onSaved(id);
      }
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
      <Label>
        Nom
        <Input required maxLength={40} placeholder="Ex. Courriel, Recherche" value={name} onChange={(e) => setName(e.target.value)} />
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
        {agent && (
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
