// The marks beside Antigravity in Buzz: a rising arch in Google's blue, green,
// yellow and red, alone beside each model, and with a "+" badge beside
// "Antigravity (ACP)" in the Harness picker, so it reads as Antigravity,
// extended, at 20 px.

/** The arch: two legs rising to a rounded peak, as a thick stroke. */
const arch = (x0, y0, x1, peakY) => {
  const mid = (x0 + x1) / 2;
  return `M${x0} ${y0} C${x0} ${peakY + 6} ${mid - 5} ${peakY} ${mid} ${peakY} C${mid + 5} ${peakY} ${x1} ${peakY + 6} ${x1} ${y0}`;
};

const gradient = (id, x1, x2) =>
  `<linearGradient id="${id}" x1="${x1}" y1="0" x2="${x2}" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#4285F4"/><stop offset="0.35" stop-color="#34A853"/><stop offset="0.68" stop-color="#FBBC04"/><stop offset="1" stop-color="#EA4335"/></linearGradient>`;

/** The model mark: the arch alone. */
export function modelMark() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <defs>${gradient("am-fill", 5, 27)}</defs>
  <path d="${arch(6.5, 27, 25.5, 5)}" fill="none" stroke="url(#am-fill)" stroke-width="5" stroke-linecap="round"/>
</svg>`;
}

/** The harness mark: the arch, cut around a "+" badge. */
export function harnessMark() {
  const [bx, by, br] = [25.3, 25.3, 5.9];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <defs>
    ${gradient("ah-fill", 3, 25)}
    <mask id="ah-cut"><rect width="32" height="32" fill="#fff"/><circle cx="${bx}" cy="${by}" r="${br + 1.25}" fill="#000"/></mask>
  </defs>
  <path d="${arch(4.5, 26, 23.5, 4)}" fill="none" stroke="url(#ah-fill)" stroke-width="5" stroke-linecap="round" mask="url(#ah-cut)"/>
  <circle cx="${bx}" cy="${by}" r="${br}" fill="#4285F4"/>
  <g transform="translate(${bx} ${by})"><path d="M0 -2.85 V2.85 M-2.85 0 H2.85" stroke="#F5F8FF" stroke-width="1.6" stroke-linecap="round"/></g>
</svg>`;
}
