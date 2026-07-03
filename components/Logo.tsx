/**
 * Logo — an original resilience mark (rounded shield + a "resilience pulse"
 * line + an AI badge). Deliberately NOT the official UNDRR emblem; it's a
 * custom wordmark-style icon for this tool.
 */
export function Logo({ size = 34 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="UNDRR ARISE AI"
    >
      <defs>
        <linearGradient id="undrrai-bg" x1="6" y1="4" x2="42" y2="46" gradientUnits="userSpaceOnUse">
          <stop stopColor="#1c2747" />
          <stop offset="1" stopColor="#0d1424" />
        </linearGradient>
        <linearGradient id="undrrai-ac" x1="8" y1="12" x2="40" y2="40" gradientUnits="userSpaceOnUse">
          <stop stopColor="#34d399" />
          <stop offset="1" stopColor="#22d3ee" />
        </linearGradient>
      </defs>
      {/* Shield */}
      <path
        d="M24 3.5l15.5 5.6v11.4c0 10.6-6.7 18.4-15.5 23.2C15.2 38.9 8.5 31.1 8.5 20.5V9.1L24 3.5z"
        fill="url(#undrrai-bg)"
        stroke="url(#undrrai-ac)"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {/* Resilience pulse */}
      <path
        d="M9.5 25.5h5.2l2.8-7.5 4.8 14 3.6-9 2.4 2.5h7.7"
        fill="none"
        stroke="url(#undrrai-ac)"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* AI badge */}
      <circle cx="37" cy="11.5" r="8.2" fill="#0d1424" stroke="url(#undrrai-ac)" strokeWidth="1.6" />
      <text
        x="37"
        y="14.9"
        textAnchor="middle"
        fontFamily="ui-sans-serif, system-ui, -apple-system, sans-serif"
        fontSize="8.4"
        fontWeight="700"
        fill="#34d399"
      >
        AI
      </text>
    </svg>
  );
}
