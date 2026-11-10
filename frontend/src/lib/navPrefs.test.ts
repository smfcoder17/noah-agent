import { expect, it } from "vitest";
import { DEFAULT_TABS, moveTab, validTabs } from "./navPrefs";
it("garde Discussion, enlève doublons et noms inconnus", () => {
  expect(validTabs(null)).toEqual(DEFAULT_TABS);
  expect(validTabs(["files", "files", "inconnu", "__proto__"])).toEqual(["chat", "files"]);
  expect(moveTab(DEFAULT_TABS, 4, 0)).toEqual(["computer", "chat", "activity", "tasks", "files"]);
  expect(moveTab(DEFAULT_TABS, -1, 0)).toEqual(DEFAULT_TABS);
});
