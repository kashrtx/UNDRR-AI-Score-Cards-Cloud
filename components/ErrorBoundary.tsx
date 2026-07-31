"use client";

/**
 * A last-resort safety net. If any component throws during render, this shows a
 * calm, friendly recovery screen instead of a blank white page, and lets the
 * person reload or clear a corrupt cache, so a single bug never bricks the app.
 */

import React from "react";

type Props = { children: React.ReactNode };
type State = { hasError: boolean; message: string };

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, message: "" };
  }

  static getDerivedStateFromError(error: unknown): State {
    return { hasError: true, message: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: unknown) {
    // Surface it for anyone with the console open; no external logging.
    // eslint-disable-next-line no-console
    console.error("Caught by ErrorBoundary:", error);
  }

  private reload = () => {
    if (typeof window !== "undefined") window.location.reload();
  };

  private clearAndReload = () => {
    try {
      // Clear only this app's cached state, never anything else.
      Object.keys(localStorage)
        .filter((k) => k.startsWith("undrr."))
        .forEach((k) => localStorage.removeItem(k));
    } catch {
      /* ignore */
    }
    this.reload();
  };

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="min-h-screen grid place-items-center bg-surface text-text-primary p-6">
        <div className="max-w-md w-full glass-card p-6 text-center">
          <h1 className="text-lg font-semibold mb-1">Something went wrong on this screen</h1>
          <p className="text-sm text-text-secondary mb-4">
            The app hit an unexpected snag. Your work is saved in your browser, so a reload usually
            fixes it. Nothing was sent anywhere.
          </p>
          <div className="flex flex-col sm:flex-row gap-2 justify-center">
            <button onClick={this.reload} className="px-4 py-2 rounded-xl text-sm font-semibold btn-accent active:scale-95">
              Reload the page
            </button>
            <button onClick={this.clearAndReload} className="px-4 py-2 rounded-xl text-sm font-medium border border-border text-text-secondary hover:text-text-primary">
              Reset the app &amp; reload
            </button>
          </div>
          {this.state.message && (
            <p className="mt-4 text-[11px] text-text-secondary/70 break-words">Details: {this.state.message}</p>
          )}
        </div>
      </div>
    );
  }
}
