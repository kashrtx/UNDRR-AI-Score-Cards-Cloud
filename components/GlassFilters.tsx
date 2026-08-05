"use client";

/**
 * The SVG filters the Liquid Glass material uses, mounted once for the whole
 * app. They have to live in the document (a filter referenced by CSS cannot sit
 * in a shadow root), and the element must not be display:none or browsers skip
 * it, so it is sized to nothing and hidden from assistive tech instead.
 *
 *  - #lg-refract: a gentle turbulence-driven displacement map. Chromium can run
 *    this as a backdrop filter, which bends the content behind a glass pane like
 *    a real lens. Other browsers ignore it and keep the blur build.
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
        {/* Refraction. Low frequency and a small scale keep it looking like
            thick glass rather than water ripples, and avoid the pixelation
            that SVG displacement gets at high scales. */}
        <filter id="lg-refract" x="-20%" y="-20%" width="140%" height="140%" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.008 0.012" numOctaves="2" seed="7" result="noise" />
          <feGaussianBlur in="noise" stdDeviation="1.6" result="softNoise" />
          <feDisplacementMap
            in="SourceGraphic"
            in2="softNoise"
            scale="14"
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>

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
