"use client";

import { useSyncExternalStore } from "react";
import { Icon } from "./icons";

type Theme = "light" | "dark";

// Mirrors the inline script in the root layout, which resolves the theme before first paint.
export const THEME_STORAGE_KEY = "dvision:theme";

// The stamped attribute is the source of truth; the store exists so the button label follows it.
const listeners = new Set<() => void>();
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function readTheme(): Theme { return document.documentElement.dataset.theme === "dark" ? "dark" : "light"; }
// Rendered on the server before the visitor's choice is known; hydration resolves it to the real value.
function serverTheme(): Theme { return "light"; }

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, readTheme, serverTheme);
  const dark = theme === "dark";
  const toggle = () => {
    const next: Theme = readTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { window.localStorage.setItem(THEME_STORAGE_KEY, next); } catch { /* private browsing keeps the choice for this page only */ }
    listeners.forEach((listener) => listener());
  };
  return (
    <button type="button" className="theme-toggle" onClick={toggle} aria-label={dark ? "Switch to light appearance" : "Switch to dark appearance"} title={dark ? "Light mode" : "Dark mode"}>
      <Icon name={dark ? "sun" : "moon"} size={17} />
    </button>
  );
}
