"use client";

import { useEffect, useState } from "react";

export type Theme = "light" | "dark";
const KEY = "undrr.theme";
const EVENT = "undrr-theme-change";

export function getStoredTheme(): Theme {
  if (typeof window === "undefined") return "light";
  try {
    return (localStorage.getItem(KEY) as Theme) || "light";
  } catch {
    return "light";
  }
}

export function applyTheme(t: Theme) {
  const el = document.documentElement;
  if (t === "dark") el.classList.add("dark");
  else el.classList.remove("dark");
}

export function setTheme(t: Theme) {
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* ignore */
  }
  applyTheme(t);
  window.dispatchEvent(new CustomEvent(EVENT, { detail: t }));
}

/** React hook: current theme + a toggler, kept in sync across the app. */
export function useTheme(): { theme: Theme; toggle: () => void; set: (t: Theme) => void } {
  const [theme, setThemeState] = useState<Theme>("light");

  useEffect(() => {
    setThemeState(getStoredTheme());
    const onChange = (e: Event) => setThemeState((e as CustomEvent).detail as Theme);
    window.addEventListener(EVENT, onChange);
    return () => window.removeEventListener(EVENT, onChange);
  }, []);

  return {
    theme,
    set: setTheme,
    toggle: () => setTheme(getStoredTheme() === "dark" ? "light" : "dark"),
  };
}
