"use client";

/**
 * A Liquid Glass tab bar, in the spirit of Apple's iOS 26 material.
 *
 * How it behaves, and why:
 *  - The bar is one glass sheet: it blurs, saturates and (in Chromium) refracts
 *    whatever is behind it, with light gathering along the top edge and a
 *    specular sheen that follows your pointer.
 *  - The active pill is tinted glass rather than paint, so the backdrop still
 *    shows through, while the tint stays dark enough for white text to stay
 *    comfortably legible.
 *  - Press and drag left or right and the pill follows your finger. It stretches
 *    as it moves, and as it approaches the next tab a drop swells and the two
 *    fuse, the way water drops merge when they touch.
 *  - The pill cannot escape the bar. Past either end it rubber-bands with
 *    damping and springs back, which is how Apple's scroll and slider physics
 *    feel.
 *  - Letting go settles the pill with a small squash-and-stretch, so a selection
 *    lands rather than snapping.
 *
 * Reduce Transparency, Increase Contrast and Reduce Motion each simplify this
 * automatically, and it stays fully keyboard and screen-reader operable.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type LiquidTab<T extends string> = {
  id: T;
  label: string;
  icon?: React.ReactNode;
  /** Optional short label for narrow screens. */
  shortLabel?: string;
};

/** Resistance past the ends: the further you pull, the less it gives. */
function rubberBand(overshoot: number, limit = 26): number {
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
  const btnRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [box, setBox] = useState<{ left: number; width: number } | null>(null);
  const [centers, setCenters] = useState<number[]>([]);
  const [inner, setInner] = useState<{ min: number; max: number }>({ min: 0, max: 0 });
  const [dragX, setDragX] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [settling, setSettling] = useState(false);
  const activeIndex = Math.max(0, tabs.findIndex((t) => t.id === value));

  // Measure the active tab (so the pill sits exactly over it), every tab's
  // centre (for the merge and for snapping), and the travel limits (so the pill
  // can never leave the bar). Re-measured on resize and layout changes.
  const measure = useCallback(() => {
    const wrap = wrapRef.current;
    const btn = btnRefs.current[activeIndex];
    if (!wrap || !btn) return;
    const w = wrap.getBoundingClientRect();
    const b = btn.getBoundingClientRect();
    if (b.width <= 0) return;
    setBox({ left: b.left - w.left, width: b.width });
    setCenters(
      btnRefs.current.map((el) => {
        if (!el) return 0;
        const r = el.getBoundingClientRect();
        return r.left - w.left + r.width / 2;
      })
    );
    const first = btnRefs.current[0]?.getBoundingClientRect();
    const last = btnRefs.current[tabs.length - 1]?.getBoundingClientRect();
    if (first && last) {
      setInner({
        min: first.left - w.left + b.width / 2,
        max: last.right - w.left - b.width / 2,
      });
    }
  }, [activeIndex, tabs.length]);

  useEffect(() => {
    measure();
    const t = setTimeout(measure, 60); // once fonts have settled
    window.addEventListener("resize", measure);
    return () => { clearTimeout(t); window.removeEventListener("resize", measure); };
  }, [measure]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || typeof ResizeObserver === "undefined") return;
    const obs = new ResizeObserver(() => measure());
    obs.observe(wrap);
    return () => obs.disconnect();
  }, [measure]);

  /** Nearest tab to a client x position. */
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

  /** Pointer x, in bar coordinates, held inside the bar with rubber-banding. */
  const clampToBar = (clientX: number): number => {
    const wrap = wrapRef.current;
    if (!wrap) return 0;
    const x = clientX - wrap.getBoundingClientRect().left;
    if (x < inner.min) return inner.min - rubberBand(inner.min - x);
    if (x > inner.max) return inner.max + rubberBand(x - inner.max);
    return x;
  };

  const sheen = (clientX: number, clientY: number) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const r = wrap.getBoundingClientRect();
    wrap.style.setProperty("--lg-x", `${clientX - r.left}px`);
    wrap.style.setProperty("--lg-y", `${clientY - r.top}px`);
    wrap.style.setProperty("--lg-glow", "1");
  };

  // ── Press and drag ──────────────────────────────────────────
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    setSettling(false);
    setDragging(true);
    setDragX(clampToBar(e.clientX));
    sheen(e.clientX, e.clientY);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    sheen(e.clientX, e.clientY);
    if (!dragging) return;
    setDragX(clampToBar(e.clientX));
    // Live preview: whichever section is under your finger becomes active.
    const i = tabAt(e.clientX);
    if (tabs[i] && tabs[i].id !== value) onChange(tabs[i].id);
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragging) {
      const i = tabAt(e.clientX);
      if (tabs[i] && tabs[i].id !== value) onChange(tabs[i].id);
      setSettling(true);
      setTimeout(() => setSettling(false), 460);
    }
    setDragging(false);
    setDragX(null);
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
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

  // Pill position. While dragging it centres on the (clamped) finger and
  // stretches slightly; otherwise it rests over the active tab.
  const pillLeft = dragging && dragX != null && box ? dragX - box.width / 2 : box?.left ?? 0;
  const stretch = dragging ? 1.07 : 1;

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
      className={`lg-glass lg-refract lg-specular relative flex items-center gap-0.5 p-1 rounded-full select-none touch-none overflow-hidden ${className}`}
    >
      <span className="lg-sheen" aria-hidden="true" />

      {/* The liquid layer: the pill, plus a drop that swells out of the tab it
          is approaching. The goo filter fuses them as they meet. */}
      <div
        className="absolute inset-1 pointer-events-none"
        style={{ filter: "url(#lg-goo)" }}
        aria-hidden="true"
      >
        {dragging && dragX != null && centers.map((c, i) => {
          const dist = Math.abs(dragX - c);
          if (dist > 84 || i === activeIndex) return null;
          // Close by: a fat drop that touches the pill. Far: a small bead.
          const size = Math.max(7, 30 - (dist / 84) * 23);
          return (
            <span
              key={tabs[i].id}
              className="absolute rounded-full"
              style={{
                left: c - 4 - size / 2,
                top: "50%",
                width: size,
                height: size,
                transform: "translateY(-50%)",
                background: "color-mix(in oklch, var(--color-primary-600) 90%, transparent)",
              }}
            />
          );
        })}
        {box && (
          <span
            className={`lg-pill absolute top-0 bottom-0 rounded-full ${dragging ? "lg-dragging" : "lg-spring"} ${settling ? "lg-settle" : ""}`}
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
            className={`lg-press relative z-10 flex items-center gap-1.5 px-3.5 sm:px-4 py-2 rounded-full text-sm font-semibold whitespace-nowrap transition-colors duration-200 ${
              selected ? "text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.35)]" : "text-text-secondary hover:text-text-primary"
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
