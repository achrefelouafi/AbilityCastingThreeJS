/**
 * A printable mat for the AR mode.
 *
 * The tracker follows corners, and a blank sheet has four. This draws a page
 * that has a few thousand: a dense field of black glyphs on white, at every
 * size from a fingernail to a coin, with a heavy border to place the corners
 * on. Any printed page works; this one works from every angle and distance
 * the tracker will ever see it at, and the pattern is seeded so every print
 * of it is the same print.
 *
 * `openPrintableMat` renders it at 300 dpi for A4 landscape and opens the
 * print dialog on it — no file to find, no download to explain on stage.
 */

const A4_WIDTH_MM = 297;
const A4_HEIGHT_MM = 210;
const DPI = 300;

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

/**
 * Draw the mat onto `canvas`, filling it. Any size: the glyphs scale with
 * the shorter side.
 */
export function drawStageMat(canvas, { seed = 0x5ca1ab1e, title = 'ELEMENTAL SANDBOX · AR STAGE' } = {}) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const unit = Math.min(w, h) / 100;
  const random = rng(seed);

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);

  // The border: thick, with an inner hairline, so the corners are unambiguous.
  const border = unit * 3.2;
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, w, border);
  ctx.fillRect(0, h - border, w, border);
  ctx.fillRect(0, 0, border, h);
  ctx.fillRect(w - border, 0, border, h);
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = unit * 0.35;
  ctx.strokeRect(border * 1.6, border * 1.6, w - border * 3.2, h - border * 3.2);

  // Corner marks inside the border: an L in each corner, for the eye.
  const arm = unit * 7;
  ctx.lineWidth = unit * 1.1;
  for (const [cx, cy, sx, sy] of [
    [border * 2.4, border * 2.4, 1, 1],
    [w - border * 2.4, border * 2.4, -1, 1],
    [w - border * 2.4, h - border * 2.4, -1, -1],
    [border * 2.4, h - border * 2.4, 1, -1]
  ]) {
    ctx.beginPath();
    ctx.moveTo(cx, cy + sy * arm);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx + sx * arm, cy);
    ctx.stroke();
  }

  // Glyphs: three passes at three sizes, larger first so the small ones
  // land on top of and around the big ones. No two overlap the same way.
  const inset = border * 2.4 + unit * 1.5;
  const glyph = (x, y, size, kind, angle) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.fillStyle = '#000000';
    ctx.beginPath();
    switch (kind) {
      case 0:
        ctx.rect(-size / 2, -size / 2, size, size);
        break;
      case 1:
        ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
        break;
      case 2:
        ctx.moveTo(0, -size / 2);
        ctx.lineTo(size / 2, size / 2);
        ctx.lineTo(-size / 2, size / 2);
        ctx.closePath();
        break;
      case 3:
        ctx.rect(-size / 2, -size / 6, size, size / 3);
        break;
      case 4:
        ctx.moveTo(0, -size / 2);
        ctx.lineTo(size / 2, 0);
        ctx.lineTo(0, size / 2);
        ctx.lineTo(-size / 2, 0);
        ctx.closePath();
        break;
      default:
        // A ring: a hole gives a second contour.
        ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
        ctx.arc(0, 0, size / 4, 0, Math.PI * 2, true);
        break;
    }
    ctx.fill('evenodd');
    ctx.restore();
  };

  const passes = [
    { count: 26, min: 6, max: 11 },
    { count: 120, min: 2.6, max: 5 },
    { count: 420, min: 0.9, max: 2.2 }
  ];
  const placed = [];
  for (const pass of passes) {
    for (let i = 0; i < pass.count; i++) {
      const size = (pass.min + random() * (pass.max - pass.min)) * unit;
      let x = 0;
      let y = 0;
      let ok = false;
      for (let attempt = 0; attempt < 30 && !ok; attempt++) {
        x = inset + size / 2 + random() * (w - 2 * inset - size);
        y = inset + size / 2 + random() * (h - 2 * inset - size);
        ok = true;
        for (const p of placed) {
          const d = Math.hypot(p.x - x, p.y - y);
          if (d < (p.size + size) * 0.55) {
            ok = false;
            break;
          }
        }
      }
      if (!ok) continue;
      placed.push({ x, y, size });
      glyph(x, y, size, (random() * 6) | 0, random() * Math.PI);
    }
  }

  // The title, small, along the bottom edge inside the border. More corners.
  ctx.fillStyle = '#000000';
  ctx.font = `600 ${unit * 2.2}px Inter, "Segoe UI", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(title, w / 2, h - border * 2.4 - unit * 1.2);
  return canvas;
}

/** Render the mat for A4 landscape at 300 dpi and open the print dialog on it. */
export function openPrintableMat() {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round((A4_WIDTH_MM / 25.4) * DPI);
  canvas.height = Math.round((A4_HEIGHT_MM / 25.4) * DPI);
  drawStageMat(canvas);
  const url = canvas.toDataURL('image/png');

  const win = window.open('', '_blank');
  if (!win) return false;
  win.document.write(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Elemental Sandbox — AR stage mat (A4)</title>
<style>
  @page { size: A4 landscape; margin: 0; }
  html, body { margin: 0; background: #fff; }
  img { display: block; width: 297mm; height: 210mm; }
  p { font: 13px/1.5 system-ui, sans-serif; margin: 12px; color: #333; }
  @media print { p { display: none; } }
</style></head>
<body>
<p>Print at 100% (no "fit to page"), landscape. Any printed page tracks — this one tracks from anywhere. Lay it flat; in the sandbox pick the A4 shape and drag the corners onto the black border.</p>
<img src="${url}" alt="AR stage mat">
<script>window.addEventListener('load', () => setTimeout(() => window.print(), 300));</script>
</body></html>`);
  win.document.close();
  return true;
}
