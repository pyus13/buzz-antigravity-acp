// The plugin-list icon: Antigravity's rising arch with a small sparkle above
// it, in the frosted, inflated material of Buzz's bundled plugin icons, on
// transparency (Buzz draws the tile).
const S = 512;
const C = S / 2;
const f = (n) => Number(n.toFixed(2));

function sparkle(cx, cy, r, waist = 0.25) {
  const w = r * waist;
  const q = (x, y) => `${f(cx + x)} ${f(cy + y)}`;
  return `M${q(0, -r)} C${q(w, -w)} ${q(w, -w)} ${q(r, 0)} C${q(w, w)} ${q(w, w)} ${q(0, r)} C${q(-w, w)} ${q(-w, w)} ${q(-r, 0)} C${q(-w, -w)} ${q(-w, -w)} ${q(0, -r)} Z`;
}

/** The glyph, 512 px on transparency. */
export const glyph = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <defs>
    <linearGradient id="frost" x1="120" y1="90" x2="400" y2="430" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#FFFFFF"/>
      <stop offset="0.45" stop-color="#E4EEFF"/>
      <stop offset="1" stop-color="#A8C4FF"/>
    </linearGradient>
    <filter id="puffy" x="-25%" y="-25%" width="150%" height="150%" color-interpolation-filters="sRGB">
      <feGaussianBlur in="SourceAlpha" stdDeviation="9" result="soft"/>
      <feOffset in="soft" dx="-6" dy="-10" result="up"/>
      <feComposite in="SourceAlpha" in2="up" operator="arithmetic" k2="1" k3="-1" result="lower"/>
      <feFlood flood-color="#5B7FF0" flood-opacity="0.62"/>
      <feComposite in2="lower" operator="in" result="shade"/>
      <feGaussianBlur in="SourceAlpha" stdDeviation="5" result="soft2"/>
      <feOffset in="soft2" dx="4" dy="7" result="down"/>
      <feComposite in="SourceAlpha" in2="down" operator="arithmetic" k2="1" k3="-1" result="upper"/>
      <feFlood flood-color="#FFFFFF" flood-opacity="0.95"/>
      <feComposite in2="upper" operator="in" result="rim"/>
      <feGaussianBlur in="SourceAlpha" stdDeviation="12" result="far"/>
      <feOffset in="far" dy="12" result="dropped"/>
      <feFlood flood-color="#1B2BB5" flood-opacity="0.26"/>
      <feComposite in2="dropped" operator="in" result="drop"/>
      <feMerge>
        <feMergeNode in="drop"/>
        <feMergeNode in="SourceGraphic"/>
        <feMergeNode in="shade"/>
        <feMergeNode in="rim"/>
      </feMerge>
    </filter>
  </defs>
  <g filter="url(#puffy)">
    <path d="M${C - 128} ${C + 150} C${C - 128} ${C - 60} ${C - 70} ${C - 120} ${C} ${C - 120} C${C + 70} ${C - 120} ${C + 128} ${C - 60} ${C + 128} ${C + 150}" fill="none" stroke="url(#frost)" stroke-width="78" stroke-linecap="round"/>
    <g fill="url(#frost)">
      <path d="${sparkle(C + 150, C - 160, 46, 0.16)}"/>
    </g>
  </g>
</svg>`;
