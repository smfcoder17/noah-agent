import { expect, it } from "vitest";
import { linkTitle } from "./linkTitle";

it("retire du titre le nom du site qu'il répète", () => {
  expect(linkTitle("Kevin Ngo (@kevin_t_ngo) on X", "X (formerly Twitter)", "x.com")).toBe("Kevin Ngo (@kevin_t_ngo)");
  expect(linkTitle('Kevin Ngo on X: "Nouveau tuto" / X', "X (formerly Twitter)", "x.com")).toBe('Kevin Ngo on X: "Nouveau tuto"');
  expect(linkTitle("Rick Astley - Never Gonna Give You Up - YouTube", "YouTube", "www.youtube.com")).toBe("Rick Astley - Never Gonna Give You Up");
  expect(linkTitle("Comment monter une vidéo | YouTube", "YouTube", "youtube.com")).toBe("Comment monter une vidéo");
  expect(linkTitle("La réforme expliquée – Le Monde", "Le Monde", "www.lemonde.fr")).toBe("La réforme expliquée");
  expect(linkTitle("Un fil sur Twitter", "X (formerly Twitter)", "twitter.com")).toBe("Un fil");
  expect(linkTitle("Notes · exemple.org", "exemple.org", "exemple.org")).toBe("Notes");
});

it("garde le titre quand le site n'y est pas, ou quand il n'en resterait rien", () => {
  expect(linkTitle("Xavier Niel parle d'IA", "Le Monde", "lemonde.fr")).toBe("Xavier Niel parle d'IA");
  expect(linkTitle("YouTube", "YouTube", "youtube.com")).toBe("YouTube");
  expect(linkTitle("Le meilleur de X", "X (formerly Twitter)", "x.com")).toBe("Le meilleur de X");
  expect(linkTitle("Guide Ollama", "GitHub", "github.com")).toBe("Guide Ollama");
});
