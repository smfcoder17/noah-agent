/** Pas d'allow-same-origin : même une page créée par Noah ne peut lire la session. */
export function SandboxedFrame(props: { src?: string; srcDoc?: string; title: string; className?: string; loading?: "lazy" | "eager"; onError?: () => void }) {
  return <iframe {...props} sandbox="allow-scripts" referrerPolicy="no-referrer" loading="lazy" />;
}
