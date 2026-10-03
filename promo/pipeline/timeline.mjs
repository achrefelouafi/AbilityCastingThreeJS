// The 10-second showcase timeline, shared by the capture (drives the app) and the overlay (draws the panel).
export const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
export const smooth = (t) => { t = clamp(t); return t * t * (3 - 2 * t); };
export const ease = (t) => { t = clamp(t); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
export function windows(P, L) {
  return {
    paused: [P, P + L],
    drag: [[P + 26, P + 76], [P + 84, P + 134], [P + 142, P + 192]],
    panelIn: [P, P + 24],
    panelOut: [P + L + 55, P + L + 85]
  };
}
export function stateAt(f, P, L) {
  const w = windows(P, L);
  const s = w.drag.map(([a, b]) => ease((f - a) / (b - a)));
  const inK = smooth((f - w.panelIn[0]) / (w.panelIn[1] - w.panelIn[0]));
  const outK = smooth((f - w.panelOut[0]) / (w.panelOut[1] - w.panelOut[0]));
  const panel = inK * (1 - outK);
  return { paused: f >= w.paused[0] && f < w.paused[1], s, panel, shift: 0.125 * panel };
}
/** Hue rotation about the grey axis, degrees. */
export function rotateHue(hex, deg) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const a = (deg * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a), k = 1 / 3, q = Math.sqrt(k);
  const R = r * (c + (1 - c) * k) + g * (k * (1 - c) - q * sn) + b * (k * (1 - c) + q * sn);
  const G = r * (k * (1 - c) + q * sn) + g * (c + k * (1 - c)) + b * (k * (1 - c) - q * sn);
  const B = r * (k * (1 - c) - q * sn) + g * (k * (1 - c) + q * sn) + b * (c + k * (1 - c));
  const h = (v) => Math.round(clamp(v) * 255).toString(16).padStart(2, '0');
  return '#' + h(R) + h(G) + h(B);
}
