/** Pas d'allow-same-origin : même une page créée par Noah ne peut lire la session.
 *  Un PDF ne s'exécute pas (le serveur le remet sans script, voir fichiers_servis.py) et le lecteur de PDF du navigateur refuse de s'ouvrir dans
 *  un cadre en bac à sable : il s'affiche à nu. */
export function SandboxedFrame(props: { src?: string; srcDoc?: string; title: string; className?: string; loading?: "lazy" | "eager"; onError?: () => void }) {
  const pdf = /\.pdf$/i.test((props.src || "").split(/[?#]/, 1)[0]);
  return <iframe {...props} {...(pdf ? {} : { sandbox: "allow-scripts" })} referrerPolicy="no-referrer" loading="lazy" />;
}
