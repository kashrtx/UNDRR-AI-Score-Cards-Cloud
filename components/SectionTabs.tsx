"use client";

/**
 * The section switcher in the header.
 *
 * A pill slides behind the selected section. You can click a section, use the
 * arrow keys, or press and drag sideways across the bar and let go on the one
 * you want.
 *
 * Three details keep the drag smooth, and they are the reason this is not just
 * a row of buttons with a CSS transition:
 *
 *  1. During a drag the pill is positioned by writing to its style directly, so
 *     React does not re-render on pointer moves.
 *  2. The section changes when you let go, not on every pointer move. Changing
 *     it mid-drag re-rendered the whole page on every event, which stuttered.
 *     A small "preview" state, which only updates when you cross into a new
 *     section, drives the live highlight so it still feels responsive.
 *  3. Tab positions are measured independently of which tab is selected, so
 *     nothing re-measures underneath an in-progress drag.
 *
 * One trap worth remembering: never animate the pill's `transform` with a CSS
 * keyframe. Animations override inline styles, so it would drop the translate
 * that positions the pill and snap it to the left edge.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type SectionTab<T extends string> = {
  id: T;
  label: string;
  icon?: React.ReactNode;
  /** Optional shorter label for narrow screens. */
  shortLabel?: string;
};

type Rect = { left: number; width: number };

/** Resistance past the ends: the further you pull, the less it gives. */
function rubberBand(overshoot: number, limit = 20): number {
  return limit * (1 - 1 / (overshoot / limit + 1));
}

export function SectionTabs<T extends string>({
  tabs,
  value,
  onChange,
  className = "",
}: {
  tabs: SectionTab<T>[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const pillRef = useRef<HTMLSpanElement | null>(null);
  const btnRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const [rects, setRects] = useState<Rect[]>([]);
  const [dragging, setDragging] = useState(false);
  /** Section the finger is over, for the live highlight. */
  const [preview, setPreview] = useState<number | null>(null);

  const activeIndex = Math.max(0, tabs.findIndex((t) => t.id === value));
  const shownIndex = preview ?? activeIndex;

  const rectsRef = useRef<Rect[]>([]);
  const previewRef = useRef<number | null>(null);
  const dragXRef = useRef<number | null>(null);
  useEffect(() => { rectsRef.current = rects; }, [rects]);

  // Measure every tab once, and on resize. Deliberately independent of which
  // tab is selected.
  const measure = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const w = wrap.getBoundingClientRect();
    const next = btnRefs.current.map((el) => {
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

  /** Move the pill without going through React. */
  const paint = useCallback((centerX: number, index: number) => {
    const pill = pillRef.current;
    const rs = rectsRef.current;
    if (!pill || rs.length === 0) return;
    const w = rs[index]?.width ?? rs[0].width;
    pill.style.width = `${w}px`;
    pill.style.transform = `translateX(${centerX - w / 2}px)`;
  }, []);

  // ── Press, drag, release ────────────────────────────────────
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const wrap = wrapRef.current;
    if (!wrap || rectsRef.current.length === 0) return;
    dragXRef.current = e.clientX - wrap.getBoundingClientRect().left;
    setDragging(true);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const wrap = wrapRef.current;
    const rs = rectsRef.current;
    if (!wrap || rs.length === 0) return;
    const raw = e.clientX - wrap.getBoundingClientRect().left;
    const i = nearest(raw);
    const w = rs[i].width;
    const min = rs[0].left + w / 2;
    const max = rs[rs.length - 1].left + rs[rs.length - 1].width - w / 2;
    const x = raw < min ? min - rubberBand(min - raw) : raw > max ? max + rubberBand(raw - max) : raw;
    dragXRef.current = x;
    paint(x, i);
    // The only state change during a drag, and only when crossing a boundary.
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
    if (tabs[target] && tabs[target].id !== value) onChange(tabs[target].id);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = e.key === "ArrowRight"
      ? Math.min(tabs.length - 1, activeIndex + 1)
      : Math.max(0, activeIndex - 1);
    if (tabs[next]) { onChange(tabs[next].id); btnRefs.current[next]?.focus(); }
  };

  // Resting position, rendered by React. While dragging these values come from
  // the same ref paint() uses, so a preview re-render never causes a jump.
  const rest = rects[shownIndex];
  const restX = dragging && dragXRef.current != null && rest
    ? dragXRef.current - rest.width / 2
    : rest?.left ?? 0;

  return (
    <div
      ref={wrapRef}
      role="tablist"
      aria-label="Sections"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      className={`glass-bar relative flex items-center gap-0.5 p-1 rounded-full select-none touch-none overflow-hidden ${className}`}
    >
      {rest && (
        <span
          ref={pillRef}
          aria-hidden="true"
          className={`glass-pill absolute top-1 bottom-1 left-0 rounded-full ${dragging ? "glass-still" : "glass-spring"}`}
          style={{ width: rest.width, transform: `translateX(${restX}px)` }}
        />
      )}

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
            className={`press relative z-10 flex items-center gap-1.5 px-3.5 sm:px-4 py-2 rounded-full text-sm font-semibold whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-0 transition-colors duration-150 ${
              lit ? "text-white" : "text-text-secondary hover:text-text-primary"
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
