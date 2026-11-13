import { expect, it } from "vitest";
import { normalizeBlock, platformName, postState, wellFormed } from "./blocks";

it("posts : un bilan de posts X devient des cartes avec état, lien et image", () => {
  const block = normalizeBlock({ type: "posts", title: "Posts du jour", items: [
    { platform: "x", account: "@SmfCoder", text: "Nouveau tuto", url: "https://x.com/SmfCoder/status/2120656025690804594", state: "publié", date: "13 nov., 9 h", image: "/opt/data/workspace/outputs/a.jpg" },
    { platform: "X", text: "Second post", state: "échec", note: "X a refusé l'image : trop lourde" },
    { text: "Carrousel", images: ["/opt/data/workspace/outputs/1.jpg", "/opt/data/workspace/outputs/2.jpg", "javascript:alert(1)"], state: "Brouillon" },
  ] });
  expect(block?.type).toBe("posts");
  if (block?.type !== "posts") return;
  expect(block.items).toHaveLength(3);
  expect(block.items[0]).toMatchObject({ platform: "X", state: { label: "Publié", tone: "ok" }, url: "https://x.com/SmfCoder/status/2120656025690804594", image: "/opt/data/workspace/outputs/a.jpg", more: 0 });
  expect(block.items[1].state).toEqual({ label: "Échec", tone: "warn" });
  expect(block.items[2]).toMatchObject({ platform: "Post", image: "/opt/data/workspace/outputs/1.jpg", more: 1, state: { label: "Brouillon", tone: "muted" } });
});

it("post seul (sans items) et plateforme lue dans l'adresse", () => {
  const block = normalizeBlock({ type: "post", text: "Bonjour", url: "https://www.instagram.com/p/abc/" });
  expect(block).toMatchObject({ type: "posts", items: [{ platform: "Instagram", text: "Bonjour" }] });
  expect(platformName(undefined, "https://x.com/a/status/1")).toBe("X");
  expect(postState("programmé pour 18 h")).toEqual({ label: "Prévu", tone: "info" });
  expect(postState("en attente")).toEqual({ label: "en attente", tone: "muted" });
});

it("products : prix, marchand, note ; une adresse non web n'est jamais un lien", () => {
  const block = normalizeBlock({ type: "products", note: "prix relevés le 13 nov.", items: [
    { title: "Casque A", price: "129 €", merchant: "Boutique", rating: "4,6/5", url: "https://boutique.example/a", image: "https://boutique.example/a.jpg" },
    { name: "Casque B", price: 99, url: "javascript:alert(1)" },
    { price: "sans nom" },
  ] });
  expect(block?.type).toBe("products");
  if (block?.type !== "products") return;
  expect(block.items).toHaveLength(2);
  expect(block.items[0]).toMatchObject({ title: "Casque A", price: "129 €", merchant: "Boutique", rating: "4,6/5", url: "https://boutique.example/a" });
  expect(block.items[1]).toMatchObject({ title: "Casque B", price: "99", url: undefined });
});

it("links : titre, site et note ; un lien sans adresse web est écarté", () => {
  const block = normalizeBlock({ type: "links", items: [{ title: "Article", url: "https://www.lemonde.fr/a", note: "les chiffres" }, { url: "https://exemple.org/b" }, { title: "pas de lien" }, { url: "file:///etc/passwd" }] });
  expect(block).toEqual({ type: "links", title: undefined, note: undefined, items: [
    { title: "Article", url: "https://www.lemonde.fr/a", site: "lemonde.fr", note: "les chiffres" },
    { title: "exemple.org", url: "https://exemple.org/b", site: "exemple.org", note: undefined },
  ] });
});

it("un bloc vide ou mal formé ne donne rien à dessiner", () => {
  expect(normalizeBlock({ type: "posts", items: "pas une liste" })).toBeNull();
  expect(normalizeBlock({ type: "products", items: [] })).toBeNull();
  expect(normalizeBlock({ type: "links", items: [{ title: "x" }] })).toBeNull();
  expect(normalizeBlock(null)).toBeNull();
  expect(normalizeBlock({ type: "grid", items: [] })).toBeNull();
  expect(wellFormed({ type: "choice", question: "?", options: "Oui, Non" })).toBe(false);
  expect(wellFormed({ type: "choice", question: "?", options: [] })).toBe(false);
  expect(wellFormed({ type: "choice", question: "?", options: ["Oui", "Non"] })).toBe(true);
  expect(wellFormed({ type: "grid", items: { title: "x" } })).toBe(false);
  expect(wellFormed({ type: "table", columns: ["a"], rows: ["a"] })).toBe(false);
  expect(wellFormed({ type: "chart", labels: ["a"], series: [{ values: "1" }] })).toBe(false);
  expect(wellFormed({ type: "preview" })).toBe(false);
});
