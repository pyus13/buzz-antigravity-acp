// The marks beside Gemini in Buzz: a four-pointed sparkle in Gemini's blue to
// violet, alone beside each model, and with a "+" badge beside "Gemini (ACP)"
// in the Harness picker, so it reads as Gemini, extended, at 20 px.

const f = (n) => Number(n.toFixed(3));

/** A four-pointed sparkle at (cx, cy), `r` to each point, its sides curving
 * in to `waist` of that at the middle. */
function sparkle(cx, cy, r, waist = 0.14) {
  const w = r * waist;
  const q = (x, y) => `${f(cx + x)} ${f(cy + y)}`;
  return `M${q(0, -r)} C${q(w, -w)} ${q(w, -w)} ${q(r, 0)} C${q(w, w)} ${q(w, w)} ${q(0, r)} C${q(-w, w)} ${q(-w, w)} ${q(-r, 0)} C${q(-w, -w)} ${q(-w, -w)} ${q(0, -r)} Z`;
}

const gradient = (id, x1, y1, x2, y2) =>
  `<linearGradient id="${id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#4C8DF6"/><stop offset="0.55" stop-color="#7C6CF2"/><stop offset="1" stop-color="#A86CE4"/></linearGradient>`;

/** The model mark: the sparkle alone. */
export function modelMark() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <defs>${gradient("gm-fill", 4, 4, 28, 28)}</defs>
  <path d="${sparkle(16, 16, 14)}" fill="url(#gm-fill)"/>
</svg>`;
}

/** The harness mark: the sparkle, cut around a "+" badge. */
export function harnessMark() {
  const [cx, cy, r] = [14.2, 14.2, 13.4];
  const [bx, by, br] = [25.3, 25.3, 5.9];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <defs>
    ${gradient("gh-fill", 1, 1, 27, 27)}
    <mask id="gh-cut"><rect width="32" height="32" fill="#fff"/><circle cx="${bx}" cy="${by}" r="${br + 1.25}" fill="#000"/></mask>
  </defs>
  <path d="${sparkle(cx, cy, r)}" fill="url(#gh-fill)" mask="url(#gh-cut)"/>
  <circle cx="${bx}" cy="${by}" r="${br}" fill="#6A5BE8"/>
  <g transform="translate(${bx} ${by})"><path d="M0 -2.85 V2.85 M-2.85 0 H2.85" stroke="#F5F3FF" stroke-width="1.6" stroke-linecap="round"/></g>
</svg>`;
}
