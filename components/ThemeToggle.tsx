"use client";

import { Sun, Moon } from "lucide-react";
import { useTheme } from "@/lib/theme";

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const isDark = theme === "dark";
  return (
    <button
      onClick={toggle}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      className="flex items-center justify-center w-9 h-9 rounded-xl border border-border text-text-secondary hover:text-text-primary hover:border-accent-500/50 transition-all shrink-0"
    >
      {isDark ? <Sun size={17} /> : <Moon size={17} />}
    </button>
  );
}
