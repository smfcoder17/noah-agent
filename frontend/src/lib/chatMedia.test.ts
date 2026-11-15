import { describe, expect, it } from "vitest";
import { linkMessage } from "./chatMedia";

const fileUrl = (path: string) => `/api/agents/a/files/raw/${path.replace(/^\/opt\/data\/workspace\//, "")}`;
const widgets = (out: string) => [...out.matchAll(/```noah\n(.*?)\n```/g)].map((m) => JSON.parse(m[1]) as Record<string, unknown>);
const prose = (out: string) => out.replace(/```noah\n.*?\n```/g, "");

// Capture de Franck : l'agent a écrit l'objet du bloc sans sa clôture ```noah. Le chemin devenait une carte au milieu du JSON,
// affiché en texte : « {"type":"preview","title":"…","path":" », la carte index.html, puis « "} ».
describe("bloc d'aperçu écrit sans sa clôture", () => {
  const PATH = "/opt/data/workspace/apps/catalogue-x/index.html";
  const BARE = `{"type":"preview","title":"Catalogue X — 48 posts à fortes réponses","path":"${PATH}"}`;

  it("devient un seul aperçu, avec son titre, sans JSON en texte", () => {
    const out = linkMessage(`Voici le catalogue.\n\n${BARE}\n\nDis-moi ce que tu en penses.`, { fileUrl });
    expect(widgets(out)).toEqual([{ type: "preview", title: "Catalogue X — 48 posts à fortes réponses", path: PATH }]);
    expect(prose(out)).not.toContain('{"type"');
    expect(prose(out)).not.toContain('"}');
    expect(prose(out)).toContain("Voici le catalogue.");
    expect(prose(out)).toContain("Dis-moi ce que tu en penses.");
  });

  it("vaut aussi avec des espaces, comme l'exemple du prompt, et pour les autres blocs", () => {
    const out = linkMessage(`{"type": "preview", "title": "Ventes", "path": "${PATH}"}\n{"type": "choice", "question": "Je le publie ?", "options": ["Oui", "Non"]}`, { fileUrl });
    expect(widgets(out).map((w) => w.type)).toEqual(["preview", "choice"]);
    expect(widgets(out)[0].title).toBe("Ventes");
  });

  it("le bloc clôturé reste tel quel, et un JSON ordinaire reste du texte", () => {
    const fenced = linkMessage(`\`\`\`noah\n${BARE}\n\`\`\``, { fileUrl });
    expect(fenced).toBe(`\`\`\`noah\n${BARE}\n\`\`\``);
    const plain = linkMessage('{"nom": "Léa", "age": 31}', { fileUrl });
    expect(plain).toBe('{"nom": "Léa", "age": 31}');
    const inCode = linkMessage(`\`\`\`json\n${BARE}\n\`\`\``, { fileUrl });
    expect(inCode).toBe(`\`\`\`json\n${BARE}\n\`\`\``);
  });

  it("pendant l'écriture, l'objet pas encore fini ne s'affiche pas", () => {
    const out = linkMessage(`Voici le catalogue.\n{"type":"preview","title":"Catalogue X","path":"${PATH}`, { fileUrl, streaming: true });
    expect(out).not.toContain('{"type"');
    expect(widgets(out)).toEqual([]);
  });
});
