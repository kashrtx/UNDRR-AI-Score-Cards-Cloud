"use client";

/**
 * A Liquid Glass tab bar, in the spirit of Apple's iOS 26 material.
 *
 * The important part of this file is how the drag is wired, because the obvious
 * way to build it stutters badly. Three rules keep it smooth:
 *
 *  1. While you drag, the pill is moved by writing to its style directly. React
 *     does not re-render on pointer moves at all, so the pill tracks your finger
 *     at full frame rate.
 *  2. The selection is committed when you let go, not on every pointer move.
 *     Committing during the drag re-rendered the entire page dozens of times a
 *     second, which was the stutter, and it also fought with the measurements.
 *     A lightweight "preview" state (which changes only when you cross into a
 *     new tab) handles the live highlight, so it still feels live.
 *  3. Tab geometry is measured once and never depends on which tab is active, so
 *     nothing re-measures underneath the drag.
 *
 * Also, deliberately, no keyframe animation ever touches the pill's transform.
 * A CSS animation overrides inline styles, so an animated `transform` wiped out
 * the translate that positions the pill and made it jump to the far left. The
 * squash-and-stretch on release is applied through the same inline transform
 * instead, which composes safely.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type LiquidTab<T extends string> = {
  id: T;
  label: string;
  icon?: React.ReactNode;
  /** Optional short label for narrow screens. */
  shortLabel?: string;
};

type Rect = { left: number; width: number };

/** Resistance past the ends: the further you pull, the less it gives. */
function rubberBand(overshoot: number, limit = 22): number {
  return limit * (1 - 1 / (overshoot / limit + 1));
}

export function LiquidTabs<T extends string>({
  tabs,
  value,
  onChange,
  className = "",
}: {
  tabs: LiquidTab<T>[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const pillRef = useRef<HTMLSpanElement | null>(null);
  const gooRef = useRef<HTMLDivElement | null>(null);
  const btnRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const dropRefs = useRef<Array<HTMLSpanElement | null>>([]);

  const [rects, setRects] = useState<Rect[]>([]);
  const [dragging, setDragging] = useState(false);
  /** Which tab the finger is currently over, for the live label highlight. */
  const [preview, setPreview] = useState<number | null>(null);
  /** Two-step squash after release, done through the inline transform. */
  const [squash, setSquash] = useState(0);

  const activeIndex = Math.max(0, tabs.findIndex((t) => t.id === value));
  const shownIndex = preview ?? activeIndex;
  const rectsRef = useRef<Rect[]>([]);
  const dragXRef = useRef<number | null>(null);
  const previewRef = useRef<number | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { rectsRef.current = rects; }, [rects]);
  useEffect(() => { previewRef.current = preview; }, [preview]);

  // ── Geometry, measured once (and on resize). Note there is no dependency on
  // the active tab: that is what stops the pill re-measuring mid-drag.
  const measure = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const w = wrap.getBoundingClientRect();
    const next: Rect[] = btnRefs.current.map((el) => {
      if (!el) return { left: 0, width: 0 };
      const r = el.getBoundingClientRect();
      return { left: r.left - w.left, width: r.width };
    });
    if (next.some((r) => r.width > 0)) setRects(next);
  }, []);

  useEffect(() => {
    measure();
    const t = setTimeout(measure, 80); // once webfonts have settled
    window.addEventListener("resize", measure);
    return () => { clearTimeout(t); window.removeEventListener("resize", measure); };
  }, [measure, tabs.length]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || typeof ResizeObserver === "undefined") return;
    const obs = new ResizeObserver(() => measure());
    obs.observe(wrap);
    return () => obs.disconnect();
  }, [measure]);

  useEffect(() => () => { if (settleTimer.current) clearTimeout(settleTimer.current); }, []);

  /** Travel limits so the pill always stays fully inside the bar. */
  const limits = (idx: number) => {
    const rs = rectsRef.current;
    if (rs.length === 0) return { min: 0, max: 0 };
    const w = rs[idx]?.width ?? rs[0].width;
    return {
      min: rs[0].left + w / 2,
      max: rs[rs.length - 1].left + rs[rs.length - 1].width - w / 2,
    };
  };

  const nearest = (x: number): number => {
    const rs = rectsRef.current;
    let best = 0;
    let bestDist = Infinity;
    rs.forEach((r, i) => {
      const d = Math.abs(x - (r.left + r.width / 2));
      if (d < bestDist) { bestDist = d; best = i; }
    });
    return best;
  };

  /** Move the pill (and the merge drops) without going through React. */
  const paint = useCallback((centerX: number, index: number) => {
    const pill = pillRef.current;
    const rs = rectsRef.current;
    if (!pill || rs.length === 0) return;
    const w = rs[index]?.width ?? rs[0].width;
    pill.style.width = `${w}px`;
    pill.style.transform = `translateX(${centerX - w / 2}px) scaleX(1.06) scaleY(0.97)`;
    // Drops swell out of whichever tab the pill is approaching, so the two fuse.
    dropRefs.current.forEach((d, i) => {
      if (!d) return;
      const c = rs[i] ? rs[i].left + rs[i].width / 2 : 0;
      const dist = Math.abs(centerX - c);
      const size = dist > 90 || i === index ? 0 : Math.max(8, 30 - (dist / 90) * 22);
      d.style.width = `${size}px`;
      d.style.height = `${size}px`;
      d.style.transform = `translate(${c - size / 2}px, -50%)`;
      d.style.opacity = size > 0 ? "1" : "0";
    });
  }, []);

  const sheen = (clientX: number, clientY: number) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const r = wrap.getBoundingClientRect();
    wrap.style.setProperty("--lg-x", `${clientX - r.left}px`);
    wrap.style.setProperty("--lg-y", `${clientY - r.top}px`);
    wrap.style.setProperty("--lg-glow", "1");
  };

  // ── Press, drag, release ────────────────────────────────────
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const wrap = wrapRef.current;
    if (!wrap || rectsRef.current.length === 0) return;
    if (settleTimer.current) clearTimeout(settleTimer.current);
    const x = e.clientX - wrap.getBoundingClientRect().left;
    dragXRef.current = x;
    setSquash(0);
    setDragging(true);
    if (gooRef.current) gooRef.current.style.filter = "url(#lg-goo)";
    sheen(e.clientX, e.clientY);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    sheen(e.clientX, e.clientY);
    if (!dragging) return;
    const wrap = wrapRef.current;
    if (!wrap) return;
    const raw = e.clientX - wrap.getBoundingClientRect().left;
    const i = nearest(raw);
    const { min, max } = limits(i);
    const x = raw < min ? min - rubberBand(min - raw) : raw > max ? max + rubberBand(raw - max) : raw;
    dragXRef.current = x;
    // Paint straight to the DOM: no React render on pointer moves.
    paint(x, i);
    // The only state change during a drag, and only when you cross a boundary.
    if (previewRef.current !== i) { previewRef.current = i; setPreview(i); }
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (!dragging) return;
    const target = previewRef.current ?? activeIndex;
    dragXRef.current = null;
    previewRef.current = null;
    setPreview(null);
    setDragging(false);
    if (gooRef.current) gooRef.current.style.filter = "none";
    // Squash on landing, then relax. Both go through the inline transform, so
    // they compose with the translate instead of overriding it.
    setSquash(1);
    settleTimer.current = setTimeout(() => setSquash(0), 150);
    if (tabs[target] && tabs[target].id !== value) onChange(tabs[target].id);
  };

  const onPointerLeave = () => wrapRef.current?.style.setProperty("--lg-glow", "0");

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = e.key === "ArrowRight"
      ? Math.min(tabs.length - 1, activeIndex + 1)
      : Math.max(0, activeIndex - 1);
    if (tabs[next]) { onChange(tabs[next].id); btnRefs.current[next]?.focus(); }
  };

  // Resting position, rendered by React. During a drag the inline values below
  // are immediately overwritten by paint(), and because they are computed from
  // the same refs there is no jump when a preview change causes a re-render.
  const rest = rects[shownIndex];
  const restX = dragging && dragXRef.current != null && rest
    ? dragXRef.current - rest.width / 2
    : rest?.left ?? 0;
  const scaleX = dragging ? 1.06 : squash ? 1.07 : 1;
  const scaleY = dragging ? 0.97 : squash ? 0.9 : 1;

  return (
    <div
      ref={wrapRef}
      role="tablist"
      aria-label="Sections"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerLeave={onPointerLeave}
      onKeyDown={onKeyDown}
      className={`lg-glass lg-specular relative flex items-center gap-0.5 p-1 rounded-full select-none touch-none overflow-hidden ${className}`}
    >
      <span className="lg-sheen" aria-hidden="true" />

      {/* The liquid layer. The goo filter is only switched on while dragging, so
          the resting pill stays perfectly crisp. */}
      <div ref={gooRef} className="absolute inset-1 pointer-events-none" style={{ filter: "none" }} aria-hidden="true">
        {tabs.map((t, i) => (
          <span
            key={`drop-${t.id}`}
            ref={(el) => { dropRefs.current[i] = el; }}
            className="absolute top-1/2 left-0 rounded-full opacity-0"
            style={{ width: 0, height: 0, background: "color-mix(in oklch, var(--color-primary-600) 92%, transparent)" }}
          />
        ))}
        {rest && (
          <span
            ref={pillRef}
            className={`lg-pill absolute top-0 bottom-0 left-0 rounded-full ${dragging ? "lg-dragging" : "lg-spring"}`}
            style={{
              width: rest.width,
              transform: `translateX(${restX}px) scaleX(${scaleX}) scaleY(${scaleY})`,
            }}
          />
        )}
      </div>

      {tabs.map((t, i) => {
        const lit = i === shownIndex;
        return (
          <button
            key={t.id}
            ref={(el) => { btnRefs.current[i] = el; }}
            role="tab"
            aria-selected={t.id === value}
            tabIndex={t.id === value ? 0 : -1}
            onClick={() => onChange(t.id)}
            className={`lg-press relative z-10 flex items-center gap-1.5 px-3.5 sm:px-4 py-2 rounded-full text-sm font-semibold whitespace-nowrap transition-colors duration-150 ${
              lit
                ? "text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.35)]"
                : "text-text-secondary hover:text-text-primary"
            }`}
          >
            {t.icon}
            <span className="hidden sm:inline">{t.label}</span>
            <span className="sm:hidden">{t.shortLabel ?? t.label}</span>
          </button>
        );
      })}
    </div>
  );
}
