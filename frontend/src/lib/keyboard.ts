import { useEffect, useState } from "react";
import { inAndroidApp } from "./platform";

export function viewportInset(height: number, viewport: number, offset = 0, scale = 1) {
  return scale !== 1 ? 0 : Math.max(0, height - viewport - offset);
}
/** Android redimensionne la WebView ; le web laisse la place au visualViewport. */
export function useKeyboardInset() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let disposed = false;
    const handles: { remove(): Promise<void> }[] = [];
    const native = inAndroidApp();
    let nativeHeight = 0;
    const update = () => {
      if (disposed) return;
      const v = window.visualViewport;
      const inset = v ? viewportInset(innerHeight, v.height, v.offsetTop, v.scale) : 0;
      const shown = nativeHeight > 0 || inset > 100;
      setOpen(shown);
      const root = document.documentElement;
      root.style.setProperty("--kb", `${native ? 0 : inset > 100 ? inset : 0}px`);
      root.style.setProperty("--visible-height", `${v?.height ?? innerHeight}px`);
      root.dataset.keyboard = shown ? "open" : "closed";
      if (shown) (window.requestAnimationFrame || ((fn: FrameRequestCallback) => window.setTimeout(fn, 0)))(() => {
        const field = document.activeElement;
        if (field instanceof HTMLElement) field.scrollIntoView?.({ block: "nearest" });
        document.querySelectorAll<HTMLElement>("[data-chat-scroll]").forEach((el) => { el.scrollTop = el.scrollHeight; });
      });
    };
    if (native) void import("@capacitor/keyboard").then(async ({ Keyboard }) => {
      for (const [event, value] of [["keyboardDidShow", true], ["keyboardDidHide", false]] as const) {
        const h = await Keyboard.addListener(event as "keyboardDidShow", (info) => { nativeHeight = value ? info.keyboardHeight : 0; update(); });
        if (disposed) await h.remove(); else handles.push(h);
      }
    }).catch(() => {});
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    document.addEventListener("focusin", update);
    update();
    return () => { disposed = true; handles.forEach((h) => void h.remove()); window.visualViewport?.removeEventListener("resize", update); window.visualViewport?.removeEventListener("scroll", update); window.removeEventListener("resize", update); document.removeEventListener("focusin", update); delete document.documentElement.dataset.keyboard; document.documentElement.style.removeProperty("--kb"); };
  }, []);
  return open;
}
