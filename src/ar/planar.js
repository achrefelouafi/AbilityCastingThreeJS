/**
 * planar.js — markerless planar tracking, in plain JavaScript.
 *
 * The AR mode needs one thing from the camera: where a rectangle the user
 * picked in one frame is in every frame after it. That is a homography — the
 * 3×3 map from the reference image to the current one — and once it is known,
 * the metric shape of the rectangle turns it into a camera pose. This file is
 * everything between the pixels and that matrix, with no dependencies: it runs
 * the same in a worker, on the main thread, and under Node for the tests.
 *
 * The pipeline per frame, driven by `PlanarTracker#track`:
 *
 *   1. **Pyramid.** Grey, then halved three times with a 5-tap Gaussian.
 *   2. **Frame-to-frame Lucas–Kanade.** Every feature is followed from the
 *      previous frame into this one, coarse to fine, starting from where the
 *      last homography predicts it. Consecutive frames are nearly identical,
 *      which is what makes this step survive motion blur and lighting.
 *   3. **RANSAC homography** from the features' *reference* positions to
 *      where they are now — never from the previous frame, so an outlier can
 *      only ever cost one frame.
 *   4. **Snap to the reference.** Frame-to-frame tracking drifts: every
 *      feature walks a few hundredths of a pixel a frame and the scene slowly
 *      slides off the table. So each feature is re-registered against a patch
 *      of the *reference* image, warped through the current homography to
 *      look like it should look now, and pulled back onto it. The drift has
 *      nothing to accumulate on. A feature that lost its frame-to-frame track
 *      — a hand passed over it — is tried again here from the prediction, and
 *      usually comes back.
 *   5. **Refit** on the snapped positions, with a Gauss–Newton pass on the
 *      transfer error under a Huber weight, and re-detect corners wherever the
 *      quad has gone thin.
 *
 * When too few features survive, the tracker is *lost* and switches to
 * re-detection: BRIEF descriptors of fresh corners in the frame are matched
 * against a bank computed from the reference at three scales, and a RANSAC
 * over the matches either re-locks the plane or waits for the next frame.
 *
 * Coordinates are pixels of the tracker's own working resolution; level L of
 * a pyramid is level 0 divided by 2^L. Homographies are row-major 3×3 with the
 * last entry free (they are normalised to h[8] = 1 wherever they are solved).
 */

/* ------------------------------------------------------------------ */
/* Tunables                                                            */
/* ------------------------------------------------------------------ */

/** Pyramid depth. Three halvings of a 640-wide frame end at 80 px. */
const LEVELS = 4;
/** Half-width of the frame-to-frame window (15×15). */
const LK_RADIUS = 7;
/** Half-width of the reference-snap window (13×13). */
const SNAP_RADIUS = 6;
const LK_MAX_ITER = 12;
const LK_EPS = 0.02;
/** Round-trip error, in pixels, above which a frame-to-frame track is a lie. */
const FB_THRESHOLD = 1.0;
/** Normalised correlation a snapped patch must reach to be believed. */
const SNAP_NCC = 0.55;
/** Minimum eigenvalue of the LK normal matrix, per pixel of window — below
 *  this the patch is an edge or flat and the solve is noise. */
const LK_MIN_EIGEN = 0.5;

const RANSAC_THRESHOLD = 2.0;
const RANSAC_MAX_ITER = 250;
const MIN_INLIERS = 12;
const MAX_FEATURES = 160;
/** Below this many inliers, fresh corners are sought. */
const REFILL_BELOW = 110;
const CORNER_MIN_DISTANCE = 9;
const CORNER_QUALITY = 0.015;
/** Consecutive misses before a feature is discarded. */
const MAX_MISSES = 8;

/** Re-detection: the bank and the search. */
const RECOVER_EVERY = 2;
const RECOVER_MIN_INLIERS = 14;
const RECOVER_THRESHOLD = 4.0;
const BRIEF_BITS = 256;
const BRIEF_RADIUS = 15;
const BRIEF_MAX_HAMMING = 72;
const BRIEF_RATIO = 0.85;

/* ------------------------------------------------------------------ */
/* Images                                                              */
/* ------------------------------------------------------------------ */

export class GrayImage {
  constructor(width, height, data = null) {
    this.width = width;
    this.height = height;
    this.data = data ?? new Float32Array(width * height);
  }
}

/** Luma of an RGBA buffer, 0..255 as floats. */
export function grayFromRGBA(rgba, width, height, out = null) {
  const img = out && out.width === width && out.height === height ? out : new GrayImage(width, height);
  const d = img.data;
  for (let i = 0, j = 0, n = width * height; i < n; i++, j += 4) {
    d[i] = rgba[j] * 0.299 + rgba[j + 1] * 0.587 + rgba[j + 2] * 0.114;
  }
  return img;
}

/**
 * Halve an image with a [1 4 6 4 1]/16 Gaussian. Pixel x of the result sits
 * exactly on pixel 2x of the source, so a coordinate at level L is the level
 * 0 coordinate divided by 2^L with no half-pixel bookkeeping anywhere else.
 */
export function downsample(src, out = null) {
  const w = src.width;
  const h = src.height;
  const dw = w >> 1;
  const dh = h >> 1;
  const dst = out && out.width === dw && out.height === dh ? out : new GrayImage(dw, dh);
  const s = src.data;
  const tmp = downsample._tmp && downsample._tmp.length >= dw * h ? downsample._tmp : (downsample._tmp = new Float32Array(dw * h));

  for (let y = 0; y < h; y++) {
    const row = y * w;
    const trow = y * dw;
    for (let x = 0; x < dw; x++) {
      const cx = 2 * x;
      const xm2 = cx > 1 ? cx - 2 : 0;
      const xm1 = cx > 0 ? cx - 1 : 0;
      const xp1 = cx < w - 1 ? cx + 1 : w - 1;
      const xp2 = cx < w - 2 ? cx + 2 : w - 1;
      tmp[trow + x] =
        (s[row + xm2] + 4 * s[row + xm1] + 6 * s[row + cx] + 4 * s[row + xp1] + s[row + xp2]) * (1 / 16);
    }
  }
  const d = dst.data;
  for (let y = 0; y < dh; y++) {
    const cy = 2 * y;
    const ym2 = (cy > 1 ? cy - 2 : 0) * dw;
    const ym1 = (cy > 0 ? cy - 1 : 0) * dw;
    const y0 = cy * dw;
    const yp1 = (cy < h - 1 ? cy + 1 : h - 1) * dw;
    const yp2 = (cy < h - 2 ? cy + 2 : h - 1) * dw;
    const drow = y * dw;
    for (let x = 0; x < dw; x++) {
      d[drow + x] = (tmp[ym2 + x] + 4 * tmp[ym1 + x] + 6 * tmp[y0 + x] + 4 * tmp[yp1 + x] + tmp[yp2 + x]) * (1 / 16);
    }
  }
  return dst;
}

export function buildPyramid(base, levels = LEVELS, reuse = null) {
  const pyr = [base];
  for (let i = 1; i < levels; i++) {
    const prev = pyr[i - 1];
    if (prev.width < 24 || prev.height < 24) break;
    pyr.push(downsample(prev, reuse?.[i] ?? null));
  }
  return pyr;
}

/** Separable 5-tap Gaussian blur, for the descriptors (BRIEF wants smoothed intensities). */
export function blur5(src, out = null) {
  const w = src.width;
  const h = src.height;
  const dst = out && out.width === w && out.height === h ? out : new GrayImage(w, h);
  const s = src.data;
  const tmp = blur5._tmp && blur5._tmp.length >= w * h ? blur5._tmp : (blur5._tmp = new Float32Array(w * h));
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const xm2 = x > 1 ? x - 2 : 0;
      const xm1 = x > 0 ? x - 1 : 0;
      const xp1 = x < w - 1 ? x + 1 : w - 1;
      const xp2 = x < w - 2 ? x + 2 : w - 1;
      tmp[row + x] = (s[row + xm2] + 4 * s[row + xm1] + 6 * s[row + x] + 4 * s[row + xp1] + s[row + xp2]) * (1 / 16);
    }
  }
  const d = dst.data;
  for (let y = 0; y < h; y++) {
    const ym2 = (y > 1 ? y - 2 : 0) * w;
    const ym1 = (y > 0 ? y - 1 : 0) * w;
    const y0 = y * w;
    const yp1 = (y < h - 1 ? y + 1 : h - 1) * w;
    const yp2 = (y < h - 2 ? y + 2 : h - 1) * w;
    for (let x = 0; x < w; x++) {
      d[y0 + x] = (tmp[ym2 + x] + 4 * tmp[ym1 + x] + 6 * tmp[y0 + x] + 4 * tmp[yp1 + x] + tmp[yp2 + x]) * (1 / 16);
    }
  }
  return dst;
}

/** Bilinear sample, clamped to the image. */
export function sample(img, x, y) {
  const w = img.width;
  const h = img.height;
  if (x < 0) x = 0;
  else if (x > w - 1.0001) x = w - 1.0001;
  if (y < 0) y = 0;
  else if (y > h - 1.0001) y = h - 1.0001;
  const x0 = x | 0;
  const y0 = y | 0;
  const fx = x - x0;
  const fy = y - y0;
  const d = img.data;
  const i = y0 * w + x0;
  const top = d[i] + (d[i + 1] - d[i]) * fx;
  const bottom = d[i + w] + (d[i + w + 1] - d[i + w]) * fx;
  return top + (bottom - top) * fy;
}

/* ------------------------------------------------------------------ */
/* Small linear algebra                                                */
/* ------------------------------------------------------------------ */

/**
 * Solve A x = b in place by Gaussian elimination with partial pivoting.
 * `A` is n×n row-major and is destroyed; the solution lands in `b`.
 * @returns {boolean} false when a pivot vanishes (singular system)
 */
export function solveLinear(A, b, n) {
  for (let col = 0; col < n; col++) {
    let pivot = col;
    let best = Math.abs(A[col * n + col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(A[r * n + col]);
      if (v > best) {
        best = v;
        pivot = r;
      }
    }
    if (best < 1e-12) return false;
    if (pivot !== col) {
      for (let c = 0; c < n; c++) {
        const t = A[col * n + c];
        A[col * n + c] = A[pivot * n + c];
        A[pivot * n + c] = t;
      }
      const t = b[col];
      b[col] = b[pivot];
      b[pivot] = t;
    }
    const inv = 1 / A[col * n + col];
    for (let r = col + 1; r < n; r++) {
      const f = A[r * n + col] * inv;
      if (f === 0) continue;
      for (let c = col; c < n; c++) A[r * n + c] -= f * A[col * n + c];
      b[r] -= f * b[col];
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let c = r + 1; c < n; c++) s -= A[r * n + c] * b[c];
    b[r] = s / A[r * n + r];
  }
  return true;
}

/** out = a · b, 3×3 row-major. `out` may alias neither input. */
export function mulH(a, b, out = new Float64Array(9)) {
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out;
}

/** Inverse of a 3×3 by adjugate. Returns null when singular. */
export function invH(h, out = new Float64Array(9)) {
  const [a, b, c, d, e, f, g, i, k] = h;
  const A = e * k - f * i;
  const B = -(d * k - f * g);
  const C = d * i - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-14) return null;
  const inv = 1 / det;
  out[0] = A * inv;
  out[1] = -(b * k - c * i) * inv;
  out[2] = (b * f - c * e) * inv;
  out[3] = B * inv;
  out[4] = (a * k - c * g) * inv;
  out[5] = -(a * f - c * d) * inv;
  out[6] = C * inv;
  out[7] = -(a * i - b * g) * inv;
  out[8] = (a * e - b * d) * inv;
  return out;
}

/** Apply a homography to a point; writes out[0], out[1]. Returns the denominator. */
export function projectH(h, x, y, out, offset = 0) {
  const w = h[6] * x + h[7] * y + h[8];
  const inv = 1 / w;
  out[offset] = (h[0] * x + h[1] * y + h[2]) * inv;
  out[offset + 1] = (h[3] * x + h[4] * y + h[5]) * inv;
  return w;
}

/** Scale to h[8] = 1 in place, when that is not degenerate. */
export function normalizeH(h) {
  if (Math.abs(h[8]) > 1e-12) {
    const inv = 1 / h[8];
    for (let i = 0; i < 9; i++) h[i] *= inv;
  }
  return h;
}

/* ------------------------------------------------------------------ */
/* Homography fitting                                                  */
/* ------------------------------------------------------------------ */

/**
 * Hartley normalisation: translate a point set to its centroid and scale it
 * to an RMS distance of √2, so the linear systems below are conditioned the
 * same for a 640 px frame as for a unit square. Returns the 3×3 transform.
 */
function normalizingTransform(pts, idx, count, out) {
  let cx = 0;
  let cy = 0;
  for (let k = 0; k < count; k++) {
    const i = idx ? idx[k] : k;
    cx += pts[2 * i];
    cy += pts[2 * i + 1];
  }
  cx /= count;
  cy /= count;
  let dist = 0;
  for (let k = 0; k < count; k++) {
    const i = idx ? idx[k] : k;
    dist += Math.hypot(pts[2 * i] - cx, pts[2 * i + 1] - cy);
  }
  dist /= count;
  const s = dist > 1e-9 ? Math.SQRT2 / dist : 1;
  out[0] = s;
  out[1] = 0;
  out[2] = -s * cx;
  out[3] = 0;
  out[4] = s;
  out[5] = -s * cy;
  out[6] = 0;
  out[7] = 0;
  out[8] = 1;
  return out;
}

const _Tsrc = new Float64Array(9);
const _Tdst = new Float64Array(9);
const _TdstInv = new Float64Array(9);
const _A = new Float64Array(64);
const _b = new Float64Array(8);
const _Hn = new Float64Array(9);
const _tmpH = new Float64Array(9);
const _pt = new Float64Array(2);

/**
 * Least-squares homography src → dst over the points named by `idx` (or the
 * first `count` points when `idx` is null), in the h[8] = 1 parametrisation.
 * Exact for four points, least-squares beyond. Returns null when degenerate.
 */
export function fitHomography(src, dst, idx, count, out = new Float64Array(9)) {
  if (count < 4) return null;
  normalizingTransform(src, idx, count, _Tsrc);
  normalizingTransform(dst, idx, count, _Tdst);

  _A.fill(0);
  _b.fill(0);
  const row = new Float64Array(8);
  for (let k = 0; k < count; k++) {
    const i = idx ? idx[k] : k;
    const x = _Tsrc[0] * src[2 * i] + _Tsrc[2];
    const y = _Tsrc[4] * src[2 * i + 1] + _Tsrc[5];
    const u = _Tdst[0] * dst[2 * i] + _Tdst[2];
    const v = _Tdst[4] * dst[2 * i + 1] + _Tdst[5];

    // [x y 1 0 0 0 -xu -yu] h = u
    row[0] = x; row[1] = y; row[2] = 1; row[3] = 0; row[4] = 0; row[5] = 0; row[6] = -x * u; row[7] = -y * u;
    accumulate(row, u);
    // [0 0 0 x y 1 -xv -yv] h = v
    row[0] = 0; row[1] = 0; row[2] = 0; row[3] = x; row[4] = y; row[5] = 1; row[6] = -x * v; row[7] = -y * v;
    accumulate(row, v);
  }
  if (!solveLinear(_A, _b, 8)) return null;

  for (let i = 0; i < 8; i++) _Hn[i] = _b[i];
  _Hn[8] = 1;
  // H = Tdst⁻¹ · Hn · Tsrc
  if (!invH(_Tdst, _TdstInv)) return null;
  mulH(_Hn, _Tsrc, _tmpH);
  mulH(_TdstInv, _tmpH, out);
  normalizeH(out);
  for (let i = 0; i < 9; i++) if (!Number.isFinite(out[i])) return null;
  return out;
}

/** Add rowᵀ·row to the 8×8 normal matrix and rowᵀ·rhs to its right-hand side. */
function accumulate(row, rhs) {
  for (let r = 0; r < 8; r++) {
    const vr = row[r];
    if (vr === 0) continue;
    _b[r] += vr * rhs;
    const base = r * 8;
    for (let c = 0; c < 8; c++) _A[base + c] += vr * row[c];
  }
}

const _J = new Float64Array(64);
const _g = new Float64Array(8);

/**
 * Gauss–Newton on the transfer error |H·p − q|, Huber-weighted, in
 * normalised coordinates. Three or four iterations from the algebraic
 * solution is where the sub-pixel precision comes from; the linear fit alone
 * minimises the wrong thing.
 */
export function refineHomography(H, src, dst, idx, count, huber = RANSAC_THRESHOLD, iterations = 4) {
  if (count < 5) return H;
  normalizingTransform(src, idx, count, _Tsrc);
  normalizingTransform(dst, idx, count, _Tdst);
  if (!invH(_Tdst, _TdstInv)) return H;
  // Hn = Tdst · H · Tsrc⁻¹
  const TsrcInv = invH(_Tsrc, new Float64Array(9));
  if (!TsrcInv) return H;
  mulH(H, TsrcInv, _tmpH);
  const Hn = mulH(_Tdst, _tmpH, new Float64Array(9));
  normalizeH(Hn);
  // The Huber knee, in the normalised frame.
  const knee = huber * _Tdst[0];

  const row = new Float64Array(8);
  for (let it = 0; it < iterations; it++) {
    _J.fill(0);
    _g.fill(0);
    for (let k = 0; k < count; k++) {
      const i = idx ? idx[k] : k;
      const x = _Tsrc[0] * src[2 * i] + _Tsrc[2];
      const y = _Tsrc[4] * src[2 * i + 1] + _Tsrc[5];
      const u = _Tdst[0] * dst[2 * i] + _Tdst[2];
      const v = _Tdst[4] * dst[2 * i + 1] + _Tdst[5];
      const D = Hn[6] * x + Hn[7] * y + 1;
      const invD = 1 / D;
      const px = (Hn[0] * x + Hn[1] * y + Hn[2]) * invD;
      const py = (Hn[3] * x + Hn[4] * y + Hn[5]) * invD;
      const rx = u - px;
      const ry = v - py;
      const err = Math.hypot(rx, ry);
      const w = err > knee ? knee / err : 1;

      // d px / d h
      row[0] = x * invD; row[1] = y * invD; row[2] = invD; row[3] = 0; row[4] = 0; row[5] = 0;
      row[6] = -px * x * invD; row[7] = -px * y * invD;
      accumulateWeighted(row, rx, w);
      row[0] = 0; row[1] = 0; row[2] = 0; row[3] = x * invD; row[4] = y * invD; row[5] = invD;
      row[6] = -py * x * invD; row[7] = -py * y * invD;
      accumulateWeighted(row, ry, w);
    }
    // Levenberg damping keeps a thin sample from blowing the step up.
    for (let d = 0; d < 8; d++) _J[d * 8 + d] *= 1.0005;
    if (!solveLinear(_J, _g, 8)) break;
    let step = 0;
    for (let d = 0; d < 8; d++) {
      Hn[d] += _g[d];
      step += _g[d] * _g[d];
    }
    if (step < 1e-16) break;
  }

  mulH(Hn, _Tsrc, _tmpH);
  mulH(_TdstInv, _tmpH, H);
  normalizeH(H);
  return H;
}

function accumulateWeighted(row, rhs, w) {
  for (let r = 0; r < 8; r++) {
    const vr = row[r] * w;
    if (vr === 0) continue;
    _g[r] += vr * rhs;
    const base = r * 8;
    for (let c = 0; c < 8; c++) _J[base + c] += vr * row[c];
  }
}

/** xorshift32 — deterministic, so a test run is a test run. */
export function makeRng(seed = 0x9e3779b9) {
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

const _sample4 = new Int32Array(4);

/**
 * RANSAC homography src → dst.
 *
 * @param {Float64Array} src   2N interleaved
 * @param {Float64Array} dst
 * @param {Int32Array|null} idx which points to consider, or null for all
 * @param {number} count
 * @param {object} [options]
 * @returns {{H: Float64Array, inliers: Uint8Array, n: number}|null}
 *   `inliers` is indexed like `src` (by point index, not by position in `idx`).
 */
export function ransacHomography(src, dst, idx, count, { threshold = RANSAC_THRESHOLD, maxIter = RANSAC_MAX_ITER, rng = Math.random, minInliers = 4 } = {}) {
  if (count < 4) return null;
  const inliers = new Uint8Array(src.length / 2);
  const best = new Uint8Array(src.length / 2);
  let bestN = 0;
  let bestErr = Infinity;
  const t2 = threshold * threshold;
  const H = new Float64Array(9);
  let iterations = maxIter;

  for (let it = 0; it < iterations; it++) {
    // Four distinct indices.
    for (let k = 0; k < 4; k++) {
      let pick;
      let clash;
      let guard = 0;
      do {
        pick = (rng() * count) | 0;
        if (pick >= count) pick = count - 1;
        pick = idx ? idx[pick] : pick;
        clash = false;
        for (let j = 0; j < k; j++) if (_sample4[j] === pick) clash = true;
      } while (clash && ++guard < 16);
      _sample4[k] = pick;
    }
    if (!fitHomography(src, dst, _sample4, 4, H)) continue;

    let n = 0;
    let err = 0;
    inliers.fill(0);
    for (let k = 0; k < count; k++) {
      const i = idx ? idx[k] : k;
      const w = projectH(H, src[2 * i], src[2 * i + 1], _pt);
      if (w <= 1e-9) continue;
      const dx = _pt[0] - dst[2 * i];
      const dy = _pt[1] - dst[2 * i + 1];
      const e = dx * dx + dy * dy;
      if (e < t2) {
        inliers[i] = 1;
        n++;
        err += e;
      }
    }
    if (n > bestN || (n === bestN && err < bestErr)) {
      bestN = n;
      bestErr = err;
      best.set(inliers);
      // Adaptive stop: once most points agree, a few more draws settle it.
      const w = n / count;
      const p = 1 - Math.pow(w, 4);
      if (p < 1e-9) iterations = Math.min(iterations, it + 1);
      else iterations = Math.min(maxIter, Math.max(it + 1, Math.ceil(Math.log(0.001) / Math.log(p))) + 8);
    }
  }
  if (bestN < Math.max(4, minInliers)) return null;

  // Refit on the consensus, refine, then re-classify with the refined map.
  const consensus = new Int32Array(bestN);
  for (let i = 0, k = 0; i < best.length; i++) if (best[i]) consensus[k++] = i;
  if (!fitHomography(src, dst, consensus, bestN, H)) return null;
  refineHomography(H, src, dst, consensus, bestN, threshold);

  let n = 0;
  best.fill(0);
  for (let k = 0; k < count; k++) {
    const i = idx ? idx[k] : k;
    const w = projectH(H, src[2 * i], src[2 * i + 1], _pt);
    if (w <= 1e-9) continue;
    const dx = _pt[0] - dst[2 * i];
    const dy = _pt[1] - dst[2 * i + 1];
    if (dx * dx + dy * dy < t2 * 1.5) {
      best[i] = 1;
      n++;
    }
  }
  if (n < Math.max(4, minInliers)) return null;
  return { H, inliers: best, n };
}

/* ------------------------------------------------------------------ */
/* Corners                                                             */
/* ------------------------------------------------------------------ */

/** Is (x, y) inside the convex quad given as 8 numbers? Either winding. */
export function insideQuad(quad, x, y) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const ax = quad[2 * i];
    const ay = quad[2 * i + 1];
    const bx = quad[(2 * i + 2) % 8];
    const by = quad[(2 * i + 3) % 8];
    const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (cross === 0) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** Signed area of a quad; the sign is its winding. */
export function quadArea(quad) {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    a += quad[2 * i] * quad[2 * j + 1] - quad[2 * j] * quad[2 * i + 1];
  }
  return a * 0.5;
}

/** Convex, with every corner finite and a sensible area. */
export function quadSane(quad, minArea = 400) {
  for (let i = 0; i < 8; i++) if (!Number.isFinite(quad[i])) return false;
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const ax = quad[2 * ((i + 3) % 4)];
    const ay = quad[2 * ((i + 3) % 4) + 1];
    const bx = quad[2 * i];
    const by = quad[2 * i + 1];
    const cx = quad[2 * ((i + 1) % 4)];
    const cy = quad[2 * ((i + 1) % 4) + 1];
    const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    const s = cross > 0 ? 1 : cross < 0 ? -1 : 0;
    if (s === 0) return false;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return Math.abs(quadArea(quad)) >= minArea;
}

/**
 * Shi–Tomasi corners: the smaller eigenvalue of the structure tensor over a
 * 5×5 window, thresholded against the best in the region, suppressed to one
 * per `minDistance` cell, and kept only inside `quad` (when given) and away
 * from anything already in `occupied`.
 *
 * @param {GrayImage} img
 * @param {object} options
 * @param {number[]|null} options.quad        region of interest, 8 numbers
 * @param {number} options.max
 * @param {number} [options.minDistance]
 * @param {number} [options.quality]
 * @param {number} [options.border]           pixels kept clear of the edge
 * @param {Float64Array|number[]} [options.occupied]  2N points already taken
 * @param {number} [options.occupiedCount]
 * @returns {Float64Array} 2N interleaved corner positions, strongest first
 */
export function detectCorners(img, { quad = null, max = MAX_FEATURES, minDistance = CORNER_MIN_DISTANCE, quality = CORNER_QUALITY, border = 12, occupied = null, occupiedCount = 0 } = {}) {
  const w = img.width;
  const h = img.height;
  const d = img.data;

  let x0 = border;
  let y0 = border;
  let x1 = w - border - 1;
  let y1 = h - border - 1;
  if (quad) {
    let qx0 = Infinity;
    let qy0 = Infinity;
    let qx1 = -Infinity;
    let qy1 = -Infinity;
    for (let i = 0; i < 4; i++) {
      qx0 = Math.min(qx0, quad[2 * i]);
      qx1 = Math.max(qx1, quad[2 * i]);
      qy0 = Math.min(qy0, quad[2 * i + 1]);
      qy1 = Math.max(qy1, quad[2 * i + 1]);
    }
    x0 = Math.max(x0, Math.floor(qx0));
    y0 = Math.max(y0, Math.floor(qy0));
    x1 = Math.min(x1, Math.ceil(qx1));
    y1 = Math.min(y1, Math.ceil(qy1));
  }
  if (x1 - x0 < 8 || y1 - y0 < 8) return new Float64Array(0);

  // Gradients over the box, one pixel of slack for the window.
  const bw = x1 - x0 + 3;
  const bh = y1 - y0 + 3;
  const gxx = new Float32Array(bw * bh);
  const gyy = new Float32Array(bw * bh);
  const gxy = new Float32Array(bw * bh);
  for (let y = 0; y < bh; y++) {
    const iy = Math.min(h - 2, Math.max(1, y0 - 1 + y));
    for (let x = 0; x < bw; x++) {
      const ix = Math.min(w - 2, Math.max(1, x0 - 1 + x));
      const i = iy * w + ix;
      const gx = (d[i + 1] - d[i - 1]) * 0.5;
      const gy = (d[i + w] - d[i - w]) * 0.5;
      const k = y * bw + x;
      gxx[k] = gx * gx;
      gyy[k] = gy * gy;
      gxy[k] = gx * gy;
    }
  }
  // Box-sum the tensor over 5×5 with a separable pass.
  const sxx = boxSum5(gxx, bw, bh);
  const syy = boxSum5(gyy, bw, bh);
  const sxy = boxSum5(gxy, bw, bh);

  const rw = x1 - x0 + 1;
  const rh = y1 - y0 + 1;
  const score = new Float32Array(rw * rh);
  let maxScore = 0;
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const k = (y + 1) * bw + (x + 1);
      const a = sxx[k];
      const c = syy[k];
      const b = sxy[k];
      const half = (a + c) * 0.5;
      const diff = (a - c) * 0.5;
      const s = half - Math.sqrt(diff * diff + b * b);
      score[y * rw + x] = s;
      if (s > maxScore) maxScore = s;
    }
  }
  if (maxScore <= 0) return new Float64Array(0);
  const threshold = maxScore * quality;

  // Candidates: local maxima over 3×3 above the threshold, inside the quad.
  const candidates = [];
  for (let y = 1; y < rh - 1; y++) {
    for (let x = 1; x < rw - 1; x++) {
      const s = score[y * rw + x];
      if (s < threshold) continue;
      const k = y * rw + x;
      if (
        s < score[k - 1] || s < score[k + 1] ||
        s < score[k - rw] || s < score[k + rw] ||
        s < score[k - rw - 1] || s < score[k - rw + 1] ||
        s < score[k + rw - 1] || s < score[k + rw + 1]
      ) continue;
      const px = x0 + x;
      const py = y0 + y;
      if (quad && !insideQuad(quad, px, py)) continue;
      candidates.push(s, px, py);
    }
  }

  // Strongest first, then greedy with a cell grid enforcing the spacing.
  const order = new Int32Array(candidates.length / 3);
  for (let i = 0; i < order.length; i++) order[i] = i;
  order.sort((p, q) => candidates[3 * q] - candidates[3 * p]);

  const cell = Math.max(1, minDistance);
  const gw = Math.ceil(w / cell) + 1;
  const gh = Math.ceil(h / cell) + 1;
  const grid = new Map();
  const key = (cx, cy) => cy * gw + cx;
  const claim = (px, py) => {
    const cx = (px / cell) | 0;
    const cy = (py / cell) | 0;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const nx = cx + ox;
        const ny = cy + oy;
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const list = grid.get(key(nx, ny));
        if (!list) continue;
        for (let i = 0; i < list.length; i += 2) {
          const dx = list[i] - px;
          const dy = list[i + 1] - py;
          if (dx * dx + dy * dy < minDistance * minDistance) return false;
        }
      }
    }
    const k = key(cx, cy);
    let list = grid.get(k);
    if (!list) grid.set(k, (list = []));
    list.push(px, py);
    return true;
  };
  if (occupied) {
    for (let i = 0; i < occupiedCount; i++) claim(occupied[2 * i], occupied[2 * i + 1]);
  }

  const out = [];
  for (let n = 0; n < order.length && out.length < 2 * max; n++) {
    const c = order[n] * 3;
    const px = candidates[c + 1];
    const py = candidates[c + 2];
    if (!claim(px, py)) continue;
    out.push(px, py);
  }
  return Float64Array.from(out);
}

/** 5×5 box sum with edge clamping, separable. */
function boxSum5(src, w, h) {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -2; k <= 2; k++) {
        let xx = x + k;
        if (xx < 0) xx = 0;
        else if (xx >= w) xx = w - 1;
        s += src[row + xx];
      }
      tmp[row + x] = s;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -2; k <= 2; k++) {
        let yy = y + k;
        if (yy < 0) yy = 0;
        else if (yy >= h) yy = h - 1;
        s += tmp[yy * w + x];
      }
      out[y * w + x] = s;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Lucas–Kanade                                                        */
/* ------------------------------------------------------------------ */

/**
 * A template patch: zero-mean intensities with their gradients and the 2×2
 * normal matrix, ready for translation-only alignment. One is reused per
 * feature per level; the arrays are sized for the largest radius in use.
 */
class Patch {
  constructor(maxRadius) {
    const n = 2 * maxRadius + 3;
    this.raw = new Float32Array(n * n); // (2r+3)² samples, one ring for gradients
    this.t = new Float32Array(n * n); // zero-mean, (2r+1)² used
    this.gx = new Float32Array(n * n);
    this.gy = new Float32Array(n * n);
    this.r = 0;
    this.gxx = 0;
    this.gxy = 0;
    this.gyy = 0;
    this.norm = 0;
    this.valid = false;
  }

  /**
   * Fill from `img` around (cx, cy). With `H` (3×3, from this image's frame to
   * `img`'s), every sample position is pushed through it first — that is how
   * the reference is made to look like the current frame.
   */
  build(img, cx, cy, r, H = null) {
    this.r = r;
    const R = r + 1;
    const n = 2 * R + 1;
    const w = img.width;
    const h = img.height;
    const d = img.data;
    const raw = this.raw;
    const limitX = w - 1.0001;
    const limitY = h - 1.0001;

    for (let dy = -R, k = 0; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++, k++) {
        let sx;
        let sy;
        if (H) {
          const px = cx + dx;
          const py = cy + dy;
          const ww = H[6] * px + H[7] * py + H[8];
          if (ww <= 1e-9) {
            this.valid = false;
            return false;
          }
          const inv = 1 / ww;
          sx = (H[0] * px + H[1] * py + H[2]) * inv;
          sy = (H[3] * px + H[4] * py + H[5]) * inv;
        } else {
          sx = cx + dx;
          sy = cy + dy;
        }
        if (sx < 0 || sy < 0 || sx > limitX || sy > limitY) {
          this.valid = false;
          return false;
        }
        const x0 = sx | 0;
        const y0 = sy | 0;
        const fx = sx - x0;
        const fy = sy - y0;
        const i = y0 * w + x0;
        const top = d[i] + (d[i + 1] - d[i]) * fx;
        const bottom = d[i + w] + (d[i + w + 1] - d[i + w]) * fx;
        raw[k] = top + (bottom - top) * fy;
      }
    }

    // Inner (2r+1)²: zero-mean intensities and central-difference gradients.
    const m = 2 * r + 1;
    let mean = 0;
    for (let y = 0; y < m; y++) {
      for (let x = 0; x < m; x++) mean += raw[(y + 1) * n + (x + 1)];
    }
    mean /= m * m;

    let gxx = 0;
    let gxy = 0;
    let gyy = 0;
    let norm = 0;
    const t = this.t;
    const gx = this.gx;
    const gy = this.gy;
    for (let y = 0; y < m; y++) {
      for (let x = 0; x < m; x++) {
        const k = (y + 1) * n + (x + 1);
        const o = y * m + x;
        const v = raw[k] - mean;
        const dxv = (raw[k + 1] - raw[k - 1]) * 0.5;
        const dyv = (raw[k + n] - raw[k - n]) * 0.5;
        t[o] = v;
        gx[o] = dxv;
        gy[o] = dyv;
        gxx += dxv * dxv;
        gxy += dxv * dyv;
        gyy += dyv * dyv;
        norm += v * v;
      }
    }
    this.gxx = gxx;
    this.gxy = gxy;
    this.gyy = gyy;
    this.norm = Math.sqrt(norm);

    // Trackable only when the window has gradient in *both* directions.
    const half = (gxx + gyy) * 0.5;
    const diff = (gxx - gyy) * 0.5;
    const minEig = half - Math.sqrt(diff * diff + gxy * gxy);
    this.valid = minEig > LK_MIN_EIGEN * m * m && this.norm > 1e-3;
    return this.valid;
  }
}

const _window = new Float32Array(64 * 64);

/**
 * Sample the (2R+1)² window of `img` around (x, y) into `_window`, with one
 * ring of slack for gradients. Returns the mean of the inner (2r+1)² block,
 * or NaN when the window leaves the image.
 */
function sampleWindow(img, x, y, r) {
  const R = r + 1;
  const n = 2 * R + 1;
  const w = img.width;
  const d = img.data;
  if (x - R < 0 || y - R < 0 || x + R > w - 1.0001 || y + R > img.height - 1.0001) return NaN;
  const win = _window;
  let mean = 0;
  for (let dy = -R, k = 0; dy <= R; dy++) {
    const sy = y + dy;
    const y0 = sy | 0;
    const fy = sy - y0;
    const rowBase = y0 * w;
    const inner = dy >= -r && dy <= r;
    for (let dx = -R; dx <= R; dx++, k++) {
      const sx = x + dx;
      const x0 = sx | 0;
      const fx = sx - x0;
      const i = rowBase + x0;
      const top = d[i] + (d[i + 1] - d[i]) * fx;
      const bottom = d[i + w] + (d[i + w + 1] - d[i + w]) * fx;
      const v = top + (bottom - top) * fy;
      win[k] = v;
      if (inner && dx >= -r && dx <= r) mean += v;
    }
  }
  return mean / ((2 * r + 1) * (2 * r + 1));
}

/**
 * Align `patch` against `img` by translation, starting at (x, y).
 *
 * The step uses the *mean* of the template's gradient and the current
 * window's (the ESM trick): with the template's alone the fixed point sits
 * a fraction of a pixel off on any sharp edge, and a fraction of a pixel per
 * feature is what the drift is made of.
 *
 * Writes the refined position into `out` and returns the normalised
 * correlation at convergence, or -1 when the window left the image or the
 * solve was degenerate.
 */
function lkAlign(patch, img, x, y, out, maxIter = LK_MAX_ITER, eps = LK_EPS) {
  const r = patch.r;
  const m = 2 * r + 1;
  const n = m + 2;
  const t = patch.t;
  const gx = patch.gx;
  const gy = patch.gy;
  const win = _window;

  for (let it = 0; it < maxIter; it++) {
    const mean = sampleWindow(img, x, y, r);
    if (mean !== mean) return -1;

    let gxx = 0;
    let gxy = 0;
    let gyy = 0;
    let bx = 0;
    let by = 0;
    for (let yy = 0; yy < m; yy++) {
      for (let xx = 0; xx < m; xx++) {
        const k = (yy + 1) * n + (xx + 1);
        const o = yy * m + xx;
        const mx = (gx[o] + (win[k + 1] - win[k - 1]) * 0.5) * 0.5;
        const my = (gy[o] + (win[k + n] - win[k - n]) * 0.5) * 0.5;
        const e = t[o] - (win[k] - mean);
        gxx += mx * mx;
        gxy += mx * my;
        gyy += my * my;
        bx += e * mx;
        by += e * my;
      }
    }
    const det = gxx * gyy - gxy * gxy;
    if (det < 1e-6) return -1;
    const invDet = 1 / det;
    const sx = (gyy * bx - gxy * by) * invDet;
    const sy = (gxx * by - gxy * bx) * invDet;
    x += sx;
    y += sy;
    if (sx * sx + sy * sy < eps * eps) break;
  }

  // Correlation at the final position — the acceptance test.
  const mean = sampleWindow(img, x, y, r);
  if (mean !== mean) return -1;
  let dot = 0;
  let wn = 0;
  for (let yy = 0; yy < m; yy++) {
    for (let xx = 0; xx < m; xx++) {
      const v = win[(yy + 1) * n + (xx + 1)] - mean;
      dot += v * t[yy * m + xx];
      wn += v * v;
    }
  }
  out[0] = x;
  out[1] = y;
  const denom = patch.norm * Math.sqrt(wn);
  return denom > 1e-6 ? dot / denom : -1;
}

/* ------------------------------------------------------------------ */
/* BRIEF                                                               */
/* ------------------------------------------------------------------ */

/** The 256 comparison pairs, drawn once from a seeded Gaussian-ish spread. */
const BRIEF_PATTERN = (() => {
  const rng = makeRng(0x5eed1234);
  const gauss = () => {
    let s = 0;
    for (let i = 0; i < 4; i++) s += rng();
    return (s - 2) * (BRIEF_RADIUS / 2.2);
  };
  const p = new Int8Array(BRIEF_BITS * 4);
  for (let i = 0; i < BRIEF_BITS; i++) {
    let ax;
    let ay;
    let bx;
    let by;
    do {
      ax = Math.round(gauss());
      ay = Math.round(gauss());
      bx = Math.round(gauss());
      by = Math.round(gauss());
    } while (
      Math.abs(ax) > BRIEF_RADIUS || Math.abs(ay) > BRIEF_RADIUS ||
      Math.abs(bx) > BRIEF_RADIUS || Math.abs(by) > BRIEF_RADIUS ||
      (ax === bx && ay === by)
    );
    p[4 * i] = ax;
    p[4 * i + 1] = ay;
    p[4 * i + 2] = bx;
    p[4 * i + 3] = by;
  }
  return p;
})();

const BRIEF_WORDS = BRIEF_BITS / 32;

/** Descriptor of the (blurred) image at integer (x, y). Null too near an edge. */
export function briefDescriptor(img, x, y, out = new Uint32Array(BRIEF_WORDS)) {
  const w = img.width;
  const h = img.height;
  if (x < BRIEF_RADIUS || y < BRIEF_RADIUS || x >= w - BRIEF_RADIUS || y >= h - BRIEF_RADIUS) return null;
  const d = img.data;
  const base = y * w + x;
  const p = BRIEF_PATTERN;
  for (let word = 0; word < BRIEF_WORDS; word++) {
    let bits = 0;
    for (let b = 0; b < 32; b++) {
      const i = 4 * (word * 32 + b);
      const a = d[base + p[i + 1] * w + p[i]];
      const c = d[base + p[i + 3] * w + p[i + 2]];
      if (a < c) bits |= 1 << b;
    }
    out[word] = bits >>> 0;
  }
  return out;
}

function popcount32(v) {
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

export function hamming(a, ao, b, bo) {
  let n = 0;
  for (let i = 0; i < BRIEF_WORDS; i++) n += popcount32((a[ao + i] ^ b[bo + i]) >>> 0);
  return n;
}

/**
 * A bank of descriptors with their level-0 positions, laid out flat so the
 * brute-force match is one tight loop.
 */
class DescriptorBank {
  constructor(capacity) {
    this.desc = new Uint32Array(capacity * BRIEF_WORDS);
    this.pos = new Float64Array(capacity * 2);
    this.count = 0;
    this.capacity = capacity;
  }

  /** Describe every corner of `corners` on `img` (level `level`), scaling positions back to level 0. */
  add(img, corners, level) {
    const scale = 1 << level;
    const scratch = new Uint32Array(BRIEF_WORDS);
    for (let i = 0; i < corners.length / 2 && this.count < this.capacity; i++) {
      const x = Math.round(corners[2 * i]);
      const y = Math.round(corners[2 * i + 1]);
      if (!briefDescriptor(img, x, y, scratch)) continue;
      this.desc.set(scratch, this.count * BRIEF_WORDS);
      this.pos[2 * this.count] = x * scale;
      this.pos[2 * this.count + 1] = y * scale;
      this.count++;
    }
  }

  clear() {
    this.count = 0;
  }
}

/**
 * Match every descriptor of `query` to its nearest in `bank` (Hamming), with
 * Lowe's ratio against the second nearest. Returns pairs of (query index,
 * bank index).
 */
function matchBanks(query, bank) {
  const pairs = [];
  for (let q = 0; q < query.count; q++) {
    let best = Infinity;
    let second = Infinity;
    let bestIndex = -1;
    const qo = q * BRIEF_WORDS;
    for (let b = 0; b < bank.count; b++) {
      const dist = hamming(query.desc, qo, bank.desc, b * BRIEF_WORDS);
      if (dist < best) {
        second = best;
        best = dist;
        bestIndex = b;
      } else if (dist < second) {
        second = dist;
      }
    }
    if (bestIndex < 0 || best > BRIEF_MAX_HAMMING) continue;
    if (second < Infinity && best > second * BRIEF_RATIO) continue;
    pairs.push(q, bestIndex);
  }
  return pairs;
}

/* ------------------------------------------------------------------ */
/* Pose                                                                */
/* ------------------------------------------------------------------ */

/**
 * Focal length, in pixels, from a homography plane → image whose plane
 * coordinates are metric.
 *
 * With H = K [r1 r2 t] and K = diag(f, f, 1) about the principal point, the
 * two columns r1, r2 are orthonormal. Each of the two constraints
 * (r1 ⊥ r2, |r1| = |r2|) is linear in f², and both degenerate when the plane
 * is seen head-on, so they are combined in least squares and the `tilt` —
 * how much perspective there is across the frame, 0 for head-on — is
 * returned alongside, for the caller to decide whether to believe the number.
 *
 * @returns {{f: number, tilt: number}} f is NaN when hopeless
 */
export function estimateFocal(H, cx, cy) {
  // Shift the principal point to the origin: Hc = T · H with T = [1 0 -cx; 0 1 -cy; 0 0 1].
  const h1x = H[0] - cx * H[6];
  const h1y = H[3] - cy * H[6];
  const h1z = H[6];
  const h2x = H[1] - cx * H[7];
  const h2y = H[4] - cy * H[7];
  const h2z = H[7];

  // Perspective across the image, relative to the plane's scale on it.
  const scale = Math.hypot(h1x, h1y, h2x, h2y) / Math.SQRT2 || 1;
  const tilt = (Math.hypot(h1z, h2z) * 2 * Math.hypot(cx, cy)) / scale;

  // a · f² = b, twice.
  const a1 = h1z * h2z;
  const b1 = -(h1x * h2x + h1y * h2y);
  const a2 = h2z * h2z - h1z * h1z;
  const b2 = h1x * h1x + h1y * h1y - h2x * h2x - h2y * h2y;
  const denom = a1 * a1 + a2 * a2;
  if (denom < 1e-30) return { f: NaN, tilt };
  const f2 = (a1 * b1 + a2 * b2) / denom;
  return { f: f2 > 0 ? Math.sqrt(f2) : NaN, tilt };
}

/**
 * Decompose a plane → image homography into rotation and translation, for
 * a camera with focal `f` and principal point (cx, cy). The plane's points
 * are (X, Y, 0); the camera looks down +Z with y down, as a pinhole does.
 *
 * @returns {{R: Float64Array, t: Float64Array}} R row-major 3×3
 */
export function poseFromHomography(H, f, cx, cy, out = { R: new Float64Array(9), t: new Float64Array(3) }) {
  const invF = 1 / f;
  // K⁻¹ H, column by column.
  const c1 = [(H[0] - cx * H[6]) * invF, (H[3] - cy * H[6]) * invF, H[6]];
  const c2 = [(H[1] - cx * H[7]) * invF, (H[4] - cy * H[7]) * invF, H[7]];
  const c3 = [(H[2] - cx * H[8]) * invF, (H[5] - cy * H[8]) * invF, H[8]];

  const n1 = Math.hypot(c1[0], c1[1], c1[2]);
  const n2 = Math.hypot(c2[0], c2[1], c2[2]);
  let lambda = 2 / (n1 + n2);
  // The plane has to be in front of the camera: positive depth at its origin.
  if (c3[2] * lambda < 0) lambda = -lambda;

  const r1 = [c1[0] * lambda, c1[1] * lambda, c1[2] * lambda];
  const r2 = [c2[0] * lambda, c2[1] * lambda, c2[2] * lambda];
  const t = [c3[0] * lambda, c3[1] * lambda, c3[2] * lambda];

  // Symmetric orthonormalisation: split the error evenly between r1 and r2
  // rather than trusting either one.
  normalize3(r1);
  normalize3(r2);
  const c = [r1[0] + r2[0], r1[1] + r2[1], r1[2] + r2[2]];
  normalize3(c);
  const p = cross3(r1, r2);
  normalize3(p);
  const d = cross3(c, p);
  normalize3(d);
  const s = Math.SQRT1_2;
  const R1 = [(c[0] + d[0]) * s, (c[1] + d[1]) * s, (c[2] + d[2]) * s];
  const R2 = [(c[0] - d[0]) * s, (c[1] - d[1]) * s, (c[2] - d[2]) * s];
  const R3 = cross3(R1, R2);

  const R = out.R;
  R[0] = R1[0]; R[1] = R2[0]; R[2] = R3[0];
  R[3] = R1[1]; R[4] = R2[1]; R[5] = R3[1];
  R[6] = R1[2]; R[7] = R2[2]; R[8] = R3[2];
  out.t[0] = t[0];
  out.t[1] = t[1];
  out.t[2] = t[2];
  return out;
}

function normalize3(v) {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  v[0] /= n;
  v[1] /= n;
  v[2] /= n;
  return v;
}

function cross3(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/* ------------------------------------------------------------------ */
/* The tracker                                                         */
/* ------------------------------------------------------------------ */

/**
 * Order four corners consistently: about their centroid, by angle, which in
 * image coordinates (y down) walks them clockwise as seen on screen. The
 * tracker does not care, but the pose does: this winding is what puts the
 * plane's normal toward the camera.
 */
export function orderQuad(quad) {
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < 4; i++) {
    cx += quad[2 * i];
    cy += quad[2 * i + 1];
  }
  cx /= 4;
  cy /= 4;
  const order = [0, 1, 2, 3].sort(
    (a, b) => Math.atan2(quad[2 * a + 1] - cy, quad[2 * a] - cx) - Math.atan2(quad[2 * b + 1] - cy, quad[2 * b] - cx)
  );
  // Start from the corner nearest the top-left, so the order is stable
  // between two selections of the same rectangle.
  let start = 0;
  let best = Infinity;
  for (let k = 0; k < 4; k++) {
    const i = order[k];
    const score = quad[2 * i] + quad[2 * i + 1];
    if (score < best) {
      best = score;
      start = k;
    }
  }
  const out = new Float64Array(8);
  for (let k = 0; k < 4; k++) {
    const i = order[(start + k) % 4];
    out[2 * k] = quad[2 * i];
    out[2 * k + 1] = quad[2 * i + 1];
  }
  return out;
}

export class PlanarTracker {
  constructor() {
    this.ref = null;
    this.refQuad = null;
    this.refBank = new DescriptorBank(600);
    this.refBlur = null;

    this.prev = null;
    this.cur = null;
    /** Two pyramids alternate between "previous" and "current", so nothing
     *  above level 0 is allocated per frame. */
    this._pyrs = [null, null];
    this._slot = 0;

    /** Reference positions, current positions, and bookkeeping, per feature. */
    this.refPos = new Float64Array(MAX_FEATURES * 2);
    this.curPos = new Float64Array(MAX_FEATURES * 2);
    this.pred = new Float64Array(MAX_FEATURES * 2);
    this.tracked = new Uint8Array(MAX_FEATURES);
    this.misses = new Uint8Array(MAX_FEATURES);
    this.count = 0;

    this.H = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    this.Hprev = new Float64Array(9);
    this.Hinv = new Float64Array(9);
    this.quad = new Float64Array(8);
    this.lost = true;
    this.frame = 0;
    this.inliers = 0;
    this.rng = makeRng(0xc0ffee);

    this._patch = new Patch(Math.max(LK_RADIUS, SNAP_RADIUS));
    this._out = new Float64Array(2);
    this._idx = new Int32Array(MAX_FEATURES);
    this._queryBank = new DescriptorBank(400);
    this._curBlur = null;
    this._sinceRefill = 0;
  }

  /**
   * Adopt `gray` as the reference frame and `quad` (8 numbers, any order) as
   * the plane. Detects the features and builds the re-detection bank.
   * @returns {number} how many features were found; under a dozen is unusable
   */
  setReference(gray, quad) {
    // A private copy: the caller is free to reuse its buffer for the frames
    // that follow, and the reference has to outlive all of them.
    const copy = new GrayImage(gray.width, gray.height, Float32Array.from(gray.data));
    this.ref = buildPyramid(copy, LEVELS);
    gray = copy;
    this.refQuad = orderQuad(quad);
    this.count = 0;
    this.lost = false;
    this.frame = 0;
    this._sinceRefill = 0;
    this.H.set([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    this.Hprev.set(this.H);
    this.quad.set(this.refQuad);

    const corners = detectCorners(gray, { quad: this.refQuad, max: MAX_FEATURES, border: LK_RADIUS + 2 });
    for (let i = 0; i < corners.length / 2; i++) this._addFeature(corners[2 * i], corners[2 * i + 1], corners[2 * i], corners[2 * i + 1]);

    // The bank: corners at three scales of the reference, described on the
    // blurred image of each, positions in level-0 pixels.
    this.refBank.clear();
    for (let level = 0; level < Math.min(3, this.ref.length); level++) {
      const img = this.ref[level];
      const scale = 1 << level;
      const q = new Float64Array(8);
      for (let i = 0; i < 8; i++) q[i] = this.refQuad[i] / scale;
      const blurred = blur5(img);
      const found = detectCorners(img, { quad: q, max: level === 0 ? 300 : 150, minDistance: 6, quality: 0.01, border: BRIEF_RADIUS + 1 });
      this.refBank.add(blurred, found, level);
    }

    this.prev = this.ref;
    return this.count;
  }

  _addFeature(rx, ry, x, y) {
    if (this.count >= MAX_FEATURES) return false;
    const i = this.count++;
    this.refPos[2 * i] = rx;
    this.refPos[2 * i + 1] = ry;
    this.curPos[2 * i] = x;
    this.curPos[2 * i + 1] = y;
    this.tracked[i] = 1;
    this.misses[i] = 0;
    return true;
  }

  _removeFeature(i) {
    const last = this.count - 1;
    if (i !== last) {
      this.refPos[2 * i] = this.refPos[2 * last];
      this.refPos[2 * i + 1] = this.refPos[2 * last + 1];
      this.curPos[2 * i] = this.curPos[2 * last];
      this.curPos[2 * i + 1] = this.curPos[2 * last + 1];
      this.tracked[i] = this.tracked[last];
      this.misses[i] = this.misses[last];
    }
    this.count = last;
  }

  /**
   * Track one frame.
   *
   * `gray` becomes level 0 of this frame's pyramid *by reference* and is read
   * again on the next call as the previous frame, so the caller must hand in
   * a different buffer each time (two, alternating, is enough).
   *
   * @param {GrayImage} gray level-0 image, same size as the reference
   * @returns {{ok: boolean, lost: boolean, H: Float64Array, quad: Float64Array, inliers: number, total: number}}
   */
  track(gray) {
    if (!this.ref) return this._result(false);
    this.frame++;

    this._slot ^= 1;
    const cur = buildPyramid(gray, LEVELS, this._pyrs[this._slot]);
    this._pyrs[this._slot] = cur;
    this.cur = cur;

    let ok;
    if (this.lost) {
      ok = this._recover(cur);
    } else {
      ok = this._follow(cur);
    }

    if (ok) {
      ok = this._snapAndRefit(cur);
    }

    if (!ok) {
      this.lost = true;
      this.inliers = 0;
    } else {
      this.lost = false;
      this._maintain(cur);
    }

    this.prev = cur;
    return this._result(ok);
  }

  _result(ok) {
    return { ok, lost: this.lost, H: this.H, quad: this.quad, inliers: this.inliers, total: this.count };
  }

  /** Step 2 & 3: frame-to-frame LK from the prediction, then a first RANSAC. */
  _follow(cur) {
    const prev = this.prev;
    const patch = this._patch;
    const out = this._out;
    const levels = Math.min(cur.length, prev.length);
    const top = levels - 1;

    // Constant velocity in the homography group: Hpred = H · Hprev⁻¹ · H.
    const Hpred = _predH;
    const HprevInv = invH(this.Hprev, _tmpH);
    if (HprevInv) {
      mulH(this.H, HprevInv, _tmp2H);
      mulH(_tmp2H, this.H, Hpred);
      normalizeH(Hpred);
    } else {
      Hpred.set(this.H);
    }

    let tracked = 0;
    for (let i = 0; i < this.count; i++) {
      const rx = this.refPos[2 * i];
      const ry = this.refPos[2 * i + 1];
      const w = projectH(Hpred, rx, ry, this.pred, 2 * i);
      if (w <= 1e-9 || !Number.isFinite(this.pred[2 * i])) {
        // A wild prediction: fall back on the last homography.
        projectH(this.H, rx, ry, this.pred, 2 * i);
      }
      if (!this.tracked[i]) continue;

      // Coarse to fine, the displacement initialised from the prediction.
      const px = this.curPos[2 * i];
      const py = this.curPos[2 * i + 1];
      let x = this.pred[2 * i] / (1 << top);
      let y = this.pred[2 * i + 1] / (1 << top);
      let good = true;
      for (let level = top; level >= 0; level--) {
        const scale = 1 << level;
        if (!patch.build(prev[level], px / scale, py / scale, LK_RADIUS)) {
          good = false;
          break;
        }
        const ncc = lkAlign(patch, cur[level], x, y, out);
        if (ncc < 0) {
          good = false;
          break;
        }
        x = out[0];
        y = out[1];
        if (level > 0) {
          x *= 2;
          y *= 2;
        }
      }
      if (good) {
        // Forward-backward: track it home again at full resolution and see
        // whether it lands where it started.
        if (patch.build(cur[0], x, y, LK_RADIUS)) {
          const ncc = lkAlign(patch, prev[0], px, py, out, 6);
          if (ncc < 0 || Math.hypot(out[0] - px, out[1] - py) > FB_THRESHOLD) good = false;
        } else {
          good = false;
        }
      }
      if (good) {
        this.curPos[2 * i] = x;
        this.curPos[2 * i + 1] = y;
        this.tracked[i] = 1;
        tracked++;
      } else {
        this.tracked[i] = 0;
      }
    }
    if (tracked < MIN_INLIERS) return false;

    let n = 0;
    for (let i = 0; i < this.count; i++) if (this.tracked[i]) this._idx[n++] = i;
    const fit = ransacHomography(this.refPos, this.curPos, this._idx, n, { rng: this.rng, minInliers: MIN_INLIERS });
    if (!fit) return false;
    this.Hprev.set(this.H);
    this.H.set(fit.H);
    for (let i = 0; i < this.count; i++) this.tracked[i] = fit.inliers[i];
    return true;
  }

  /** Step 4 & 5: pull every feature onto the reference, refit. */
  _snapAndRefit(cur) {
    const patch = this._patch;
    const out = this._out;
    if (!invH(this.H, this.Hinv)) return false;
    const w0 = cur[0].width;
    const h0 = cur[0].height;

    let n = 0;
    for (let i = 0; i < this.count; i++) {
      const rx = this.refPos[2 * i];
      const ry = this.refPos[2 * i + 1];
      // Where the homography says the feature is. The template is anchored
      // *here*, because H⁻¹ of this point is the feature's own reference
      // position: the patch is the reference around p_i, warped to look as
      // it should now. Anchoring on the tracked estimate instead would
      // re-register whatever happens to be under it — and never move.
      projectH(this.H, rx, ry, out);
      const cx = out[0];
      const cy = out[1];
      // The search starts from the tracked position when there is one.
      const x = this.tracked[i] ? this.curPos[2 * i] : cx;
      const y = this.tracked[i] ? this.curPos[2 * i + 1] : cy;
      const margin = SNAP_RADIUS + 2;
      if (!(cx > margin && cy > margin && cx < w0 - margin && cy < h0 - margin)) {
        // Off screen: not a miss, just not visible.
        this.tracked[i] = 0;
        continue;
      }

      // Level 1 first for a wider basin, then level 0 for the precision.
      let good = true;
      let sx = x;
      let sy = y;
      for (let level = Math.min(1, cur.length - 1); level >= 0; level--) {
        const scale = 1 << level;
        // Warp: (current level px) → (reference level px). Hinv is in level-0
        // units on both sides, so scale in and out around it.
        const Hl = _levelH;
        for (let k = 0; k < 9; k++) Hl[k] = this.Hinv[k];
        // S⁻¹ · Hinv · S with S = diag(scale, scale, 1): scales columns 0,1 by
        // `scale` and rows 0,1 by 1/scale — entries 6,7 gain a factor scale.
        Hl[2] /= scale;
        Hl[5] /= scale;
        Hl[6] *= scale;
        Hl[7] *= scale;
        if (!patch.build(this.ref[level], cx / scale, cy / scale, SNAP_RADIUS, Hl)) {
          good = false;
          break;
        }
        const ncc = lkAlign(patch, cur[level], sx / scale, sy / scale, out, 8);
        if (ncc < SNAP_NCC) {
          good = false;
          break;
        }
        sx = out[0] * scale;
        sy = out[1] * scale;
      }
      if (good && Math.hypot(sx - cx, sy - cy) < 6) {
        this.curPos[2 * i] = sx;
        this.curPos[2 * i + 1] = sy;
        this.tracked[i] = 1;
        this._idx[n++] = i;
      } else if (this.tracked[i]) {
        // The frame-to-frame track stands, unverified, and counts as a miss
        // against the feature: too many and it is somebody else's corner.
        this._idx[n++] = i;
        this.misses[i]++;
      } else {
        this.misses[i]++;
      }
    }
    if (n < MIN_INLIERS) return false;

    const fit = ransacHomography(this.refPos, this.curPos, this._idx, n, { rng: this.rng, minInliers: MIN_INLIERS });
    if (!fit) return false;
    this.H.set(fit.H);
    this.inliers = fit.n;
    for (let i = 0; i < this.count; i++) {
      if (fit.inliers[i]) {
        this.tracked[i] = 1;
        this.misses[i] = 0;
      } else if (this.tracked[i]) {
        this.tracked[i] = 0;
        this.misses[i]++;
      }
    }

    for (let i = 0; i < 4; i++) projectH(this.H, this.refQuad[2 * i], this.refQuad[2 * i + 1], this.quad, 2 * i);
    return quadSane(this.quad);
  }

  /** Drop dead features; refill inside the quad when it has gone thin. */
  _maintain(cur) {
    for (let i = this.count - 1; i >= 0; i--) {
      if (this.misses[i] > MAX_MISSES) this._removeFeature(i);
    }
    this._sinceRefill++;
    if (this.inliers >= REFILL_BELOW || this._sinceRefill < 3) return;
    this._sinceRefill = 0;

    const fresh = detectCorners(cur[0], {
      quad: this.quad,
      max: MAX_FEATURES - this.count,
      border: LK_RADIUS + 2,
      occupied: this.curPos,
      occupiedCount: this.count
    });
    for (let i = 0; i < fresh.length / 2; i++) {
      const x = fresh[2 * i];
      const y = fresh[2 * i + 1];
      const w = projectH(this.Hinv, x, y, this._out);
      if (w <= 1e-9) continue;
      const rx = this._out[0];
      const ry = this._out[1];
      if (!insideQuad(this.refQuad, rx, ry)) continue;
      const border = LK_RADIUS + 2;
      if (rx < border || ry < border || rx > this.ref[0].width - border || ry > this.ref[0].height - border) continue;
      if (!this._addFeature(rx, ry, x, y)) break;
    }
  }

  /** Lost: describe fresh corners and look for the plane in the bank. */
  _recover(cur) {
    if (this.frame % RECOVER_EVERY !== 0) return false;
    const attempts = [
      [0, 0],
      [1, 0],
      [2, 0]
    ];
    for (const [level] of attempts) {
      if (level >= cur.length) continue;
      const img = cur[level];
      const scale = 1 << level;
      const blurred = blur5(img, level === 0 ? this._curBlur : null);
      if (level === 0) this._curBlur = blurred;
      const corners = detectCorners(img, { max: level === 0 ? 350 : 180, minDistance: 6, quality: 0.006, border: BRIEF_RADIUS + 1 });
      if (corners.length < 2 * MIN_INLIERS) continue;
      this._queryBank.clear();
      this._queryBank.add(blurred, corners, level);
      const pairs = matchBanks(this._queryBank, this.refBank);
      const n = pairs.length / 2;
      if (n < RECOVER_MIN_INLIERS) continue;

      const src = new Float64Array(2 * n);
      const dst = new Float64Array(2 * n);
      for (let k = 0; k < n; k++) {
        const q = pairs[2 * k];
        const b = pairs[2 * k + 1];
        src[2 * k] = this.refBank.pos[2 * b];
        src[2 * k + 1] = this.refBank.pos[2 * b + 1];
        dst[2 * k] = this._queryBank.pos[2 * q];
        dst[2 * k + 1] = this._queryBank.pos[2 * q + 1];
      }
      const fit = ransacHomography(src, dst, null, n, {
        threshold: RECOVER_THRESHOLD * scale,
        maxIter: 400,
        rng: this.rng,
        minInliers: RECOVER_MIN_INLIERS
      });
      if (!fit) continue;
      const quad = new Float64Array(8);
      for (let i = 0; i < 4; i++) projectH(fit.H, this.refQuad[2 * i], this.refQuad[2 * i + 1], quad, 2 * i);
      if (!quadSane(quad)) continue;

      // Re-seed: the matched inliers become the tracked set, and the snap
      // that follows verifies each of them against the reference.
      this.count = 0;
      for (let k = 0; k < n && this.count < MAX_FEATURES; k++) {
        if (!fit.inliers[k]) continue;
        this._addFeature(src[2 * k], src[2 * k + 1], dst[2 * k], dst[2 * k + 1]);
      }
      this.H.set(fit.H);
      this.Hprev.set(fit.H);
      this._sinceRefill = 99;
      return true;
    }
    return false;
  }
}

const _predH = new Float64Array(9);
const _tmp2H = new Float64Array(9);
const _levelH = new Float64Array(9);
