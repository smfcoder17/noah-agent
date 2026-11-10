import { useCallback, useState } from "react";
import type { NavTab } from "./navPrefs";
import type { PanelTab } from "@/components/SidePanel";
import type { SettingsTab } from "@/components/Settings";

export type Route = { kind: "tab"; tab: NavTab } | { kind: "panel"; tab: PanelTab } | { kind: "settings"; tab: SettingsTab } | { kind: "drawer" | "agent" | "customize" } | { kind: "thread"; id: string };
export type Navigation = { stack: Route[] };
export type NavigationAction = { type: "push" | "reset"; route: Route } | { type: "back" } | { type: "close"; kind: Route["kind"] };
export const initialNavigation: Navigation = { stack: [{ kind: "tab", tab: "chat" }] };
export function navigate(state: Navigation, action: NavigationAction): Navigation {
  if (action.type === "back") return state.stack.length > 1 ? { stack: state.stack.slice(0, -1) } : state;
  if (action.type === "reset") return { stack: [action.route] };
  if (action.type === "close") return { stack: state.stack.filter((r, i) => i === 0 || r.kind !== action.kind) };
  const stack = state.stack.filter((r, i) => i === 0 || r.kind !== action.route.kind);
  return { stack: [...stack, action.route] };
}
export function useNavigation() {
  const [state, set] = useState(initialNavigation);
  const dispatch = useCallback((action: NavigationAction) => set((s) => navigate(s, action)), []);
  return { ...state, dispatch };
}
