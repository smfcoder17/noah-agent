import { SensitiveContext, SensitiveLink, sensitiveChildren } from "../SensitiveText";
import { sensitiveParts } from "@/lib/sensitive";
import { SENSITIVE_MARKDOWN } from "../SensitiveMarkdown";
import { LinkCard, LinkList } from "../LinkCard";
import { useAuiState } from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { FileText, Reply } from "lucide-react";
import { Children, useCallback, useContext, useMemo } from "react";
import remarkGfm from "remark-gfm";
import { AgentContext } from "@/lib/agentContext";
import { rawFileUrl } from "@/lib/api";
import { linkMessage } from "@/lib/chatMedia";
import { imageQuote, useQuotes } from "@/lib/quotes";
import { safeMedia } from "@/lib/utils";
import { Button } from "../ui";
import { canFrame, useDownload, useViewer } from "../Viewer";
import { NoahWidget } from "../Widgets";
import { t } from "@/i18n";

const PART_EDGE = "\u0000";

/** Le texte des parties d'un message avant et après celle-ci, en une seule chaîne : une sélection d'état se compare par valeur. */
function partsAround(parts: readonly { type: string; text?: string }[], me: { type: string; text?: string }) {
  const at = parts.findIndex((p) => p === me || (p.type === "text" && p.text === me.text));
  const text = (from: number, to: number) => parts.slice(from, to).map((p) => (p.type === "text" ? p.text ?? "" : "")).join("\n");
  return at < 0 ? text(0, parts.length) + PART_EDGE : text(0, at) + PART_EDGE + text(at + 1, parts.length);
}

const widget = { SyntaxHighlighter: NoahWidget, CodeHeader: () => null };
const WIDGET_LANGUAGES = { noah: widget };
const PLUGINS = [remarkGfm];
const SMOOTH = { drainMs: 100, minCommitMs: 50 };

export function MarkdownText() {
  const hidden = useContext(SensitiveContext);
  const { agentId } = useContext(AgentContext);
  const view = useViewer();
  const download = useDownload();
  const { add: addQuote } = useQuotes();
  // Props stables : sans ça, chaque jeton reçu refait l'analyse Markdown de tous les messages du fil.
  // Une réponse se coupe en parties à chaque outil : la même image ne se montre pas une fois dans chacune. Ces chaînes ne changent
  // pas quand seule la dernière partie grandit : l'analyse des précédentes n'est pas refaite.
  const around = useAuiState((s) => partsAround(s.message.parts, s.part));
  const streaming = useAuiState((s) => s.message.status?.type === "running");
  const preprocess = useCallback(
    (text: string) => {
      const [before, after] = around.split(PART_EDGE);
      return linkMessage(text, { fileUrl: (path) => rawFileUrl(agentId, path), before, after, streaming });
    },
    [agentId, around, streaming],
  );
  const components = useMemo<NonNullable<React.ComponentProps<typeof MarkdownTextPrimitive>["components"]>>(
    () => ({
        p: ({ children }) => { const nodes = Children.toArray(children); const links = nodes.filter((c) => typeof c === "object" && c && "props" in c && (c as React.ReactElement<{ href?: string }>).props.href) as React.ReactElement<{ href?: string }>[]; const urls = links.map((c) => c.props.href!).filter((u) => /^https?:/.test(u)); if (urls.length === 1 && links.length === 1 && nodes.every((c) => typeof c !== "string" || !c.trim())) return <LinkCard url={urls[0]} />; if (urls.length > 1) return <div><span>{sensitiveChildren(children)}</span><LinkList urls={[...new Set(urls)]} /></div>; return <p>{sensitiveChildren(children)}</p>; },
        ...SENSITIVE_MARKDOWN,
        a: ({ node: _node, href, children, ...props }) =>
          href?.includes("/files/raw/") ? (
            <button
              type="button"
              className="inline-flex cursor-pointer items-center gap-1 rounded-md bg-muted px-1.5 py-px align-baseline text-[0.92em] font-medium text-accent hover:underline"
              onClick={() =>
                canFrame(href) ? view({ kind: "file", url: href, title: String(children) }) : download(`${href}?download=1`, String(children))
              }
            >
              <FileText className="size-3.5" />{sensitiveChildren(children)}
            </button>
          ) : (
            <SensitiveLink {...props} href={href} target="_blank" rel="noopener noreferrer">{children}</SensitiveLink>
          ),
        img: ({ node: _node, ...props }) => (
          <span className="group/img relative inline-block">
            <img
              {...props}
              alt={hidden ? sensitiveParts(props.alt || "").map((p) => p.masked).join("") : props.alt}
              title={hidden ? sensitiveParts(props.title || "").map((p) => p.masked).join("") : props.title}
              src={safeMedia(props.src ? String(props.src) : undefined)}
              loading="lazy"
              className="cursor-zoom-in"
              onClick={() => props.src && view({ kind: "image", src: String(props.src), title: props.alt })}
            />
            {props.src && (
              <Button
                variant="outline"
                size="sm"
                className="absolute top-2 right-2 h-7 bg-surface/90 text-xs opacity-0 pointer-coarse:opacity-100 shadow-sm group-hover/img:opacity-100 focus-visible:opacity-100"
                onClick={() => addQuote(imageQuote(String(props.src), props.alt))}
              >
                <Reply />{t("Répondre à ceci")}
              </Button>
            )}
          </span>
        ),
    }),
    [view, download, addQuote, hidden],
  );
  return (
    <MarkdownTextPrimitive
      className="prose-chat"
      remarkPlugins={PLUGINS}
      componentsByLanguage={WIDGET_LANGUAGES}
      preprocess={preprocess}
      components={components}
      // Révélation douce courte : 250 ms par défaut retardait le texte et ré-analysait le Markdown à chaque image.
      smooth={SMOOTH}
    />
  );
}
