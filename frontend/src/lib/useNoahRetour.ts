import { useEffect } from "react";
import type { NavTab } from "./navPrefs";
import type { NavigationAction } from "./navigation";

export function useNoahRetour(depth: number, dispatch: (action: NavigationAction) => void, currentTab: NavTab, goTab: (tab: NavTab) => void) {
  useEffect(() => {
    window.noahRetour = () => {
      if (document.querySelector('[role="dialog"]')) { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true; }
      if (document.querySelector(".video-mini,.audio-bar")) { window.dispatchEvent(new Event("noah:media-close")); return true; }
      if (document.querySelector(".right-panel")) { window.dispatchEvent(new Event("noah:viewer-close")); return true; }
      if (depth > 1) { dispatch({ type: "back" }); return true; }
      if (currentTab !== "chat") { goTab("chat"); return true; }
      return false;
    };
    return () => { delete window.noahRetour; };
  }, [depth, dispatch, currentTab, goTab]);
}
