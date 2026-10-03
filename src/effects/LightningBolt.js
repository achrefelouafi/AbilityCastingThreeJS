import { BufferAttribute, BufferGeometry, Mesh, Vector3 } from 'three';
import { LAYER } from '../core/Layers.js';

/** Points on the main channel: 2^5 + 1, so midpoint displacement fills it exactly. */
const MAIN = 33;
/** Points on each fork: 2^3 + 1. */
const FORK = 9;
const MAX_FORKS = 4;
const MAX_POINTS = MAIN + FORK * MAX_FORKS;

const _a = new Vector3();
const _b = new Vector3();
const _t = new Vector3();
const _v = new Vector3();
const _s = new Vector3();
const _d = new Vector3();
const _r = new Vector3();

/** A random unit vector perpendicular to `axis` (unit). */
function perpendicular(axis, out) {
  out.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
  out.addScaledVector(axis, -out.dot(axis));
  if (out.lengthSq() < 1e-8) out.set(axis.y, -axis.x, 0);
  return out.normalize();
}

/**
 * Fill `pts[start .. start+count-1]` with a jagged channel from `a` to `b`.
 *
 * Midpoint displacement: halve every span, push the new point off the line by
 * a random perpendicular, and shrink the push each level. The result has the
 * self-similar kinks of a real discharge — big doglegs, and smaller ones on
 * those. `arch` bows the whole channel along `bow` so a bolt fired from on high
 * leaves the core outward before it falls, instead of as a ruler line.
 */
function channel(pts, start, count, a, b, jag, arch, bow) {
  const last = start + count - 1;
  pts[start].copy(a);
  pts[last].copy(b);
  _d.subVectors(b, a);
  const length = _d.length();
  _d.multiplyScalar(1 / Math.max(1e-6, length));

  let disp = length * jag;
  for (let size = count - 1; size > 1; size >>= 1) {
    const half = size >> 1;
    for (let i = half; i < count - 1; i += size) {
      const p = pts[start + i];
      p.addVectors(pts[start + i - half], pts[start + i + half]).multiplyScalar(0.5);
      perpendicular(_d, _r);
      p.addScaledVector(_r, (Math.random() - 0.5) * 2 * disp);
    }
    disp *= 0.55;
  }

  if (arch !== 0) {
    for (let i = 1; i < count - 1; i++) {
      const u = i / (count - 1);
      pts[start + i].addScaledVector(bow, Math.sin(u * Math.PI) * arch * length);
    }
  }
}

/**
 * One lightning bolt: a jagged channel and its forks, drawn as a ribbon that
 * always faces the camera.
 *
 * The life of a strike, the way a high-speed camera sees one:
 *
 *   1. **The leader.** The channel is drawn from the source to the mark over
 *      `leader` seconds — the head of it burning hotter than the rest.
 *   2. **The return stroke** and **re-strikes.** For `restrikes` beats the
 *      whole path is thrown away and solved again from the same two ends, and
 *      its brightness jumps; that is the flicker the eye reads as *electric*
 *      rather than as a laser.
 *   3. **The fade.** The last path holds and dies away.
 *
 * Owners hold a pool of these and call `fire`; `update` does the rest and
 * hides it when it is done. The geometry is a fixed buffer filled in place —
 * nothing is allocated after construction.
 */
export class LightningBolt {
  /** @param {import('three').ShaderMaterial} material — one per bolt; it carries the fade. */
  constructor(material) {
    this.material = material;
    this.points = [];
    for (let i = 0; i < MAX_POINTS; i++) this.points.push(new Vector3());
    /** Each strip: [start, count, width scale, brightness]. */
    this.strips = [];
    for (let i = 0; i < 1 + MAX_FORKS; i++) this.strips.push({ start: 0, count: 0, width: 1, bright: 1 });
    this.stripCount = 0;

    const verts = MAX_POINTS * 2;
    this.position = new BufferAttribute(new Float32Array(verts * 3), 3);
    this.uv = new BufferAttribute(new Float32Array(verts * 2), 2);
    this.bright = new BufferAttribute(new Float32Array(verts), 1);
    // The layout is fixed — the main channel, then each fork in its own slot —
    // so one index buffer serves every shape: quads between neighbours inside a
    // strip, and none bridging one strip to the next.
    const index = [];
    const quads = (start, count) => {
      for (let i = start; i < start + count - 1; i++) {
        const a = i * 2;
        index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    };
    quads(0, MAIN);
    for (let f = 0; f < MAX_FORKS; f++) quads(MAIN + f * FORK, FORK);
    this.geometry = new BufferGeometry();
    this.geometry.setAttribute('position', this.position);
    this.geometry.setAttribute('aUv', this.uv);
    this.geometry.setAttribute('aBright', this.bright);
    this.geometry.setIndex(index);

    this.mesh = new Mesh(this.geometry, material);
    this.mesh.layers.set(LAYER.VFX);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 15;
    this.mesh.visible = false;
    this.mesh.matrixAutoUpdate = false;

    this.from = new Vector3();
    this.to = new Vector3();
    this.bow = new Vector3(0, 1, 0);
    this.alive = false;
    this.age = 0;
    this.opts = {
      width: 0.1,
      jag: 0.2,
      arch: 0,
      forks: 3,
      life: 0.4,
      leader: 0.05,
      restrikes: 3,
      restrikeRate: 22,
      intensity: 3
    };
    this._nextRestrike = 0;
    this._restrikesLeft = 0;
    this._flash = 1;
  }

  /**
   * @param {Vector3} from
   * @param {Vector3} to
   * @param {object} opts see `this.opts`; anything omitted keeps its last value
   * @param {Vector3} [bow] the direction it arches toward, unit
   */
  fire(from, to, opts, bow = null) {
    this.from.copy(from);
    this.to.copy(to);
    Object.assign(this.opts, opts);
    if (bow) this.bow.copy(bow);
    else this.bow.set(0, 1, 0);
    this.alive = true;
    this.age = 0;
    this._restrikesLeft = Math.max(0, Math.round(this.opts.restrikes));
    this._nextRestrike = this.opts.leader + 1 / Math.max(1, this.opts.restrikeRate);
    this._flash = 1;
    this._solve();
    this.mesh.visible = true;
  }

  kill() {
    this.alive = false;
    this.mesh.visible = false;
  }

  /** Throw the path away and draw a new one between the same two ends. */
  _solve() {
    const o = this.opts;
    const pts = this.points;
    channel(pts, 0, MAIN, this.from, this.to, o.jag, o.arch, this.bow);
    const main = this.strips[0];
    main.start = 0;
    main.count = MAIN;
    main.width = 1;
    main.bright = 1;
    this.stripCount = 1;

    const length = this.from.distanceTo(this.to);
    const forks = Math.min(MAX_FORKS, Math.max(0, Math.round(o.forks)));
    for (let f = 0; f < forks; f++) {
      const at = 5 + Math.floor(Math.random() * (MAIN - 12));
      _a.copy(pts[at]);
      _t.subVectors(pts[at + 1], pts[at - 1]).normalize();
      perpendicular(_t, _r);
      // Forks run on in roughly the same direction, kinked off it.
      _v.copy(_t).addScaledVector(_r, 0.6 + Math.random() * 0.7).normalize();
      const reach = length * (0.12 + Math.random() * 0.22) * (1 - at / MAIN * 0.5);
      _b.copy(_a).addScaledVector(_v, reach);
      const start = MAIN + f * FORK;
      channel(pts, start, FORK, _a, _b, o.jag * 1.3, 0, this.bow);
      const strip = this.strips[this.stripCount++];
      strip.start = start;
      strip.count = FORK;
      strip.width = 0.45 + Math.random() * 0.2;
      strip.bright = 0.4 + Math.random() * 0.25;
      strip.along = at / (MAIN - 1);
    }
    main.along = 0;
  }

  /**
   * @param {number} dt
   * @param {Vector3} eye the camera's world position — the ribbon faces it
   */
  update(dt, eye) {
    if (!this.alive) return;
    this.age += dt;
    const o = this.opts;

    if (this._restrikesLeft > 0 && this.age >= this._nextRestrike) {
      this._restrikesLeft--;
      this._nextRestrike += 1 / Math.max(1, o.restrikeRate);
      this._solve();
      this._flash = 0.65 + Math.random() * 0.7;
    }
    this._flash += (1 - this._flash) * Math.min(1, dt * 20);

    const life = Math.max(o.leader + 0.02, o.life);
    if (this.age >= life) {
      this.kill();
      return;
    }

    const head = Math.min(1, this.age / Math.max(1e-3, o.leader));
    const tail = Math.max(0, (this.age - o.life * 0.35) / (o.life * 0.65));
    const fade = (1 - tail * tail) * this._flash;

    const u = this.material.uniforms;
    u.uHead.value = head;
    u.uFade.value = fade;
    u.uIntensity.value = o.intensity;

    this._build(eye, o.width);
  }

  /** Lay the ribbon along the strips, turned to face `eye`. */
  _build(eye, width) {
    const pos = this.position.array;
    const uv = this.uv.array;
    const br = this.bright.array;
    const pts = this.points;

    let v = 0;
    for (let s = 0; s < this.stripCount; s++) {
      const strip = this.strips[s];
      const n = strip.count;
      for (let i = 0; i < n; i++) {
        const p = pts[strip.start + i];
        const prev = pts[strip.start + Math.max(0, i - 1)];
        const next = pts[strip.start + Math.min(n - 1, i + 1)];
        _t.subVectors(next, prev);
        _v.subVectors(eye, p);
        _s.crossVectors(_t, _v);
        const len = _s.length();
        if (len > 1e-8) _s.multiplyScalar(1 / len);
        else _s.set(1, 0, 0);

        const k = i / (n - 1);
        // The main channel narrows toward the mark; a fork tapers to nothing.
        const taper = s === 0 ? 1 - 0.35 * k : 1 - k * 0.9;
        const w = width * strip.width * taper;

        // A fork only exists once the leader has passed the point it leaves at.
        const along = s === 0 ? k : strip.along + k * 0.15;

        for (let side = -1; side <= 1; side += 2) {
          pos[v * 3 + 0] = p.x + _s.x * w * side;
          pos[v * 3 + 1] = p.y + _s.y * w * side;
          pos[v * 3 + 2] = p.z + _s.z * w * side;
          uv[v * 2 + 0] = along;
          uv[v * 2 + 1] = side;
          br[v] = strip.bright;
          v++;
        }
      }
    }

    this.position.needsUpdate = true;
    this.uv.needsUpdate = true;
    this.bright.needsUpdate = true;
    const forks = this.stripCount - 1;
    this.geometry.setDrawRange(0, ((MAIN - 1) + forks * (FORK - 1)) * 6);
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
