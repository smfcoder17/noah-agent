import { describe, it, expect } from "vitest";
import { ELEMENTS, parseElement, elementName, elementUrl } from "./elements";
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
});
