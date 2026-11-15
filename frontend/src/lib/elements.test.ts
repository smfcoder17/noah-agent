import { describe, it, expect } from "vitest";
import { ELEMENTS, parseElement, elementName, elementUrl, kindOfFile } from "./elements";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { SandboxedFrame } from "../components/elements/SandboxedFrame";
describe("éléments ouvrables", () => {
  it("donne un nom accessible et une origine à chaque format, et un repli aux inconnus", () => {
    for (const kind of Object.keys(ELEMENTS)) {
      const e = parseElement({ type: "element", kind, title: "Rapport" })!;
      expect(elementName(e)).toContain("Rapport"); expect(e.source).toBe("noah");
    }
    expect(parseElement({ type: "element", kind: "binaire", title: "x" })?.kind).toBe("unknown");
    expect(parseElement({ type: "element", title: "" })).toBeNull();
  });
  it("refuse les URL actives et isole les pages de la session", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,x", "//piege", "https://moi:secret@site.fr"]) expect(elementUrl(url)).toBeUndefined();
    const html = renderToStaticMarkup(createElement(SandboxedFrame, { title: "Page", src: "/api/apercu/x" }));
    expect(html).toContain('sandbox="allow-scripts"'); expect(html).not.toContain("allow-same-origin");
  });
  // Capture de Franck : index.html s'ouvrait en code source dans le panneau. Une page web se montre rendue (kind « page »).
  it("une page web ou un SVG s'ouvre en page rendue, un autre fichier texte en code", () => {
    for (const path of ["/opt/data/workspace/apps/catalogue-x/index.html", "rapport.HTM", "outputs/logo.svg", "a.html?v=2"]) expect(kindOfFile(path), path).toBe("page");
    for (const path of ["style.css", "app.js", "notes.md"]) expect(kindOfFile(path), path).toBe("code");
  });
});
