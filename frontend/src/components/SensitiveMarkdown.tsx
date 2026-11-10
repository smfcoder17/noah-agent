import { useContext, useState, type ComponentProps } from "react";
import type { CodeHeaderProps, MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { SensitiveContext, SensitiveLink, SensitiveText, sensitiveChildren } from "./SensitiveText";

function SensitiveCodeHeader({ code, language }: CodeHeaderProps) {
  const hidden = useContext(SensitiveContext);
  const [error, setError] = useState("");
  return <div className="flex items-center gap-3 text-xs"><SensitiveText text={language || ""} /><button onClick={(e) => {
    const block = e.currentTarget.parentElement?.nextElementSibling;
    if (hidden && block?.querySelector(".sensitive-token:not(.shown)")) { setError("Révèle les données avant de copier."); return; }
    setError(""); void navigator.clipboard?.writeText(code);
  }}>Copier le code</button>{error && <span role="status">{error}</span>}</div>;
}

/** Les feuilles du Markdown passent toutes par le même masquage, même imbriquées. */
export const SENSITIVE_MARKDOWN: NonNullable<ComponentProps<typeof MarkdownTextPrimitive>["components"]> = {
  a: ({ node: _node, ...props }) => <SensitiveLink {...props} />,
  li: ({ children }) => <li>{sensitiveChildren(children)}</li>,
  td: ({ children }) => <td>{sensitiveChildren(children)}</td>,
  th: ({ children }) => <th>{sensitiveChildren(children)}</th>,
  strong: ({ children }) => <strong>{sensitiveChildren(children)}</strong>,
  em: ({ children }) => <em>{sensitiveChildren(children)}</em>,
  h1: ({ children }) => <h1>{sensitiveChildren(children)}</h1>,
  h2: ({ children }) => <h2>{sensitiveChildren(children)}</h2>,
  h3: ({ children }) => <h3>{sensitiveChildren(children)}</h3>,
  h4: ({ children }) => <h4>{sensitiveChildren(children)}</h4>,
  h5: ({ children }) => <h5>{sensitiveChildren(children)}</h5>,
  h6: ({ children }) => <h6>{sensitiveChildren(children)}</h6>,
  blockquote: ({ children }) => <blockquote>{sensitiveChildren(children)}</blockquote>,
  pre: ({ children }) => <pre>{sensitiveChildren(children)}</pre>,
  code: ({ children }) => <code>{sensitiveChildren(children)}</code>,
  SyntaxHighlighter: ({ code, components: { Pre, Code } }) => <Pre><Code><SensitiveText text={code} /></Code></Pre>,
  CodeHeader: SensitiveCodeHeader,
};
