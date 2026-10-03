import {
  BufferAttribute,
  DataTexture,
  FloatType,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  NearestFilter,
  RGBAFormat,
  Sphere,
  Vector3,
  Vector4
} from 'three';

/**
 * The roots of the Wildroot Reliquary, and the leaves on them.
 *
 * A root is two halves that never meet on the CPU:
 *
 *  - **its curve**, solved here every frame (`CurveBank`): a handful of
 *    control points — the foot of the arch, the apex, the wrist a tendril is
 *    winding round — run through a Catmull-Rom, resampled to equal steps of
 *    arc length and given a parallel-transported frame, and written into one
 *    row of a float texture alongside the radius at that point. Sixty-four
 *    samples a curve, twenty-four curves, two rows each: position and radius,
 *    then the frame's normal.
 *  - **its skin**, which is nothing but a grid in parameter space — `u` along,
 *    `a` round — drawn instanced, one instance per *strand*. The vertex shader
 *    reads the curve it belongs to out of the texture, winds itself round the
 *    curve's centreline at its own phase and twist, and swells out to the
 *    radius. Three strands at thirds of a turn on the same curve is a braided
 *    root; one strand with no offset is a vine.
 *
 * That split is the whole reason a root can do what it does here. It grows
 * (the shader clamps `u` to the curve's growth and tapers the last stretch to
 * a point), it withers back into the floor (the same number, run backwards),
 * and a tendril can be wound round a forearm the solver moved this frame —
 * because the forearm is just three more control points, and the CPU writes
 * 64 texels where it would otherwise rebuild a mesh.
 *
 * The bounds mean nothing, since everything is placed in the vertex stage;
 * every mesh built on these sets `frustumCulled = false`.
 */

/** Samples along one curve in the texture. */
export const ROOT_SAMPLES = 64;
/** Curves one ability can be drawing at once. */
export const MAX_CURVES = 24;
/** Control points one curve may be given. */
const MAX_CONTROL = 48;
/** Dense steps the spline is evaluated at before it is resampled by length. */
const DENSE = 256;

const HUGE_BOUNDS = /* @__PURE__ */ new Sphere(new Vector3(), 1e4);

/**
 * The CPU side: curves in, a texture out.
 *
 * Nothing in here allocates after construction. A curve is written with
 * `begin(); point(); point(); … commit(index, …)`, and `state[index]` /
 * `look[index]` carry what the shader needs about it that is not a position:
 *
 *   - `state`: x growth 0..1 (how much of it is out of the floor), y wither
 *     0..1, z glow (sap light running up it), w length in metres;
 *   - `look`: x turns per metre the strands braid at (each strand's own
 *     `twist` is its handedness against this), y–w unused.
 */
export class CurveBank {
  constructor() {
    this.data = new Float32Array(ROOT_SAMPLES * MAX_CURVES * 2 * 4);
    this.texture = new DataTexture(this.data, ROOT_SAMPLES, MAX_CURVES * 2, RGBAFormat, FloatType);
    this.texture.minFilter = NearestFilter;
    this.texture.magFilter = NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;

    this.state = Array.from({ length: MAX_CURVES }, () => new Vector4());
    this.look = Array.from({ length: MAX_CURVES }, () => new Vector4());

    this._ctrl = new Float32Array(MAX_CONTROL * 3);
    this._count = 0;
    this._dense = new Float32Array((DENSE + 1) * 3);
    this._cum = new Float32Array(DENSE + 1);
    this._pos = new Float32Array(ROOT_SAMPLES * 3);
  }

  /** Start a new polyline. */
  begin() {
    this._count = 0;
  }

  /** Add a control point to the polyline being written. */
  point(x, y, z) {
    if (this._count >= MAX_CONTROL) return;
    const i = this._count * 3;
    this._ctrl[i] = x;
    this._ctrl[i + 1] = y;
    this._ctrl[i + 2] = z;
    this._count++;
  }

  /** `point` off a vector. */
  add(v) {
    this.point(v.x, v.y, v.z);
  }

  /**
   * Resample the polyline into curve `index`.
   *
   * @param {number} index
   * @param {number} r0 radius at the foot, metres
   * @param {number} r1 radius at the tip
   * @param {number} flare how much the foot swells (0 none) — a buttress
   * @param {number} bulge 0..1, knots along its length
   * @param {number} seed
   * @param {number} rx preferred normal at the foot (any vector not along it)
   * @param {number} ry
   * @param {number} rz
   * @returns {number} the curve's length, metres
   */
  commit(index, r0, r1, flare, bulge, seed, rx, ry, rz) {
    const n = this._count;
    const state = this.state[index];
    if (n < 2) {
      state.w = 0;
      return 0;
    }
    const c = this._ctrl;
    const d = this._dense;
    const cum = this._cum;

    /* ---- Catmull-Rom through the control points, densely ---- */
    const spans = n - 1;
    for (let k = 0; k <= DENSE; k++) {
      const t = (k / DENSE) * spans;
      const i = Math.min(spans - 1, Math.floor(t));
      const f = t - i;
      const i0 = Math.max(0, i - 1) * 3;
      const i1 = i * 3;
      const i2 = (i + 1) * 3;
      const i3 = Math.min(n - 1, i + 2) * 3;
      const f2 = f * f;
      const f3 = f2 * f;
      for (let a = 0; a < 3; a++) {
        const p0 = c[i0 + a];
        const p1 = c[i1 + a];
        const p2 = c[i2 + a];
        const p3 = c[i3 + a];
        d[k * 3 + a] =
          0.5 * (2 * p1 + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f2 + (-p0 + 3 * p1 - 3 * p2 + p3) * f3);
      }
      if (k === 0) cum[0] = 0;
      else {
        const dx = d[k * 3] - d[k * 3 - 3];
        const dy = d[k * 3 + 1] - d[k * 3 - 2];
        const dz = d[k * 3 + 2] - d[k * 3 - 1];
        cum[k] = cum[k - 1] + Math.sqrt(dx * dx + dy * dy + dz * dz);
      }
    }
    const L = Math.max(1e-4, cum[DENSE]);

    /* ---- resampled to equal steps of length ---- */
    const P = this._pos;
    let j = 0;
    for (let s = 0; s < ROOT_SAMPLES; s++) {
      const want = (s / (ROOT_SAMPLES - 1)) * L;
      while (j < DENSE - 1 && cum[j + 1] < want) j++;
      const span = Math.max(1e-6, cum[j + 1] - cum[j]);
      const f = Math.min(1, Math.max(0, (want - cum[j]) / span));
      for (let a = 0; a < 3; a++) P[s * 3 + a] = d[j * 3 + a] + (d[j * 3 + 3 + a] - d[j * 3 + a]) * f;
    }

    /* ---- a parallel-transported frame, and the radius ---- */
    const data = this.data;
    const rowP = index * 2 * ROOT_SAMPLES * 4;
    const rowN = rowP + ROOT_SAMPLES * 4;
    let nx = rx;
    let ny = ry;
    let nz = rz;
    for (let s = 0; s < ROOT_SAMPLES; s++) {
      const a = Math.max(0, s - 1) * 3;
      const b = Math.min(ROOT_SAMPLES - 1, s + 1) * 3;
      let tx = P[b] - P[a];
      let ty = P[b + 1] - P[a + 1];
      let tz = P[b + 2] - P[a + 2];
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl;
      ty /= tl;
      tz /= tl;
      // Project the last normal off the new tangent: transport without twist.
      const dot = nx * tx + ny * ty + nz * tz;
      nx -= tx * dot;
      ny -= ty * dot;
      nz -= tz * dot;
      let nl = Math.hypot(nx, ny, nz);
      if (nl < 1e-4) {
        // The reference lay along the curve; any perpendicular will do.
        nx = -tz;
        ny = 0;
        nz = tx;
        nl = Math.hypot(nx, ny, nz);
        if (nl < 1e-4) {
          nx = 1;
          ny = 0;
          nz = 0;
          nl = 1;
        }
      }
      nx /= nl;
      ny /= nl;
      nz /= nl;

      const u = s / (ROOT_SAMPLES - 1);
      const m = u * L;
      let r = r0 + (r1 - r0) * Math.pow(u, 0.7);
      r *= 1 + flare * Math.exp(-m * 2.2);
      r *= 1 + bulge * (0.6 * Math.sin(m * 2.3 + seed) + 0.4 * Math.sin(m * 5.7 + seed * 2.1));

      const o = rowP + s * 4;
      data[o] = P[s * 3];
      data[o + 1] = P[s * 3 + 1];
      data[o + 2] = P[s * 3 + 2];
      data[o + 3] = Math.max(0.002, r);
      const q = rowN + s * 4;
      data[q] = nx;
      data[q + 1] = ny;
      data[q + 2] = nz;
      data[q + 3] = 0;
    }
    state.w = L;
    this.texture.needsUpdate = true;
    return L;
  }

  /**
   * Where along curve `index` a point `u` is, read back off the texture —
   * for the effects that hang off a root (sparks at a growing tip, leaves
   * shaken off a withering one).
   */
  sample(index, u, out) {
    const x = Math.min(1, Math.max(0, u)) * (ROOT_SAMPLES - 1);
    const i0 = Math.floor(x);
    const i1 = Math.min(ROOT_SAMPLES - 1, i0 + 1);
    const f = x - i0;
    const row = index * 2 * ROOT_SAMPLES * 4;
    const a = row + i0 * 4;
    const b = row + i1 * 4;
    const d = this.data;
    return out.set(d[a] + (d[b] - d[a]) * f, d[a + 1] + (d[b + 1] - d[a + 1]) * f, d[a + 2] + (d[b + 2] - d[a + 2]) * f);
  }

  /** The radius at `u` along curve `index`. */
  radius(index, u) {
    const i = Math.round(Math.min(1, Math.max(0, u)) * (ROOT_SAMPLES - 1));
    return this.data[index * 2 * ROOT_SAMPLES * 4 + i * 4 + 3];
  }

  /** Take a curve off the stage: no growth, no length. */
  hide(index) {
    this.state[index].set(0, 0, 0, 0);
  }
}

/**
 * A grid of quads in parameter space: `rows` along, `columns` across.
 * The position attribute carries (along 0..1, across 0..1, 0).
 */
function parameterGrid(rows, columns, acrossFrom = 0, acrossTo = 1) {
  const positions = new Float32Array(rows * columns * 3);
  let v = 0;
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < columns; j++) {
      positions[v++] = i / (rows - 1);
      positions[v++] = acrossFrom + ((acrossTo - acrossFrom) * j) / (columns - 1);
      positions[v++] = 0;
    }
  }
  const indices = new Uint16Array((rows - 1) * (columns - 1) * 6);
  let k = 0;
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < columns - 1; j++) {
      const a = i * columns + j;
      const b = a + 1;
      const c = a + columns;
      const d = c + 1;
      indices[k++] = a;
      indices[k++] = c;
      indices[k++] = b;
      indices[k++] = b;
      indices[k++] = c;
      indices[k++] = d;
    }
  }
  return { positions, indices };
}

/**
 * The skin of every strand of every root, in one draw.
 *
 * @param {{curve: number, phase: number, radius: number, offset: number,
 *          twist: number, seed: number, kind: number}[]} strands
 *   `radius` is the strand's own thickness as a share of the curve's,
 *   `offset` how far off the centreline it winds (same unit), `twist` its
 *   handedness (±1, scaled by the curve's turns per metre), `kind` 0 bark,
 *   1 vine.
 */
export function createRootGeometry(strands, rows = 112, columns = 12) {
  const { positions, indices } = parameterGrid(rows, columns);
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));

  const a = new Float32Array(strands.length * 4);
  const b = new Float32Array(strands.length * 4);
  strands.forEach((s, i) => {
    a.set([s.curve, s.phase, s.radius, s.offset], i * 4);
    b.set([s.twist, s.seed, s.kind, 0], i * 4);
  });
  geometry.setAttribute('aStrand', new InstancedBufferAttribute(a, 4));
  geometry.setAttribute('aStrand2', new InstancedBufferAttribute(b, 4));
  geometry.instanceCount = strands.length;
  geometry.boundingSphere = HUGE_BOUNDS;
  return geometry;
}

/**
 * Leaves: a narrow blade in parameter space — `along` 0..1 from the stalk,
 * `across` −1..1 — instanced along the roots.
 *
 * @param {{curve: number, u: number, angle: number, size: number,
 *          tilt: number, droop: number, seed: number, hue: number}[]} leaves
 */
export function createLeafGeometry(leaves) {
  const { positions, indices } = parameterGrid(7, 3, -1, 1);
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));

  const a = new Float32Array(leaves.length * 4);
  const b = new Float32Array(leaves.length * 4);
  leaves.forEach((l, i) => {
    a.set([l.curve, l.u, l.angle, l.size], i * 4);
    b.set([l.tilt, l.droop, l.seed, l.hue], i * 4);
  });
  geometry.setAttribute('aLeaf', new InstancedBufferAttribute(a, 4));
  geometry.setAttribute('aLeaf2', new InstancedBufferAttribute(b, 4));
  geometry.instanceCount = leaves.length;
  geometry.boundingSphere = HUGE_BOUNDS;
  return geometry;
}
