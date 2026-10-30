// Fil de discussion construit sur les primitives d'assistant-ui.
import {
  ActionBarPrimitive,
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  type ToolCallMessagePartProps,
  ThreadPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { ArrowDown, ArrowUp, Check, Copy, FileText, Loader2, Paperclip, Square, TriangleAlert, X } from "lucide-react";
import { useContext, useState } from "react";
import remarkGfm from "remark-gfm";
import { AgentContext } from "@/lib/agentContext";
import { mediaUrl, rawFileUrl, send } from "@/lib/api";
import { NoahTile } from "./Noah";
import { Button } from "./ui";
import { canFrame, useViewer } from "./Viewer";
import { DictateButton, VoiceMode, VoiceModeButton } from "./Voice";
import { NoahWidget } from "./Widgets";

export { AgentContext };

// « MEDIA:/chemin.png » ou un chemin d'image de la machine devient une image markdown servie par Noah Agent.
const MEDIA_RE = /(?:MEDIA:\s*)?(\/(?:opt\/data|tmp)\/[^\s"'`)\]]+\.(?:png|jpe?g|gif|webp))/gi;
// Un autre fichier de l'espace de travail devient un lien qui s'ouvre dans la visionneuse.
const FILE_RE = /`?(\/opt\/data\/workspace\/[^\s"'`)\]]+\.[a-z0-9]{1,6})`?/gi;

// Une app, un PDF, un son ou une vidéo se montre en aperçu intégré, même si l'agent n'a donné que le chemin.
const PREVIEW_EXT = /\.(html?|pdf|mp3|wav|ogg|m4a|mp4|webm|mov)$/i;

/** Transforme les chemins hors des blocs de code (les widgets gardent leur JSON intact). */
function linkPaths(text: string, agentId: string) {
  const previewed = new Set(text.match(/"path"\s*:\s*"([^"]+)"/g)?.map((m) => m.replace(/^"path"\s*:\s*"|"$/g, "")) ?? []);
  return text
    .split(/(```[\s\S]*?(?:```|$))/)
    .map((chunk, i) =>
      i % 2
        ? chunk
        : chunk
            .replace(MEDIA_RE, (_m, path: string) => `\n\n![${path.split("/").pop()}](${mediaUrl(agentId, path)})\n\n`)
            .replace(FILE_RE, (m, path: string, offset: number, all: string) => {
              if (all.slice(Math.max(0, offset - 2), offset).includes("](") || all[offset - 1] === "(") return m;
              if (PREVIEW_EXT.test(path) && !previewed.has(path)) {
                previewed.add(path);
                return `\n\n\`\`\`noah\n${JSON.stringify({ type: "preview", path })}\n\`\`\`\n\n`;
              }
              return `[${path.split("/").pop()}](${rawFileUrl(agentId, path)})`;
            }),
    )
    .join("");
}

const widget = { SyntaxHighlighter: NoahWidget, CodeHeader: () => null };
const WIDGET_LANGUAGES = { noah: widget, apollo: widget };

function MarkdownText() {
  const { agentId } = useContext(AgentContext);
  const view = useViewer();
  return (
    <MarkdownTextPrimitive
      className="prose-chat"
      remarkPlugins={[remarkGfm]}
      componentsByLanguage={WIDGET_LANGUAGES}
      preprocess={(text) => linkPaths(text, agentId)}
      components={{
        a: ({ node: _node, href, children, ...props }) =>
          href?.includes("/files/raw/") ? (
            <button
              type="button"
              className="inline-flex cursor-pointer items-center gap-1 rounded-md bg-muted px-1.5 py-px align-baseline text-[0.92em] font-medium text-accent hover:underline"
              onClick={() =>
                canFrame(href) ? view({ kind: "file", url: href, title: String(children) }) : window.open(`${href}?download=1`, "_self")
              }
            >
              <FileText className="size-3.5" />{children}
            </button>
          ) : (
            <a {...props} href={href} target="_blank" rel="noopener noreferrer">{children}</a>
          ),
        img: ({ node: _node, ...props }) => (
          <img
            {...props}
            loading="lazy"
            className="cursor-zoom-in"
            onClick={() => props.src && view({ kind: "image", src: String(props.src), title: props.alt })}
          />
        ),
      }}
    />
  );
}

// --- Parties « outil » : activité, approbation, erreur, détails techniques -------------

/** La ligne de travail : une seule, remplacée à chaque étape, retirée quand l'agent a fini. */
function Activity({ args }: ToolCallMessagePartProps) {
  const label = String(args.label);
  return (
    <div className="flex items-center gap-2 py-0.5 text-[13px] text-muted-foreground" aria-live="polite">
      <Loader2 className="size-3.5 shrink-0 animate-spin text-accent" />
      <span className="truncate">{/[….!?]$/.test(label) ? label : `${label}…`}</span>
    </div>
  );
}

function Approval({ args, result, addResult }: ToolCallMessagePartProps) {
  const { agentId } = useContext(AgentContext);
  const [error, setError] = useState("");
  const answer = async (approve: boolean) => {
    try {
      await send(`/api/agents/${agentId}/runs/${args.run_id}/approval`, {
        request_id: args.request_id,
        generation: args.generation,
        approve,
      });
      addResult(approve ? "approved" : "denied");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="my-2 flex flex-col gap-3 rounded-xl border border-warn bg-warn-soft p-3.5">
      <span className="text-xs font-semibold uppercase tracking-wide text-warn">À valider</span>
      <p className="text-sm whitespace-pre-wrap">{String(args.summary)}</p>
      {result === undefined ? (
        <div className="flex gap-2">
          <Button variant="warn" size="sm" onClick={() => answer(true)}>Autoriser</Button>
          <Button variant="outline" size="sm" onClick={() => answer(false)}>Refuser</Button>
        </div>
      ) : (
        <p className="text-sm font-medium">{result === "approved" ? "Autorisé" : "Refusé"}</p>
      )}
      {error && <p className="text-sm text-danger">La réponse n'a pas été prise en compte : {error}</p>}
    </div>
  );
}

function ErrorPart({ args }: ToolCallMessagePartProps) {
  return (
    <div className="my-1 flex items-start gap-2 rounded-xl bg-warn-soft px-3.5 py-2.5 text-sm">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" />
      <span>{String(args.message)}</span>
    </div>
  );
}

function Detail({ args }: ToolCallMessagePartProps) {
  return (
    <pre className="my-1 max-w-full overflow-x-auto rounded-lg border border-dashed border-border bg-surface px-3 py-2 font-mono text-[11.5px] text-muted-foreground">
      {JSON.stringify(args.data, null, 2)}
    </pre>
  );
}

const TOOLS = { by_name: { activity: Activity, approval: Approval, error: ErrorPart, detail: Detail } };

// --- Messages ------------------------------------------------------------------------

function AttachmentChip() {
  return (
    <AttachmentPrimitive.Root className="flex items-center gap-1.5 rounded-full border border-border bg-surface py-1 pl-2.5 pr-1.5 text-[13px]">
      <FileText className="size-3.5 text-muted-foreground" />
      <span className="max-w-48 truncate"><AttachmentPrimitive.Name /></span>
      <AttachmentPrimitive.Remove asChild>
        <button className="rounded-full p-0.5 text-muted-foreground hover:bg-muted" aria-label="Retirer"><X className="size-3.5" /></button>
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="flex flex-col items-end gap-1.5 py-2">
      <div className="flex flex-wrap justify-end gap-1.5">
        <MessagePrimitive.Attachments components={{ Attachment: AttachmentChip }} />
      </div>
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-surface px-4 py-2.5 whitespace-pre-wrap shadow-sm ring-1 ring-border">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  const { agentColor } = useContext(AgentContext);
  const running = useAuiState((s) => s.message.status?.type === "running");
  const empty = useAuiState((s) => s.message.content.length === 0);
  return (
    <MessagePrimitive.Root className="group relative flex flex-col gap-1 py-2 md:pl-11">
      <NoahTile color={agentColor} className="absolute top-2 left-0 hidden size-8 md:grid" />
      <div className="max-w-[92%] min-w-0">
        {empty && running ? (
          <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin text-accent" /> Réflexion…
          </div>
        ) : (
          <MessagePrimitive.Parts components={{ Text: MarkdownText, tools: TOOLS }} />
        )}
      </div>
      {!running && (
        <ActionBarPrimitive.Root hideWhenRunning autohide="not-last" className="flex gap-1 opacity-70 transition-opacity group-hover:opacity-100">
          <ActionBarPrimitive.Copy asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Copier la réponse">
              <MessagePrimitive.If copied><Check /></MessagePrimitive.If>
              <MessagePrimitive.If copied={false}><Copy /></MessagePrimitive.If>
            </Button>
          </ActionBarPrimitive.Copy>
        </ActionBarPrimitive.Root>
      )}
    </MessagePrimitive.Root>
  );
}

// --- Zone de saisie -----------------------------------------------------------------

function Composer({ onVoiceMode }: { onVoiceMode: () => void }) {
  return (
    <ComposerPrimitive.Root className="flex w-full flex-col gap-2 rounded-2xl border border-border bg-surface p-2 shadow-sm focus-within:border-accent">
      <div className="flex flex-wrap gap-1.5 empty:hidden">
        <ComposerPrimitive.Attachments components={{ Attachment: AttachmentChip }} />
      </div>
      <div className="flex items-end gap-1.5">
        <ComposerPrimitive.AddAttachment asChild multiple>
          <Button variant="ghost" size="icon" aria-label="Joindre des fichiers" className="text-muted-foreground">
            <Paperclip />
          </Button>
        </ComposerPrimitive.AddAttachment>
        <ComposerPrimitive.Input
          rows={1}
          autoFocus
          placeholder="Écris à ton agent… (glisse ou colle des fichiers ici)"
          className="max-h-48 min-h-9 flex-1 resize-none bg-transparent px-1 py-2 text-[15px] outline-none placeholder:text-muted-foreground"
        />
        <DictateButton />
        <VoiceModeButton onClick={onVoiceMode} />
        <ThreadPrimitive.If running={false}>
          <ComposerPrimitive.Send asChild>
            <Button size="icon" aria-label="Envoyer" className="rounded-xl"><ArrowUp /></Button>
          </ComposerPrimitive.Send>
        </ThreadPrimitive.If>
        <ThreadPrimitive.If running>
          <ComposerPrimitive.Cancel asChild>
            <Button size="icon" variant="outline" aria-label="Arrêter" className="rounded-xl"><Square className="fill-current" /></Button>
          </ComposerPrimitive.Cancel>
        </ThreadPrimitive.If>
      </div>
    </ComposerPrimitive.Root>
  );
}

function EmptyNoah() {
  const { agentColor } = useContext(AgentContext);
  return <NoahTile color={agentColor} className="mb-2 size-20" />;
}

export function Thread() {
  const { agentName, hint } = useContext(AgentContext);
  const [voice, setVoice] = useState(false);
  return (
    <ThreadPrimitive.Root className="flex h-full min-h-0 flex-col">
      <ComposerPrimitive.AttachmentDropzone className="flex min-h-0 flex-1 flex-col data-[dragging=true]:bg-accent-soft/40">
        <ThreadPrimitive.Viewport className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4">
          <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col pt-6">
            <ThreadPrimitive.Empty>
              <div className="m-auto flex max-w-md flex-col items-center gap-2 text-center">
                <EmptyNoah />
                <p className="text-xl font-semibold">Que doit faire {agentName} ?</p>
                <p className="text-sm text-muted-foreground">{hint}</p>
              </div>
            </ThreadPrimitive.Empty>
            <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
          </div>
          <ThreadPrimitive.ViewportFooter className="sticky bottom-0 mx-auto flex w-full max-w-3xl flex-col items-center gap-2 bg-gradient-to-t from-background via-background to-transparent pt-4 pb-[max(16px,env(safe-area-inset-bottom))]">
            <ThreadPrimitive.ScrollToBottom asChild>
              <Button variant="outline" size="icon-sm" className="rounded-full disabled:invisible" aria-label="Aller en bas">
                <ArrowDown />
              </Button>
            </ThreadPrimitive.ScrollToBottom>
            {voice ? <VoiceMode onClose={() => setVoice(false)} /> : <Composer onVoiceMode={() => setVoice(true)} />}
          </ThreadPrimitive.ViewportFooter>
        </ThreadPrimitive.Viewport>
      </ComposerPrimitive.AttachmentDropzone>
    </ThreadPrimitive.Root>
  );
}
