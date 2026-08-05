"use client";

/**
 * The SVG filters the Liquid Glass material uses, mounted once for the whole
 * app. They have to live in the document (a filter referenced by CSS cannot sit
 * in a shadow root), and the element must not be display:none or browsers skip
 * it, so it is sized to nothing and hidden from assistive tech instead.
 *
 *  - #lg-goo: blur, then snap the alpha back to a hard edge. Shapes that come
 *    close bleed into each other and merge, which is what makes the sliding tab
 *    pill behave like a drop of water meeting another one.
 */

export function GlassFilters() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      style={{ position: "absolute", width: 0, height: 0, overflow: "hidden" }}
    >
      <defs>
        {/* Gooey merge for the tab pill and its approaching drop. */}
        <filter id="lg-goo" colorInterpolationFilters="sRGB">
          <feGaussianBlur in="SourceGraphic" stdDeviation="7" result="blur" />
          <feColorMatrix
            in="blur"
            mode="matrix"
            values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 24 -10"
            result="goo"
          />
          <feBlend in="SourceGraphic" in2="goo" />
        </filter>
      </defs>
    </svg>
  );
}
