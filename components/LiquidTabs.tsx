"use client";

/**
 * A Liquid Glass tab bar, in the spirit of Apple's iOS 26 material.
 *
 * What makes it feel like liquid rather than a row of buttons:
 *  - The whole bar is one glass sheet: translucent, blurred, with light
 *    gathering along its top edge and a specular highlight that follows your
 *    pointer (small amplitude, so it reads as sheen, not motion sickness).
 *  - The active pill slides with a spring, and an SVG "gooey" filter makes it
 *    merge into the next tab like two water drops touching as it gets close.
 *  - You can press and drag left or right across the tabs; the pill follows your
 *    finger, stretches slightly as it moves, and settles on the nearest tab when
 *    you let go.
 *
 * Readability comes first: labels are never drawn on top of the moving
 * highlight, the active label sits on a solid tinted pill, and the whole effect
 * degrades to a plain solid bar under Reduce Transparency, Increase Contrast or
 * Reduce Motion.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type LiquidTab<T extends string> = {
  id: T;
  label: string;
  icon?: React.ReactNode;
  /** Optional short label for narrow screens. */
  shortLabel?: string;
};

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
  const btnRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [box, setBox] = useState<{ left: number; width: number } | null>(null);
  const [centers, setCenters] = useState<number[]>([]);
  const [dragX, setDragX] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const activeIndex = Math.max(0, tabs.findIndex((t) => t.id === value));

  // Measure the active tab so the pill can sit exactly over it. Re-measured on
  // resize and when the tabs or selection change, so it never drifts.
  const measure = useCallback(() => {
    const wrap = wrapRef.current;
    const btn = btnRefs.current[activeIndex];
    if (!wrap || !btn) return;
    const w = wrap.getBoundingClientRect();
    const b = btn.getBoundingClientRect();
    if (b.width > 0) setBox({ left: b.left - w.left, width: b.width });
    setCenters(
      btnRefs.current.map((el) => {
        if (!el) return 0;
        const r = el.getBoundingClientRect();
        return r.left - w.left + r.width / 2;
      })
    );
  }, [activeIndex]);

  useEffect(() => {
    measure();
    const t = setTimeout(measure, 60); // after fonts settle
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

  /** Which tab is under a given client x position? */
  const tabAt = (clientX: number): number => {
    let best = activeIndex;
    let bestDist = Infinity;
    btnRefs.current.forEach((b, i) => {
      if (!b) return;
      const r = b.getBoundingClientRect();
      const d = Math.abs(clientX - (r.left + r.width / 2));
      if (d < bestDist) { bestDist = d; best = i; }
    });
    return best;
  };

  // ── Press and drag across the tabs ──────────────────────────
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const wrap = wrapRef.current;
    if (!wrap) return;
    setDragging(true);
    setDragX(e.clientX - wrap.getBoundingClientRect().left);
    try { (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const r = wrap.getBoundingClientRect();
    // Specular highlight follows the pointer whether dragging or just hovering.
    wrap.style.setProperty("--lg-x", `${e.clientX - r.left}px`);
    wrap.style.setProperty("--lg-y", `${e.clientY - r.top}px`);
    wrap.style.setProperty("--lg-glow", "1");
    if (!dragging) return;
    setDragX(e.clientX - r.left);
    // Live preview: as you pull across, the section under your finger becomes active.
    const i = tabAt(e.clientX);
    if (tabs[i] && tabs[i].id !== value) onChange(tabs[i].id);
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragging) {
      const i = tabAt(e.clientX);
      if (tabs[i] && tabs[i].id !== value) onChange(tabs[i].id);
    }
    setDragging(false);
    setDragX(null);
    try { (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  const onPointerLeave = () => {
    wrapRef.current?.style.setProperty("--lg-glow", "0");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = e.key === "ArrowRight"
      ? Math.min(tabs.length - 1, activeIndex + 1)
      : Math.max(0, activeIndex - 1);
    if (tabs[next]) { onChange(tabs[next].id); btnRefs.current[next]?.focus(); }
  };

  // While dragging, the pill follows the finger and stretches a little, the way
  // a drop of water elongates before it settles.
  const pillLeft = dragging && dragX != null && box ? dragX - box.width / 2 : box?.left ?? 0;
  const stretch = dragging ? 1.06 : 1;

  return (
    <div
      ref={wrapRef}
      role="tablist"
      aria-label="Sections"
      tabIndex={-1}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerLeave={onPointerLeave}
      onKeyDown={onKeyDown}
      className={`lg-glass lg-specular relative flex items-center gap-0.5 p-1 rounded-full select-none touch-none ${className}`}
    >
      {/* The gooey layer: the pill plus a small blob under each tab. The SVG
          filter blurs then re-sharpens the alpha, so shapes that come close
          bleed into one another and merge like water drops. */}
      <div className="absolute inset-1 pointer-events-none" style={{ filter: "url(#lg-goo)" }} aria-hidden="true">
        {dragging && dragX != null && centers.map((c, i) => {
          const dist = Math.abs(dragX - c);
          if (dist > 78 || i === activeIndex) return null;
          // Near = a fat drop that touches the pill; far = a small bead. The
          // filter re-sharpens the alpha, so we scale size rather than opacity.
          const size = Math.max(6, 26 - (dist / 78) * 20);
          return (
            <span
              key={tabs[i].id}
              className="absolute rounded-full bg-primary-600"
              style={{ left: c - 4 - size / 2, top: "50%", width: size, height: size, transform: "translateY(-50%)" }}
            />
          );
        })}
        {box && (
          <span
            className={`lg-pill absolute top-0 bottom-0 rounded-full ${dragging ? "lg-dragging" : "lg-spring"}`}
            style={{
              left: 0,
              width: box.width,
              transform: `translateX(${pillLeft}px) scaleX(${stretch})`,
            }}
          />
        )}
      </div>

      {tabs.map((t, i) => {
        const selected = t.id === value;
        return (
          <button
            key={t.id}
            ref={(el) => { btnRefs.current[i] = el; }}
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(t.id)}
            className={`relative z-10 flex items-center gap-1.5 px-3.5 sm:px-4 py-2 rounded-full text-sm font-semibold whitespace-nowrap transition-colors ${
              selected ? "text-white" : "text-text-secondary hover:text-text-primary"
            }`}
          >
            {t.icon}
            <span className="hidden sm:inline">{t.label}</span>
            <span className="sm:hidden">{t.shortLabel ?? t.label}</span>
          </button>
        );
      })}

      {/* The filter itself. Tiny, inert, and shared by the blobs above. */}
      <svg width="0" height="0" aria-hidden="true" className="absolute">
        <defs>
          <filter id="lg-goo">
            <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="blur" />
            <feColorMatrix
              in="blur"
              mode="matrix"
              values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -9"
              result="goo"
            />
            <feBlend in="SourceGraphic" in2="goo" />
          </filter>
        </defs>
      </svg>
    </div>
  );
}
