import { Matrix4, Mesh, PlaneGeometry, Quaternion, Vector3, Vector4 } from 'three';
import { Ability } from './Ability.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { DecalType } from '../effects/GroundDecals.js';
import { buildReliquaryRig } from '../assets/ReliquaryRig.js';
import { CurveBank, MAX_CURVES, ROOT_SAMPLES, createLeafGeometry, createRootGeometry } from '../assets/RootGeometry.js';
import {
  createAuraMaterial,
  createBarkMaterial,
  createLeafMaterial,
  createSigilMaterial,
  createStoneMaterial
} from '../materials/ReliquaryMaterials.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { Easing, clamp, saturate, smoothstep } from '../utils/math.js';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

/* ---- which curve is which ---- */
const MAIN = 0; // the two great roots of the arch, 0 and 1
const VINE = 2; // two vines wound round each, 2–5
const CURL = 6; // four curling tendrils off each, 6–13
const GROUND = 14; // roots crawling out from the feet, 14–17
const BIND = 18; // the four that take the body, 18–21
const SAPLING = 22; // what is left
const N_CURLS = 8;
const N_GROUND = 4;

/** Stones the halo can hold. The settings clamp to these. */
const MAX_SLABS = 5;
const MAX_CUBES = 16;

/**
 * The limbs the binding tendrils take: the pin is the joint held, the coil is
 * wound between `from` and `to`.
 */
const LIMBS = [
  { pin: 'LeftHand', from: 'LeftForeArm', to: 'LeftHand', arm: true },
  { pin: 'RightHand', from: 'RightForeArm', to: 'RightHand', arm: true },
  { pin: 'LeftFoot', from: 'LeftLeg', to: 'LeftFoot', arm: false },
  { pin: 'RightFoot', from: 'RightLeg', to: 'RightFoot', arm: false }
];

/**
 * The great root's line, in units of the arch: x across (of `archSpan`), y up
 * (of `archHeight`). It starts under the floor, climbs its own side, crosses
 * the apex and comes partway down the far side, where the other root has come
 * up — so the two twine over the top the way the reference's do.
 */
const ARCH_SHAPE = [
  [-1.06, -0.14],
  [-1.0, 0.03],
  [-0.96, 0.24],
  [-0.84, 0.5],
  [-0.6, 0.76],
  [-0.26, 0.95],
  [0.08, 1.0],
  [0.38, 0.91],
  [0.58, 0.74],
  [0.67, 0.58],
  [0.64, 0.47]
];

const UP = new Vector3(0, 1, 0);
const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _d = new Vector3();
const _e = new Vector3();
const _n = new Vector3();
const _t = new Vector3();
const _u = new Vector3();
const _v = new Vector3();
const _p = new Vector3();
const _q = new Quaternion();
const _qz = new Quaternion();
const _qx = new Quaternion();
const _m = new Matrix4();
const _axisZ = new Vector3(0, 0, 1);
const _axisX = new Vector3(1, 0, 0);
const _emit = {
  position: new Vector3(),
  direction: new Vector3(),
  inherit: null,
  radius: 0,
  speed: 1,
  speedVariance: 0.3,
  spread: 0.5,
  size: 0.2,
  sizeVariance: 0.3,
  life: 1,
  lifeVariance: 0.3,
  spin: 0,
  tint: null,
  time: 0
};

/** Reset the emit record to a neutral state, so no field leaks from the last burst. */
function emitAt(position, direction) {
  _emit.position.copy(position);
  _emit.direction.copy(direction);
  _emit.radius = 0;
  _emit.speed = 1;
  _emit.speedVariance = 0.4;
  _emit.spread = 0.5;
  _emit.size = 0.1;
  _emit.sizeVariance = 0.4;
  _emit.life = 1;
  _emit.lifeVariance = 0.3;
  _emit.spin = 0;
  _emit.tint = null;
  _emit.time = frame.uTime.value;
  return _emit;
}

/** One carved slab of the halo. */
class Slab {
  constructor(group, geometry) {
    this.material = createStoneMaterial();
    this.mesh = new Mesh(geometry, this.material);
    this.mesh.name = 'ReliquarySlab';
    this.mesh.layers.set(LAYER.WORLD);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    group.add(this.mesh);
    this.variant = 0;
    this.arc = 0.9;
    this.theta = 0;
    this.seed = 0;
    this.broke = false;
    this.landed = false;
    this.landedAt = 0;
    this.flash = 0;
    this.lit = 0;
    this.middle = new Vector3();
  }

  reset() {
    this.broke = false;
    this.landed = false;
    this.landedAt = 0;
    this.flash = 0;
    this.lit = 0;
    this.mesh.visible = false;
  }
}

/** One rune cube of the inner ring. */
class Cube {
  constructor(group, geometry) {
    this.material = createStoneMaterial({ cube: true });
    this.mesh = new Mesh(geometry, this.material);
    this.mesh.name = 'ReliquaryCube';
    this.mesh.layers.set(LAYER.WORLD);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    group.add(this.mesh);
    this.axis = new Vector3(0, 1, 0);
    this.spin = 0;
    this.seed = 0;
    this.risen = false;
    this.lit = false;
    this.dove = false;
    this.flash = 0;
    this.from = new Vector3();
    this.position = new Vector3();
  }

  reset() {
    this.risen = false;
    this.lit = false;
    this.dove = false;
    this.flash = 0;
    this.mesh.visible = false;
  }
}

/** One binding tendril, and the limb it takes. */
class Binding {
  constructor(spec) {
    this.spec = spec;
    this.sprout = new Vector3();
    this.from = new Vector3();
    this.spread = new Vector3();
    this.hold = new Vector3();
    this.side = 1;
    this.theta = 0;
    this.lead = 0.65;
    this.caught = false;
    this.active = false;
  }

  reset() {
    this.caught = false;
    this.active = false;
    this.lead = 0.65;
  }
}

/**
 * WILDROOT RELIQUARY — a targeted far cast: one body, taken back by the earth.
 *
 * The circle locks onto whoever is under the cursor, and a seed of light
 * skims the floor to them. When it lands:
 *
 *   1. **The sigil.** A braided circle writes itself round the body, both
 *      ways from the bearing of the arch, a ring of runes inside it and a
 *      whorl of leaves at its heart; two root veins tear out across the floor
 *      to where the arch is going to stand.
 *   2. **The arch.** Two great roots burst out of the floor either side of the
 *      body, each three strands braided, and climb over it — crossing at the
 *      apex and twining as they go — with vines wound round them, tendrils
 *      curling off them, leaves opening along them as the growth goes past,
 *      and smaller roots crawling out of their feet along the floor.
 *   3. **The reliquary.** A broken ring of carved slabs rises up out of the
 *      floor into the arch, open at the bottom, and a horseshoe of rune cubes
 *      inside it; a soft light stands in it.
 *   4. **The binding.** Four tendrils whip up out of the floor at the body and
 *      wind round its wrists and ankles. The first to bite takes it off its
 *      feet; together they hoist it into the middle of the ring and hold it
 *      spread there while the bark creeps over it.
 *   5. **The judgement.** The runes light one after another round the ring,
 *      the cubes close in, and sap runs up every root to the body.
 *   6. **The reclamation.** The cubes dive into it, the arch clenches, and the
 *      roots drag it down into the floor through a burst of leaves and spores.
 *      The slabs fall and crash down round the circle.
 *   7. **The wither.** The roots go grey and draw back into the earth, shedding
 *      their leaves — and where the body stood, a sapling comes up, lit.
 *
 * Like every ability here it captures nothing at the cast but a handful of
 * random numbers; every curve, every stone and every beat is re-solved off
 * `settings.reliquary` each frame, so the whole thing stays live in the
 * editor, paused or not.
 */
export class ReliquaryAbility extends Ability {
  constructor(context) {
    super('reliquary', context);
  }

  /** It picks one body and decides for itself when it is hit. */
  get handlesOwnHits() {
    return true;
  }

  get cameraWeight() {
    return this.u < 1 ? saturate(1 - this.u * 0.4) : 0.6;
  }

  get impactDuration() {
    return Math.max(0.1, this.endAt);
  }

  get fadeDuration() {
    return Math.max(0.1, settings.reliquary.fadeTime);
  }

  get instanceCount() {
    return this.rootGeometry.instanceCount + this.leafGeometry.instanceCount;
  }

  /* ------------------------------------------------------------------ */
  /* construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    const rig = this.ctx.models?.reliquary ?? buildReliquaryRig(null);
    this.rig = rig;

    /* ---- the roots: one bank of curves, one draw of bark, one of leaves ---- */
    this.bank = new CurveBank();
    const strands = [];
    for (let m = 0; m < 2; m++) {
      for (let s = 0; s < 3; s++) strands.push({ curve: MAIN + m, phase: s / 3, radius: 0.6, offset: 0.52, twist: 1, seed: m * 3 + s, kind: 0 });
    }
    for (let i = 0; i < 4; i++) strands.push({ curve: VINE + i, phase: 0, radius: 1, offset: 0, twist: 0, seed: 10 + i, kind: 1 });
    for (let i = 0; i < N_CURLS; i++) {
      strands.push({ curve: CURL + i, phase: 0, radius: 0.72, offset: 0.4, twist: 1, seed: 20 + i, kind: 0 });
      strands.push({ curve: CURL + i, phase: 0.5, radius: 0.72, offset: 0.4, twist: 1, seed: 40 + i, kind: 0 });
    }
    for (let i = 0; i < N_GROUND; i++) {
      strands.push({ curve: GROUND + i, phase: 0, radius: 0.7, offset: 0.45, twist: 1, seed: 60 + i, kind: 0 });
      strands.push({ curve: GROUND + i, phase: 0.5, radius: 0.7, offset: 0.45, twist: -1, seed: 70 + i, kind: 0 });
    }
    for (let i = 0; i < 4; i++) {
      strands.push({ curve: BIND + i, phase: 0, radius: 0.68, offset: 0.48, twist: 1, seed: 80 + i, kind: 0 });
      strands.push({ curve: BIND + i, phase: 0.5, radius: 0.68, offset: 0.48, twist: 1, seed: 90 + i, kind: 1 });
    }
    strands.push({ curve: SAPLING, phase: 0, radius: 1, offset: 0, twist: 0, seed: 99, kind: 1 });
    this.rootGeometry = createRootGeometry(strands);
    this.barkMaterial = createBarkMaterial(this.bank);
    this.roots = new Mesh(this.rootGeometry, this.barkMaterial);
    this.roots.name = 'ReliquaryRoots';
    this._shaped(this.roots, this.barkMaterial);

    const leaves = [];
    const rnd = (a, b) => a + Math.random() * (b - a);
    const leaf = (curve, u, size, tilt, droop) =>
      leaves.push({ curve, u, angle: Math.random(), size, tilt, droop, seed: Math.random(), hue: Math.random() });
    for (let m = 0; m < 2; m++) for (let i = 0; i < 30; i++) leaf(MAIN + m, rnd(0.07, 0.97), rnd(0.55, 1.1), rnd(0.2, 1), rnd(0.2, 0.9));
    for (let v = 0; v < 4; v++) for (let i = 0; i < 8; i++) leaf(VINE + v, rnd(0.08, 0.98), rnd(0.4, 0.8), rnd(0.3, 1), rnd(0.3, 1));
    for (let k = 0; k < N_CURLS; k++) for (let i = 0; i < 4; i++) leaf(CURL + k, rnd(0.1, 0.6), rnd(0.35, 0.7), rnd(0.2, 0.9), rnd(0.2, 0.7));
    for (let k = 0; k < N_GROUND; k++) for (let i = 0; i < 4; i++) leaf(GROUND + k, rnd(0.15, 0.9), rnd(0.4, 0.75), rnd(0.6, 1), 0.05);
    for (let k = 0; k < 4; k++) for (let i = 0; i < 3; i++) leaf(BIND + k, rnd(0.08, 0.42), rnd(0.35, 0.6), rnd(0.4, 1), rnd(0.2, 0.6));
    for (let i = 0; i < 9; i++) {
      leaves.push({ curve: SAPLING, u: 0.35 + (0.62 * i) / 8, angle: (i * 0.382) % 1, size: 0.32 + 0.12 * Math.random(), tilt: 0.75, droop: 0.15, seed: Math.random() * 0.4, hue: 0.6 + Math.random() * 0.4 });
    }
    this.leafGeometry = createLeafGeometry(leaves);
    this.leafMaterial = createLeafMaterial(this.bank);
    this.leaves = new Mesh(this.leafGeometry, this.leafMaterial);
    this.leaves.name = 'ReliquaryLeaves';
    this._shaped(this.leaves, this.leafMaterial);

    /* ---- the stones ---- */
    this.slabs = Array.from({ length: MAX_SLABS }, () => new Slab(this.group, rig.slabs[0].geometry));
    this.cubes = Array.from({ length: MAX_CUBES }, () => new Cube(this.group, rig.cubes[0].geometry));

    /* ---- the sigil, and the light in the ring ---- */
    const flat = new PlaneGeometry(1, 1);
    flat.rotateX(-Math.PI / 2);
    this.sigilMaterial = createSigilMaterial();
    this.sigil = new Mesh(flat, this.sigilMaterial);
    this.sigil.name = 'ReliquarySigil';
    this.sigil.layers.set(LAYER.VFX);
    this.sigil.renderOrder = 5;
    this.sigil.frustumCulled = false;
    this.sigil.visible = false;
    this.group.add(this.sigil);
    this._sigilState = {
      quad: 10,
      radius: 3,
      draw: 0,
      veins: 0,
      side: 0,
      span: 3,
      ignite: 0,
      pulse: 0,
      flare: 0,
      fade: 1,
      sprouts: new Vector4(),
      sproutR: 1.2
    };

    this.auraMaterial = createAuraMaterial();
    this.aura = new Mesh(new PlaneGeometry(1, 1), this.auraMaterial);
    this.aura.name = 'ReliquaryAura';
    this.aura.layers.set(LAYER.VFX);
    this.aura.renderOrder = 4;
    this.aura.frustumCulled = false;
    this.aura.visible = false;
    this.group.add(this.aura);
    this._auraState = { quad: 4, radius: 1.6, amount: 0, flare: 0 };

    /* ---- state ---- */
    this.target = new Vector3();
    this.centre = new Vector3(); // the middle of the halo
    this.archOrigin = new Vector3(); // the foot of the arch's plane, on the floor
    this.frame = new Quaternion(); // the halo's plane: x across, y up, z toward the caster
    this.bindings = LIMBS.map((spec) => new Binding(spec));
    this.victim = null;
    this.taken = false;
    this.victimDone = false;
    this.fieldAge = 0;
    this.jitter = new Float32Array(64);
    this.curls = Array.from({ length: N_CURLS }, () => ({ u: 0.5, lean: 0, hand: 1, length: 1, seed: 0 }));
    this.grounds = Array.from({ length: N_GROUND }, () => ({ yaw: 0, length: 1, seed: 0 }));
    this.slabCount = 4;
    this.cubeCount = 13;
    this.erupted = false;
    this.clenched = false;
    this.finaled = false;
    this.bindStarted = false;
    this.contacted = false;
    this.flare = 0;
    this._lightK = 0;
    this._growth = new Float32Array(MAX_CURVES);
    this._targets = [];
    this._t = {
      archEnd: 0,
      contactAt: 0,
      igniteEnd: 0,
      finaleAt: 0,
      clenchAt: 0,
      dragEnd: 0,
      witherAt: 0,
      witherEnd: 0,
      saplingAt: 0
    };
    this.endAt = 0;

    this._travel = new RateEmitter(80);
    this._spores = new RateEmitter(60);
    this._leafFall = new RateEmitter(20);
    this._tips = new RateEmitter(60);
    this._motes = new RateEmitter(40);
    this._bud = new RateEmitter(10);
  }

  /** Shader-placed, lit and shadowed: out of the depth prepass, into the sun. */
  _shaped(mesh, material) {
    mesh.layers.set(LAYER.SHAPED);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.customDepthMaterial = material.userData.depth;
    mesh.frustumCulled = false;
    mesh.visible = false;
    this.group.add(mesh);
  }

  createParticles() {
    const P = this.ctx.particles;
    this.spores = P.get('reliquarySpore', { capacity: 1400, shape: ParticleShape.SOFT, additive: true, curl: true, softFade: 0.25 });
    this.leafParticles = P.get('reliquaryLeaf', { capacity: 700, shape: ParticleShape.LEAF, additive: false, curl: true, lit: true, softFade: 0.1 });
    this.dirt = P.get('reliquaryDirt', { capacity: 300, shape: ParticleShape.SMOKE, additive: false, curl: true, softFade: 0.6 });
    this.chips = P.get('reliquaryChip', { capacity: 700, shape: ParticleShape.CHIP, additive: false, lit: true, softFade: 0.05 });
    this.glints = P.get('reliquaryGlint', { capacity: 160, shape: ParticleShape.GLINT, additive: true });
    this.sparks = P.get('reliquarySpark', { capacity: 900, shape: ParticleShape.STREAK, additive: true, stretch: true, softFade: 0.1 });
  }

  /* ------------------------------------------------------------------ */
  /* lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.fieldAge = 0;
    this.victim = null;
    this.taken = false;
    this.victimDone = false;
    this.erupted = false;
    this.clenched = false;
    this.finaled = false;
    this.bindStarted = false;
    this.contacted = false;
    this.flare = 0;
    this._lightK = 0.25;
    this.endAt = 0;
    for (const slab of this.slabs) slab.reset();
    for (const cube of this.cubes) cube.reset();
    for (const binding of this.bindings) binding.reset();
    for (let i = 0; i < MAX_CURVES; i++) this.bank.hide(i);
    this.roots.visible = false;
    this.leaves.visible = false;
    this.sigil.visible = false;
    this.aura.visible = false;
    for (const emitter of [this._travel, this._spores, this._leafFall, this._tips, this._motes, this._bud]) emitter.reset();
  }

  onDestroy() {
    this._letGo();
    for (const slab of this.slabs) slab.reset();
    for (const cube of this.cubes) cube.reset();
    this.roots.visible = false;
    this.leaves.visible = false;
    this.sigil.visible = false;
    this.aura.visible = false;
  }

  /** Whatever the roots had hold of falls from wherever it has got to. */
  _letGo() {
    const victim = this.victim;
    if (victim && this.taken && !this.victimDone) {
      victim.unpin();
      victim.clip(null, null);
      victim.release();
    }
    this.victim = null;
    this.taken = false;
  }

  /* ------------------------------------------------------------------ */
  /* the seed's run to the target                                        */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    const g = settings.global;
    const n = this._travel.tick(dt, 90 * g.particleCount);
    for (let i = 0; i < n; i++) {
      const e = emitAt(this.position, _d.copy(this.direction).negate().setY(0.6).normalize());
      e.position.y = 0.12;
      e.radius = 0.08;
      e.speed = 1.6;
      e.spread = 0.7;
      e.size = 0.05;
      e.life = 0.7;
      if (i % 3 === 0) this.sparks.emit(1, e);
      else this.spores.emit(1, e);
    }
    if (Math.random() < dt * 22) {
      const e = emitAt(this.position, UP);
      e.position.y = 0.14;
      e.speed = 0;
      e.spread = 0;
      e.size = 0.5;
      e.life = 0.12;
      e.spin = 2;
      this.glints.emit(1, e);
    }
    this._dress(this.config);
  }

  /* ------------------------------------------------------------------ */
  /* the landing                                                         */
  /* ------------------------------------------------------------------ */

  onImpact() {
    const c = this.config;
    this.fieldAge = 0;

    this.pointAt(1, this.target);
    this.victim = null;
    const found = this.ctx.dummies?.findTargets?.(this.target.x, this.target.z, Math.max(0.6, c.snapRadius * 0.6), this._targets);
    if (found?.length) {
      this.victim = found[0];
      this.target.set(this.victim.position.x, 0, this.victim.position.z);
    }

    // The dice for this one cast; everything else is re-solved every frame.
    for (let i = 0; i < this.jitter.length; i++) this.jitter[i] = Math.random() * 2 - 1;
    this.curls.forEach((curl, i) => {
      curl.u = 0.2 + ((i % 4) / 4) * 0.62 + Math.random() * 0.08;
      curl.lean = (Math.random() * 2 - 1) * 0.8;
      curl.hand = Math.random() < 0.5 ? -1 : 1;
      curl.length = 0.7 + Math.random() * 0.6;
      curl.seed = Math.random() * 10;
    });
    this.grounds.forEach((root, i) => {
      root.yaw = (i & 1 ? 1 : -1) * (0.35 + Math.random() * 0.7);
      root.length = 0.7 + Math.random() * 0.6;
      root.seed = Math.random() * 10;
    });
    for (const slab of this.slabs) {
      slab.reset();
      slab.variant = Math.floor(Math.random() * this.rig.slabs.length);
      const v = this.rig.slabs[slab.variant];
      slab.mesh.geometry = v.geometry;
      slab.arc = v.arc;
      slab.seed = Math.random() * 10;
      slab.material.userData.uniforms.uSeed.value = slab.seed;
      slab.material.userData.uniforms.uArc.value = v.arc;
    }
    for (const cube of this.cubes) {
      cube.reset();
      cube.mesh.geometry = this.rig.cubes[Math.floor(Math.random() * this.rig.cubes.length)].geometry;
      cube.axis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      cube.spin = Math.random() * TAU;
      cube.seed = Math.random() * 10;
      cube.material.userData.uniforms.uSeed.value = cube.seed;
    }
    for (const binding of this.bindings) binding.reset();
    for (let i = 0; i < MAX_CURVES; i++) this.bank.hide(i);
    this.bank.look.forEach((look) => look.set(0, 0, 0, 0));

    this._frame(c);
    this._sides();
    this._plan(c);

    this.sigil.visible = true;
    this.roots.visible = true;
    this.leaves.visible = true;
    this.position.copy(this.centre);

    // The seed goes into the floor.
    const g = settings.global;
    const e = emitAt(this.target, UP);
    e.position.y = 0.1;
    e.radius = 0.2;
    e.speed = 3;
    e.spread = 0.6;
    e.size = 0.05;
    e.life = 0.9;
    this.spores.emit(Math.round(40 * g.particleCount), e);
    e.speed = 0;
    e.spread = 0;
    e.size = 1.8;
    e.life = 0.2;
    e.spin = 2;
    this.glints.emit(1, e);
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, this.target, {
      radius: c.zoneRadius * 0.8,
      life: 0.5,
      intensity: 0.5,
      width: 0.04,
      colorA: getColor(c.colorVein),
      colorB: getColor(c.colorBarkDark)
    });
    this.lightBoost = Math.max(this.lightBoost, 8 * g.explosionIntensity);
  }

  /** The arch's plane, the halo's centre and its orientation. */
  _frame(c) {
    this.archOrigin.copy(this.target).addScaledVector(this.direction, c.archBehind);
    this.centre.copy(this.archOrigin).addScaledVector(UP, c.haloHeight);
    // x across the cast, y up, z back toward the caster: the panels face it.
    _n.copy(this.direction).negate();
    _m.makeBasis(this.side, UP, _n);
    this.frame.setFromRotationMatrix(_m);
  }

  /**
   * Which hand and foot go to which side of the ring — whichever is nearer
   * that side now, so the body is not twisted through itself to get there —
   * and where the tendril that takes each one comes up out of the floor.
   */
  _sides() {
    const c = this.config;
    const victim = this.victim;
    for (let pair = 0; pair < 2; pair++) {
      const a = this.bindings[pair * 2];
      const b = this.bindings[pair * 2 + 1];
      let flip = false;
      if (victim && victim.joint(a.spec.pin, _a) && victim.joint(b.spec.pin, _b)) {
        flip = _a.sub(_b).dot(this.side) > 0;
      }
      a.side = flip ? 1 : -1;
      b.side = flip ? -1 : 1;
    }
    for (const binding of this.bindings) {
      const arm = binding.spec.arm;
      const r = c.sproutRadius;
      binding.sprout
        .copy(this.target)
        .addScaledVector(this.side, binding.side * r * (arm ? 0.95 : 0.55))
        .addScaledVector(this.direction, -r * (arm ? 0.55 : 0.25));
      binding.sprout.y = 0;
    }
  }

  /* ------------------------------------------------------------------ */
  /* the plan                                                            */
  /* ------------------------------------------------------------------ */

  /** When every beat lands. Pure — re-solved every frame off the settings. */
  _plan(c) {
    const t = this._t;
    t.archEnd = c.archAt + c.archGrow;
    t.contactAt = c.bindAt + c.whipTime;
    t.igniteEnd = c.igniteAt + c.igniteTime;
    if (!this.finaled) t.finaleAt = Math.max(t.igniteEnd + c.finaleDelay, t.contactAt + c.hoistTime * 0.5);
    t.clenchAt = t.finaleAt + c.diveTime;
    t.dragEnd = t.clenchAt + c.dragTime;
    t.witherAt = t.dragEnd + c.witherDelay;
    t.witherEnd = t.witherAt + c.witherTime;
    t.saplingAt = t.witherAt + 0.25;
    this.endAt = Math.max(t.witherEnd, t.saplingAt + c.saplingGrow) + 0.3;
    this.slabCount = clamp(Math.round(c.slabs), 2, MAX_SLABS);
    this.cubeCount = clamp(Math.round(c.cubes), 0, MAX_CUBES);
  }

  /* ------------------------------------------------------------------ */
  /* the rite                                                            */
  /* ------------------------------------------------------------------ */

  /** @param {number} t 0..1 the rite, 1..2 the sapling and the sigil going */
  onFade(dt, t) {
    const c = this.config;
    this.fieldAge += dt;
    const age = this.fieldAge;
    const fading = t > 1 ? saturate(t - 1) : 0;
    const T = this._t;

    // Somebody stood it back up (T), or something else took it.
    const victim = this.victim;
    if (victim && !this.victimDone && (victim.state === 'gone' || victim.state === 'frozen' || (this.taken && victim.alive))) {
      this.victim = null;
      this.taken = false;
    }

    this._frame(c);
    this._plan(c);
    this.flare = Math.max(0, this.flare - dt * 2.2);

    if (!this.erupted && age >= c.archAt) this._erupt(c);
    if (!this.bindStarted && age >= c.bindAt) this._startBinding(c);
    if (!this.contacted && this.bindStarted && age >= T.contactAt) this._contact(c);
    if (!this.finaled && age >= T.finaleAt) {
      this.finaled = true;
      T.finaleAt = age;
    }
    if (!this.clenched && age >= T.clenchAt) this._clench(c);

    this._body(dt, c, age);
    this._halo(dt, c, age);
    this._ambient(dt, c, age);
    this._sigilFrame(dt, c, age, fading);
    this._auraFrame(c, age, fading);
    this._dress(c);

    // The light hangs in the ring while there is one, then over the sapling.
    const halo = smoothstep(c.haloAt, c.haloAt + c.haloRise, age);
    const ignite = smoothstep(c.igniteAt, T.igniteEnd, age);
    const after = 1 - smoothstep(T.clenchAt, T.witherAt, age);
    this._lightK = (0.3 + 0.5 * halo + 0.9 * ignite) * (this.clenched ? after : 1) + (this.clenched ? 0.25 * smoothstep(T.saplingAt, T.saplingAt + c.saplingGrow, age) : 0);
    this._lightK *= 1 - fading;
    if (this.clenched && age > T.dragEnd) this.position.set(this.target.x, 0.6, this.target.z);
    else this.position.copy(this.centre);
  }

  lightShimmer() {
    return this._lightK * (0.88 + 0.12 * Math.sin(this.age * 11.0) * Math.sin(this.age * 3.7));
  }

  /* ---- the beats ---- */

  /** The arch breaks the floor. */
  _erupt(c) {
    const g = settings.global;
    this.erupted = true;
    for (let s = -1; s <= 1; s += 2) {
      _p.copy(this.archOrigin).addScaledVector(this.side, s * c.archSpan);
      _p.y = 0;
      this.ctx.decals.spawn(DecalType.CRACK, _p, {
        radius: c.archRadius * 5,
        life: this._t.witherEnd + c.fadeTime,
        intensity: 0.8,
        colorA: getColor(c.colorVein),
        colorB: getColor(c.colorBarkDark)
      });
      this.ctx.decals.spawn(DecalType.DUSTRING, _p, {
        radius: c.archRadius * 7,
        life: 1.1,
        intensity: 0.7,
        colorA: getColor(c.colorDirt),
        colorB: getColor(c.colorBarkDark)
      });
      const e = emitAt(_p, UP);
      e.position.y = 0.05;
      e.radius = c.archRadius * 1.5;
      e.speed = 5.5;
      e.spread = 0.6;
      e.size = 0.06;
      e.sizeVariance = 0.7;
      e.life = 1.2;
      e.spin = 9;
      this.chips.emit(Math.round(26 * g.particleCount), e);
      e.speed = 1.6;
      e.spread = 0.9;
      e.size = 0.7;
      e.life = 1.6;
      e.spin = 1;
      this.dirt.emit(Math.round(7 * g.particleCount), e);
      e.speed = 3;
      e.size = 0.05;
      e.life = 1.1;
      e.spin = 0;
      this.spores.emit(Math.round(30 * g.particleCount), e);
    }
    this.lightBoost = Math.max(this.lightBoost, 10 * g.explosionIntensity);
    this.ctx.shake.add(c.eruptShake * g.explosionIntensity * g.cameraShake, 3.5, 24);
  }

  _startBinding() {
    this.bindStarted = true;
    for (const binding of this.bindings) binding.active = !!this.victim;
    if (!this.victim) return;
    const g = settings.global;
    for (const binding of this.bindings) {
      const e = emitAt(binding.sprout, UP);
      e.position.y = 0.05;
      e.radius = 0.15;
      e.speed = 3.5;
      e.spread = 0.5;
      e.size = 0.04;
      e.life = 0.8;
      e.spin = 8;
      this.chips.emit(Math.round(8 * g.particleCount), e);
      e.speed = 0.9;
      e.size = 0.4;
      e.life = 1;
      e.spin = 1;
      this.dirt.emit(Math.round(2 * g.particleCount), e);
    }
  }

  /** The tendrils bite: the body comes off its feet. */
  _contact(c) {
    const g = settings.global;
    this.contacted = true;
    const victim = this.victim;
    if (!victim) return;
    if (victim.alive) {
      victim.kill(this.direction.x, this.direction.z, c.hit);
      this.taken = true;
    } else if (victim.state === 'dead') {
      this.taken = true;
    } else {
      this.victim = null;
      return;
    }
    for (const binding of this.bindings) {
      if (!victim.joint(binding.spec.pin, binding.from)) binding.from.copy(this.target).setY(1);
      binding.caught = true;
      const e = emitAt(binding.from, UP);
      e.radius = 0.1;
      e.speed = 2.6;
      e.spread = 1;
      e.size = 0.12;
      e.life = 1.6;
      e.spin = 4;
      this.leafParticles.emit(Math.round(6 * g.particleCount), e);
      e.speed = 4;
      e.size = 0.03;
      e.life = 0.4;
      e.spin = 0;
      this.sparks.emit(Math.round(14 * g.particleCount), e);
    }
    this.lightBoost = Math.max(this.lightBoost, 14 * g.explosionIntensity);
    this.ctx.shake.add(c.bindShake * g.explosionIntensity * g.cameraShake, 4, 26);
  }

  /** The arch clenches: the body is dragged under, the stones come down. */
  _clench(c) {
    const g = settings.global;
    this.clenched = true;
    this.flare = 1.6;
    _p.copy(this.target);
    _p.y = 0;
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _p, {
      radius: c.zoneRadius + 1.6,
      life: 0.7,
      intensity: 0.9,
      width: 0.06,
      colorA: getColor(c.colorGlyphHot),
      colorB: getColor(c.colorVein)
    });
    this.ctx.decals.spawn(DecalType.CRACK, _p, {
      radius: 2.0,
      life: this._t.witherEnd - this._t.clenchAt + c.fadeTime + 1,
      intensity: 1,
      colorA: getColor(c.colorVein),
      colorB: getColor(c.colorBarkDark)
    });
    this.ctx.decals.spawn(DecalType.DUSTRING, _p, {
      radius: 3.4,
      life: 1.4,
      intensity: 0.8,
      colorA: getColor(c.colorDirt),
      colorB: getColor(c.colorBarkDark)
    });

    const P = this._bodyPoint(_c);
    const e = emitAt(P, UP);
    e.radius = 0.4;
    e.speed = 5;
    e.speedVariance = 0.6;
    e.spread = 1;
    e.size = 0.13;
    e.sizeVariance = 0.5;
    e.life = 2.6;
    e.spin = 5;
    this.leafParticles.emit(Math.round(c.finaleLeaves * g.particleCount), e);
    e.speed = 4;
    e.size = 0.06;
    e.life = 1.8;
    e.spin = 0;
    this.spores.emit(Math.round(c.finaleSpores * g.particleCount), e);
    e.speed = 10;
    e.size = 0.04;
    e.life = 0.6;
    this.sparks.emit(Math.round(60 * g.particleCount), e);
    e.speed = 0;
    e.spread = 0;
    e.size = 4.0;
    e.life = 0.22;
    e.spin = 2;
    this.glints.emit(1, e);

    const f = emitAt(_p, UP);
    f.position.y = 0.05;
    f.radius = 0.7;
    f.speed = 2.4;
    f.spread = 1;
    f.size = 0.9;
    f.life = 1.8;
    f.spin = 1;
    this.dirt.emit(Math.round(c.finaleDirt * g.particleCount), f);
    f.speed = 7;
    f.spread = 0.6;
    f.size = 0.07;
    f.life = 1.3;
    f.spin = 10;
    this.chips.emit(Math.round(50 * g.particleCount), f);

    this.lightBoost = Math.max(this.lightBoost, c.finaleLight * g.explosionIntensity);
    this.ctx.shake.add(c.finaleShake * g.explosionIntensity * g.cameraShake, 2.5, 20);
    if (c.finaleFlash > 0) this.ctx.flash.trigger(getColor(c.colorVein), c.finaleFlash * g.explosionIntensity);
  }

  /** Where the body is now — its hips once it is down, the middle of the ring before. */
  _bodyPoint(out) {
    const victim = this.victim;
    if (victim && this.taken && victim.bodyPoint(out)) return out;
    if (victim && victim.alive) return out.set(victim.position.x, 1.0, victim.position.z);
    return out.copy(this.centre);
  }

  /* ---- the body ---- */

  _body(dt, c, age) {
    const victim = this.victim;
    if (!victim || !this.taken || this.victimDone) return;
    const T = this._t;
    victim.hold();

    const hoist = Easing.inOutCubic(saturate((age - T.contactAt) / Math.max(0.05, c.hoistTime)));
    const drag = this.clenched ? Easing.inCubic(saturate((age - T.clenchAt) / Math.max(0.05, c.dragTime))) : 0;
    const breathe = Math.sin(age * 2.2) * 0.04;

    for (const binding of this.bindings) {
      const arm = binding.spec.arm;
      binding.spread
        .copy(this.target)
        .addScaledVector(this.side, binding.side * (arm ? c.spreadArms : c.spreadLegs))
        .addScaledVector(UP, c.haloHeight + (arm ? c.armsUp : -c.legsDown) + breathe);
      binding.hold.lerpVectors(binding.from, binding.spread, hoist);
      if (drag > 0) {
        _p.copy(this.target).addScaledVector(UP, -c.dragDepth);
        binding.hold.lerp(_p, drag);
      }
      victim.pin(binding.spec.pin, binding.hold, drag > 0 ? 0.55 : 0.25 + 0.75 * hoist);
    }

    // The bark creeps over it while it hangs there.
    const over = saturate((age - T.contactAt) / Math.max(0.1, T.clenchAt - T.contactAt));
    victim.corrode(over * c.overgrow, c.look);

    if (drag > 0) {
      _p.copy(this.target);
      _p.y = 0;
      victim.sink(c.dragDepth + 2);
      victim.clip(null, UP, _p);
    }
    if (this.clenched && age > T.dragEnd + 0.1) {
      victim.consume(1);
      victim.unpin();
      this.victimDone = true;
    }
  }

  /* ---- the reliquary ---- */

  _halo(dt, c, age) {
    const g = settings.global;
    const T = this._t;
    const R = c.haloRadius;
    const ignite = saturate((age - c.igniteAt) / Math.max(0.05, c.igniteTime));
    const span = c.haloSpan * DEG;
    const N = this.slabCount;
    const wobble = Math.sin(age * 0.6) * c.haloSway;
    const dim = smoothstep(T.witherAt - 0.3, T.witherEnd, age);

    /* ---- the slabs ---- */
    for (let i = 0; i < MAX_SLABS; i++) {
      const slab = this.slabs[i];
      if (i >= N) {
        slab.mesh.visible = false;
        continue;
      }
      slab.theta = -span / 2 + (span * (i + 0.5)) / N + wobble;
      slab.flash = Math.max(0, slab.flash - dt * 3);
      const k = saturate((age - c.haloAt - i * c.haloStagger) / Math.max(0.05, c.haloRise));
      if (k <= 0) {
        slab.mesh.visible = false;
        continue;
      }
      const rise = Easing.outBack(k);
      const depth = c.haloHeight + R + 0.4;

      // The ring's frame, and this slab turned to its place on it.
      _p.copy(this.centre).addScaledVector(UP, -depth * (1 - rise));
      _qz.setFromAxisAngle(_axisZ, -(slab.theta + (1 - rise) * 0.5 * (i & 1 ? 1 : -1)));
      _q.copy(this.frame).multiply(_qz);

      // Down they come once the arch has clenched.
      if (this.clenched) {
        const x = age - (T.clenchAt + 0.05 + i * c.slabDropStagger);
        if (x > 0) {
          const fall = slab.landed ? 0.5 * 9.8 * Math.pow(slab.landedAt, 2) : 0.5 * 9.8 * x * x;
          _p.y -= fall;
          _qx.setFromAxisAngle(_axisX, Math.min(x, slab.landed ? slab.landedAt : x) * 1.4 * (i & 1 ? 1 : -1));
          _q.multiply(_qx);
          if (slab.landed) _p.y -= (x - slab.landedAt) * c.sinkSpeed * R;
        }
      }

      slab.mesh.position.copy(_p);
      slab.mesh.quaternion.copy(_q);
      slab.mesh.scale.set(R, R, R * c.slabThickness);
      slab.mesh.updateMatrix();
      slab.mesh.updateMatrixWorld();

      // Where its middle is, for the dust it makes.
      slab.middle.set(0, 0.87, 0).applyMatrix4(slab.mesh.matrixWorld);
      if (!slab.broke && slab.middle.y > -0.1) {
        slab.broke = true;
        this._breakFloor(slab.middle, 0.8, c);
      }
      if (this.clenched && !slab.landed && slab.middle.y < 0.18 * R) {
        const x = age - (T.clenchAt + 0.05 + i * c.slabDropStagger);
        if (x > 0) {
          slab.landed = true;
          slab.landedAt = x;
          this._breakFloor(slab.middle, 1.3, c);
          this.ctx.shake.add(0.06 * g.explosionIntensity * g.cameraShake, 4, 28);
        }
      }
      const gone = slab.landed && age - (T.clenchAt + 0.05 + i * c.slabDropStagger) - slab.landedAt > 2.5;
      slab.mesh.visible = !gone;

      // The runes light round the ring, from one end of the horseshoe to the other.
      const start = slab.theta - slab.arc / 2 + span / 2;
      const local = (ignite * span - start) / slab.arc;
      const n = Math.max(1, Math.floor((slab.arc * 0.87) / 0.15));
      const lit = clamp(Math.floor(local * n + 0.3), 0, n);
      if (lit > slab.lit && ignite < 1.01) {
        for (let cell = slab.lit; cell < lit; cell++) this._glyphFx(slab, cell, n, R);
        slab.lit = lit;
        slab.flash = Math.max(slab.flash, 0.25);
      }
      const u = slab.material.userData.uniforms;
      slab.material.userData.sync();
      u.uIgnite.value = local;
      u.uCharge.value = ignite * (this.clenched ? 1 - dim : 1) + this.flare * 0.4;
      u.uFlash.value = slab.flash * 0.6 + (this.clenched ? this.flare * 0.15 : 0);
      u.uDim.value = dim;
    }

    /* ---- the cubes ---- */
    const M = this.cubeCount;
    const cspan = c.cubeSpan * DEG;
    const converge = 1 - c.converge * Easing.inOutCubic(ignite);
    for (let i = 0; i < MAX_CUBES; i++) {
      const cube = this.cubes[i];
      if (i >= M || cube.dove) {
        cube.mesh.visible = false;
        continue;
      }
      cube.flash = Math.max(0, cube.flash - dt * 4);
      const f = M > 1 ? i / (M - 1) : 0.5;
      const phi = -cspan / 2 + cspan * f - wobble * 1.6;
      const k = saturate((age - c.haloAt - 0.15 - i * c.cubeStagger) / Math.max(0.05, c.haloRise * 0.8));
      if (k <= 0) {
        cube.mesh.visible = false;
        continue;
      }
      const r = c.cubeRadius * converge;
      _a.set(Math.sin(phi) * r, Math.cos(phi) * r + Math.sin(age * 1.7 + cube.seed) * 0.04, 0).applyQuaternion(this.frame);
      _a.add(this.centre);
      _b.set(_a.x, -0.4, _a.z);
      const rise = Easing.outCubic(k);
      _p.lerpVectors(_b, _a, rise);
      if (!cube.risen && _p.y > -0.05) {
        cube.risen = true;
        this._breakFloor(_p, 0.35, c);
      }

      const lit = ignite >= f * 0.98 + 0.01 && ignite > 0;
      if (lit && !cube.lit) {
        cube.lit = true;
        cube.flash = 1;
        const e = emitAt(_p, UP);
        e.speed = 0;
        e.spread = 0;
        e.size = 0.7;
        e.life = 0.16;
        e.spin = 3;
        this.glints.emit(1, e);
      }

      // The dive: one after another into the body.
      if (this.finaled) {
        const x = (age - T.finaleAt - i * (c.diveTime * 0.6) / Math.max(1, M)) / Math.max(0.05, c.diveTime * 0.4);
        if (x > 0) {
          this._bodyPoint(_c);
          const e = Easing.inCubic(saturate(x));
          if (!cube.from.lengthSq() || x < 0.05) cube.from.copy(_p);
          _p.lerpVectors(cube.from, _c, e);
          if (x >= 1) {
            cube.dove = true;
            this._diveFx(_c, c);
            cube.mesh.visible = false;
            continue;
          }
        } else {
          cube.from.set(0, 0, 0);
        }
      } else {
        cube.from.set(0, 0, 0);
      }

      cube.position.copy(_p);
      cube.mesh.position.copy(_p);
      _q.setFromAxisAngle(cube.axis, cube.spin + age * c.cubeTumble * (1 + ignite * 2.5));
      cube.mesh.quaternion.copy(this.frame).multiply(_q);
      cube.mesh.scale.setScalar(c.cubeSize * (1 + cube.flash * 0.25));
      cube.mesh.visible = true;
      const u = cube.material.userData.uniforms;
      cube.material.userData.sync();
      u.uIgnite.value = cube.lit ? 1 : 0;
      u.uCharge.value = cube.lit ? ignite : 0;
      u.uFlash.value = cube.flash * 0.7;
      u.uDim.value = 0;
    }
  }

  /** Something breaks up through the floor here. */
  _breakFloor(at, scale, c) {
    const g = settings.global;
    _p.set(at.x, 0, at.z);
    this.ctx.decals.spawn(DecalType.DUSTRING, _p, {
      radius: 1.2 * scale,
      life: 0.9,
      intensity: 0.55,
      colorA: getColor(c.colorDirt),
      colorB: getColor(c.colorBarkDark)
    });
    const e = emitAt(_p, UP);
    e.position.y = 0.05;
    e.radius = 0.3 * scale;
    e.speed = 4 * Math.sqrt(scale);
    e.spread = 0.6;
    e.size = 0.05;
    e.sizeVariance = 0.6;
    e.life = 1;
    e.spin = 9;
    this.chips.emit(Math.round(12 * scale * g.particleCount), e);
    e.speed = 1.1;
    e.spread = 0.9;
    e.size = 0.6 * scale;
    e.life = 1.3;
    e.spin = 1;
    this.dirt.emit(Math.round(3 * scale * g.particleCount), e);
  }

  /** A rune lights: a glint at its medallion. */
  _glyphFx(slab, cell, n, R) {
    const a = -slab.arc / 2 + ((cell + 0.5) / n) * slab.arc;
    _a.set(Math.sin(a) * 0.87, Math.cos(a) * 0.87, 0.11).applyMatrix4(slab.mesh.matrixWorld);
    const e = emitAt(_a, UP);
    e.speed = 0;
    e.spread = 0;
    e.size = 0.45 * R * 0.6;
    e.life = 0.2;
    e.spin = 3;
    this.glints.emit(1, e);
    e.speed = 0.8;
    e.spread = 1;
    e.size = 0.03;
    e.life = 0.8;
    e.spin = 0;
    this.spores.emit(Math.round(5 * settings.global.particleCount), e);
  }

  _diveFx(at, c) {
    const g = settings.global;
    const e = emitAt(at, UP);
    e.radius = 0.1;
    e.speed = 5;
    e.spread = 1;
    e.size = 0.04;
    e.life = 0.9;
    e.spin = 10;
    this.chips.emit(Math.round(8 * g.particleCount), e);
    e.speed = 6;
    e.size = 0.03;
    e.life = 0.4;
    e.spin = 0;
    this.sparks.emit(Math.round(10 * g.particleCount), e);
    e.speed = 0;
    e.spread = 0;
    e.size = 1.2;
    e.life = 0.14;
    e.spin = 3;
    this.glints.emit(1, e);
    this.flare = Math.max(this.flare, 0.6);
    this.lightBoost = Math.max(this.lightBoost, 6 * g.explosionIntensity);
    this.ctx.shake.add(0.03 * g.explosionIntensity * g.cameraShake, 6, 30);
  }

  /* ---- the air round it ---- */

  _ambient(dt, c, age) {
    const g = settings.global;
    const T = this._t;
    const ignite = smoothstep(c.igniteAt, T.igniteEnd, age);
    const alive = this.clenched ? 1 - smoothstep(T.witherAt, T.witherEnd, age) : 1;

    // Sparks and spores off every tip still pushing out.
    const tips = this._tips.tick(dt, 70 * g.particleCount);
    for (let i = 0; i < tips; i++) {
      const ci = Math.floor(Math.random() * (CURL + N_CURLS));
      const st = this.bank.state[ci];
      if (st.x <= 0.02 || st.x >= 0.999 || st.w <= 0 || this._growth[ci] <= 0) continue;
      this.bank.sample(ci, st.x, _a);
      const e = emitAt(_a, UP);
      e.radius = 0.05;
      e.speed = 1.6;
      e.spread = 0.9;
      e.size = 0.03;
      e.life = 0.5;
      if (i & 1) this.sparks.emit(1, e);
      else this.spores.emit(1, e);
    }

    // Spores drifting up off the roots — thicker once the runes are lit.
    const spores = this._spores.tick(dt, c.sporeRate * (0.5 + ignite * 1.2) * alive * g.particleCount);
    for (let i = 0; i < spores; i++) {
      const ci = Math.random() < 0.7 ? MAIN + (i & 1) : VINE + (i & 3);
      const st = this.bank.state[ci];
      if (st.w <= 0 || st.x <= 0.05) continue;
      this.bank.sample(ci, Math.random() * st.x, _a);
      const e = emitAt(_a, UP);
      e.radius = 0.25;
      e.speed = 0.4;
      e.spread = 0.8;
      e.size = 0.035;
      e.sizeVariance = 0.6;
      e.life = 2.2;
      e.lifeVariance = 0.4;
      this.spores.emit(1, e);
    }

    // Motes drawn in to the body while it hangs there.
    if (this.taken && !this.clenched) {
      const motes = this._motes.tick(dt, (20 + 60 * ignite) * g.particleCount);
      this._bodyPoint(_c);
      for (let i = 0; i < motes; i++) {
        const a = Math.random() * TAU;
        _a.set(Math.sin(a) * c.haloRadius * 0.9, Math.cos(a) * c.haloRadius * 0.9, 0).applyQuaternion(this.frame).add(this.centre);
        const e = emitAt(_a, _d.subVectors(_c, _a).normalize());
        e.speed = 1.8;
        e.spread = 0.15;
        e.size = 0.04;
        e.life = 0.7;
        e.lifeVariance = 0.2;
        this.spores.emit(1, e);
      }
    }

    // Leaves let go: a few all along, a fall of them as it withers.
    const withering = this.clenched ? smoothstep(T.witherAt, T.witherAt + 0.3, age) * (1 - smoothstep(T.witherEnd - 0.4, T.witherEnd, age)) : 0;
    const fall = this._leafFall.tick(dt, (c.leafFall * (this.erupted ? 1 : 0) + withering * c.leafFall * 6) * g.particleCount);
    for (let i = 0; i < fall; i++) {
      const ci = Math.random() < 0.65 ? MAIN + (i & 1) : CURL + Math.floor(Math.random() * N_CURLS);
      const st = this.bank.state[ci];
      if (st.w <= 0 || st.x <= 0.1) continue;
      this.bank.sample(ci, 0.15 + Math.random() * (st.x - 0.15), _a);
      const e = emitAt(_a, _d.set(Math.random() - 0.5, 0.2, Math.random() - 0.5).normalize());
      e.radius = 0.2;
      e.speed = 0.5;
      e.spread = 1;
      e.size = 0.13;
      e.sizeVariance = 0.4;
      e.life = 3;
      e.lifeVariance = 0.3;
      e.spin = 3;
      this.leafParticles.emit(1, e);
    }

    // The sapling's bud.
    const bud = this.bank.state[SAPLING];
    if (bud.x > 0.9) {
      const n = this._bud.tick(dt, 8 * g.particleCount);
      this.bank.sample(SAPLING, 1, _a);
      for (let i = 0; i < n; i++) {
        const e = emitAt(_a, UP);
        e.radius = 0.08;
        e.speed = 0.35;
        e.spread = 0.6;
        e.size = 0.03;
        e.life = 1.6;
        this.spores.emit(1, e);
      }
    }
  }

  /* ---- the sigil and the aura ---- */

  _sigilFrame(dt, c, age, fading) {
    const s = this._sigilState;
    const T = this._t;
    const R = Math.max(0.8, c.zoneRadius);
    s.radius = R;
    s.span = c.archSpan;
    s.quad = (Math.max(R, c.archSpan) + 1.2) * 2;
    s.draw = Easing.outCubic(saturate(age / Math.max(0.05, c.drawTime)));
    s.veins = Easing.outCubic(saturate((age - c.archAt) / Math.max(0.05, c.archGrow * 0.6)));
    // The sigil's frame: its +x is the world's +x, its +y the world's −z.
    s.side = Math.atan2(-this.side.z, this.side.x);
    for (let i = 0; i < 4; i++) {
      const b = this.bindings[i];
      const ang = Math.atan2(-(b.sprout.z - this.target.z), b.sprout.x - this.target.x);
      s.sprouts.setComponent(i, this.victim || this.taken ? ang : 0);
    }
    s.sproutR = this.bindStarted && (this.victim || this.taken) ? c.sproutRadius * saturate((age - c.bindAt) / 0.3) : 0;
    s.ignite = saturate((age - c.igniteAt) / Math.max(0.05, c.igniteTime));
    s.flare = Math.max(this.flare * 0.6, 0);
    s.pulse = this.clenched ? saturate((age - T.clenchAt) / 0.8) : 0;
    if (s.pulse >= 1) s.pulse = 0;
    const after = this.clenched ? 1 - 0.65 * smoothstep(T.witherAt, T.witherEnd, age) : 1;
    s.fade = after * (1 - fading);
    this.sigil.position.set(this.target.x, 0.014, this.target.z);
    this.sigil.scale.set(s.quad, 1, s.quad);
    this.sigilMaterial.userData.sync(s);
    this.sigil.visible = s.fade > 0.001;
  }

  _auraFrame(c, age, fading) {
    const s = this._auraState;
    const T = this._t;
    const halo = smoothstep(c.haloAt + c.haloRise * 0.5, c.haloAt + c.haloRise * 1.5, age);
    const ignite = smoothstep(c.igniteAt, T.igniteEnd, age);
    const gone = this.clenched ? 1 - smoothstep(T.clenchAt, T.clenchAt + 0.9, age) : 1;
    s.radius = c.haloRadius * 1.05;
    s.quad = c.haloRadius * 2.8;
    s.amount = (halo * 0.35 + ignite * 0.75) * gone * (1 - fading) + this.flare * 0.5 * gone;
    s.flare = this.flare + ignite * 0.3;
    this.aura.position.copy(this.centre).addScaledVector(this.direction, c.slabThickness * c.haloRadius * 0.6);
    this.aura.quaternion.copy(this.frame);
    this.aura.scale.set(s.quad, s.quad, 1);
    this.auraMaterial.userData.sync(s);
    this.aura.visible = s.amount > 0.002;
  }

  /* ------------------------------------------------------------------ */
  /* the roots — after the bodies have stepped, so a coil never trails    */
  /* ------------------------------------------------------------------ */

  lateUpdate() {
    if (this.phase === 'idle' || this.phase === 'done' || this.phase === 'travel') return;
    const c = this.config;
    const age = this.fieldAge;
    const fading = this.phase === 'fade' ? saturate(this.fadeTime / Math.max(0.05, this.fadeDuration)) : 0;
    this.barkMaterial.userData.sync();
    this.leafMaterial.userData.sync();

    this._arch(c, age);
    this._vines(c, age);
    this._curls(c, age);
    this._ground(c, age);
    this._binding(c, age);
    this._sapling(c, age, fading);
  }

  /** 0..1 how far a curve has drawn back into the floor; `lag` staggers them. */
  _wither(c, age, lag) {
    if (!this.clenched) return 0;
    const T = this._t;
    return Easing.inCubic(saturate((age - T.witherAt - lag * c.witherTime * 0.35) / Math.max(0.05, c.witherTime * 0.65)));
  }

  /** How much light is running up the roots. */
  _sap(c, age) {
    const T = this._t;
    const grown = smoothstep(c.archAt, this._t.archEnd, age) * 0.15;
    const ignite = smoothstep(c.igniteAt, T.igniteEnd, age);
    const bound = this.contacted && this.taken ? 0.25 : 0;
    let sap = grown + bound + ignite * 0.8 * c.sapGlow;
    if (this.clenched) sap = (sap + this.flare * 0.8) * (1 - smoothstep(T.dragEnd, T.witherAt + 0.4, age));
    return sap;
  }

  _arch(c, age) {
    const bank = this.bank;
    const sap = this._sap(c, age);
    const grow = Easing.outCubic(saturate((age - c.archAt) / Math.max(0.05, c.archGrow)));
    const w = this._wither(c, age, 1);
    const clench = this.clenched ? Easing.outBack(saturate((age - this._t.clenchAt) / 0.35)) : 0;
    const n = ARCH_SHAPE.length;
    const F = this.direction;
    for (let m = 0; m < 2; m++) {
      const sgn = m === 0 ? 1 : -1;
      bank.begin();
      for (let i = 0; i < n; i++) {
        const [sx, sy] = ARCH_SHAPE[i];
        const yf = Math.max(0, sy);
        const j = i > 1 ? this.jitter[m * 24 + i] : 0;
        const jy = i > 1 ? this.jitter[m * 24 + i + 12] : 0;
        let x = sgn * (sx + j * 0.06) * c.archSpan;
        let y = (sy + jy * 0.035) * c.archHeight;
        // They twine over the top: each leans its own way off the plane.
        let z = sgn * c.archTwine * Math.sin(Math.PI * (i / (n - 1)) * 1.7);
        x += Math.sin(age * 0.9 + i + m * 2) * c.archSway * yf;
        z += Math.cos(age * 0.7 + i * 1.3 + m) * c.archSway * yf;
        // The clench: the top pulls in and down, like a hand closing.
        x *= 1 - 0.16 * clench * yf;
        y *= 1 - 0.14 * clench * yf * yf;
        _p.copy(this.archOrigin).addScaledVector(this.side, x).addScaledVector(F, z);
        _p.y = y;
        bank.add(_p);
      }
      bank.commit(MAIN + m, c.archRadius, c.archTipRadius, c.archFlare, 0.22, m * 3.7 + this.jitter[0] * 5, F.x, F.y, F.z);
      this._grow(MAIN + m, grow * (1 - w), w, sap);
      bank.look[MAIN + m].x = c.archTwist;
    }
  }

  /** Vines wound round the great roots, on a helix about their centreline. */
  _vines(c, age) {
    const bank = this.bank;
    const sap = this._sap(c, age);
    const turns = c.vineTurns;
    for (let v = 0; v < 4; v++) {
      const main = MAIN + (v >> 1);
      const L = bank.state[main].w;
      if (L <= 0 || c.vines <= (v & 1)) {
        bank.hide(VINE + v);
        this._growth[VINE + v] = 0;
        continue;
      }
      const phase = (v & 1) * 0.5 + this.jitter[40 + v] * 0.1;
      bank.begin();
      const K = 44;
      for (let k = 0; k <= K; k++) {
        const u = 0.02 + (k / K) * 0.86;
        this._frameAt(main, u, _a, _n, _t);
        _u.crossVectors(_n, _t).normalize();
        const r = bank.radius(main, u) * 1.12 + c.vineRadius;
        const a = TAU * (phase + u * L * turns);
        _p.copy(_a).addScaledVector(_n, Math.cos(a) * r).addScaledVector(_u, Math.sin(a) * r);
        bank.add(_p);
      }
      bank.commit(VINE + v, c.vineRadius, c.vineRadius * 0.45, 0.4, 0.15, v * 1.9, _n.x, _n.y, _n.z);
      const lead = bank.state[main].x;
      const g = saturate(lead * 1.06 - 0.06 - (v & 1) * 0.06);
      const w = this._wither(c, age, 0.6);
      this._grow(VINE + v, g * (1 - w), w, sap * 0.8);
    }
  }

  /** Tendrils off the great roots, ending in a fiddlehead curl. */
  _curls(c, age) {
    const bank = this.bank;
    const sap = this._sap(c, age);
    const count = clamp(Math.round(c.curls), 0, N_CURLS);
    _c.copy(this.archOrigin).addScaledVector(UP, c.archHeight * 0.45);
    for (let k = 0; k < N_CURLS; k++) {
      const curl = this.curls[k];
      const main = MAIN + (k & 1);
      const mainState = bank.state[main];
      if (k >= count || mainState.w <= 0) {
        bank.hide(CURL + k);
        this._growth[CURL + k] = 0;
        continue;
      }
      this._frameAt(main, curl.u, _a, _n, _t);
      // Out, away from the middle of the arch, leaning off its plane.
      _e.subVectors(_a, _c);
      _e.addScaledVector(this.direction, curl.lean * _e.length() * 0.6).normalize();
      _v.crossVectors(_e, _t).normalize().multiplyScalar(curl.hand);
      if (_v.lengthSq() < 1e-4) _v.copy(UP);
      const Lc = c.curlLength * curl.length;
      const r0 = bank.radius(main, curl.u);
      bank.begin();
      _p.copy(_a).addScaledVector(_e, -r0 * 0.3);
      bank.add(_p);
      for (let i = 1; i <= 3; i++) {
        const s = i / 3;
        _p.copy(_a).addScaledVector(_e, r0 + s * Lc * 0.45).addScaledVector(_v, -s * s * Lc * 0.06);
        bank.add(_p);
      }
      // The fiddlehead: a spiral tightening in on itself.
      _b.copy(_a).addScaledVector(_e, r0 + Lc * 0.45);
      const R0 = Lc * 0.22;
      _d.copy(_b).addScaledVector(_v, R0);
      const turns = 1.55 + Math.sin(curl.seed) * 0.25;
      for (let i = 1; i <= 14; i++) {
        const s = i / 14;
        const phi = s * turns * TAU;
        const rad = R0 * (1 - 0.82 * s);
        _p.copy(_d).addScaledVector(_v, -Math.cos(phi) * rad).addScaledVector(_e, Math.sin(phi) * rad);
        bank.add(_p);
      }
      bank.commit(CURL + k, c.curlRadius, c.curlRadius * 0.2, 0.5, 0.2, curl.seed, _v.x, _v.y, _v.z);
      const reach = (mainState.x - curl.u) * mainState.w;
      const g = Easing.outCubic(saturate(reach / (Lc * 1.1)));
      const w = this._wither(c, age, 0);
      this._grow(CURL + k, g * (1 - w), w, sap * 0.7);
      bank.look[CURL + k].x = 0.6;
    }
  }

  /** Roots crawling out of the feet of the arch, in and out of the floor. */
  _ground(c, age) {
    const bank = this.bank;
    const sap = this._sap(c, age);
    const count = clamp(Math.round(c.groundRoots), 0, N_GROUND);
    const grow = Easing.outCubic(saturate((age - c.archAt - 0.05) / Math.max(0.05, c.archGrow * 0.65)));
    for (let k = 0; k < N_GROUND; k++) {
      if (k >= count) {
        bank.hide(GROUND + k);
        this._growth[GROUND + k] = 0;
        continue;
      }
      const root = this.grounds[k];
      const sgn = k < 2 ? -1 : 1;
      _a.copy(this.archOrigin).addScaledVector(this.side, sgn * c.archSpan);
      // Heading: out along the floor, fore or aft, swinging round.
      _e.copy(this.direction).multiplyScalar(k & 1 ? 1 : -1).addScaledVector(this.side, sgn * 0.6 + root.yaw * 0.4).normalize();
      _v.crossVectors(UP, _e).normalize();
      const L = c.groundLength * root.length;
      bank.begin();
      for (let i = 0; i <= 9; i++) {
        const s = i / 9;
        const swing = Math.sin(s * 3.1 + root.seed) * 0.35 * s * L * 0.4 + root.yaw * s * s * L * 0.3;
        _p.copy(_a).addScaledVector(_e, s * L + c.archRadius * 0.6).addScaledVector(_v, swing);
        _p.y = i === 0 ? 0.05 : 0.02 + 0.07 * Math.sin(s * 9 + root.seed * 2) * (1 - s * 0.5);
        bank.add(_p);
      }
      bank.commit(GROUND + k, c.archRadius * 0.4, 0.015, 0.6, 0.25, root.seed, 0, 1, 0);
      const w = this._wither(c, age, 0.3);
      this._grow(GROUND + k, grow * (1 - w), w, sap * 0.6);
      bank.look[GROUND + k].x = 0.5;
    }
  }

  /** The four that take the body: up out of the floor and round a wrist or an ankle. */
  _binding(c, age) {
    const bank = this.bank;
    const victim = this.victim;
    const T = this._t;
    const sap = this._sap(c, age);
    for (let i = 0; i < 4; i++) {
      const binding = this.bindings[i];
      const ci = BIND + i;
      const spec = binding.spec;
      if (!binding.active || !victim || !this.bindStarted || this.victimDone && this._wither(c, age, 0.2) >= 1) {
        bank.hide(ci);
        this._growth[ci] = 0;
        continue;
      }
      // The limb's segment, wherever the solver has put it.
      const okA = victim.joint(spec.from, _a);
      const okB = victim.joint(spec.to, _b);
      if (!okA || !okB) {
        bank.hide(ci);
        continue;
      }
      _e.subVectors(_b, _a);
      const segLen = Math.max(0.05, _e.length());
      _e.divideScalar(segLen);
      _u.crossVectors(_e, Math.abs(_e.y) > 0.85 ? this.direction : UP).normalize();
      _v.crossVectors(_e, _u).normalize();

      // It comes in from the sprout and winds from the wrist up the forearm.
      if (!binding.caught) {
        _d.subVectors(binding.sprout, _b);
        binding.theta = Math.atan2(_d.dot(_v), _d.dot(_u));
      }
      const turns = c.wrapTurns;
      const rw = c.wrapRadius * (spec.arm ? 1 : 1.25);
      const K = 18;
      // The coil's first point, for the lead to aim at.
      _c.copy(_a).addScaledVector(_e, segLen * 0.98).addScaledVector(_u, Math.cos(binding.theta) * rw).addScaledVector(_v, Math.sin(binding.theta) * rw);

      bank.begin();
      _p.copy(binding.sprout);
      _p.y = -0.45;
      bank.add(_p);
      _p.y = 0.3;
      bank.add(_p);
      // The whip: a wave thrown down it while it reaches, gone once it bites.
      const whip = binding.caught ? 0.12 * Math.exp(-(age - T.contactAt) * 4) : 0.35 * (1 - saturate((age - c.bindAt) / c.whipTime));
      _d.subVectors(_c, binding.sprout);
      _n.crossVectors(_d, UP);
      if (_n.lengthSq() < 1e-6) _n.copy(this.side);
      _n.normalize();
      const wave = Math.sin(age * 16 + i * 1.7) * whip;
      _p.lerpVectors(binding.sprout, _c, 0.42).addScaledVector(UP, 0.45 + whip).addScaledVector(_n, wave);
      bank.add(_p);
      _p.lerpVectors(binding.sprout, _c, 0.78).addScaledVector(UP, 0.12).addScaledVector(_n, -wave * 0.6);
      bank.add(_p);
      let lead = binding.sprout.distanceTo(_c) * 1.15 + 0.75;
      for (let k = 0; k <= K; k++) {
        const s = k / K;
        const f = 0.98 - s * 0.62;
        const th = binding.theta + s * turns * TAU;
        _p.copy(_a).addScaledVector(_e, segLen * f).addScaledVector(_u, Math.cos(th) * rw).addScaledVector(_v, Math.sin(th) * rw);
        bank.add(_p);
      }
      const coil = turns * TAU * rw + segLen * 0.62;
      binding.lead = lead / (lead + coil);
      bank.commit(ci, c.tendrilRadius, c.tendrilRadius * 0.45, 0.8, 0.15, 7 + i, UP.x, UP.y, UP.z);

      let g;
      if (!binding.caught) g = binding.lead * Easing.outQuad(saturate((age - c.bindAt) / Math.max(0.05, c.whipTime)));
      else g = binding.lead + (1 - binding.lead) * Easing.outCubic(saturate((age - T.contactAt) / Math.max(0.05, c.wrapTime)));
      const w = this._wither(c, age, 0.2);
      this._grow(ci, g * (1 - w), w, sap + (binding.caught ? 0.3 : 0));
      bank.look[ci].x = 0.9;
    }
  }

  /** What is left where the body stood. */
  _sapling(c, age, fading) {
    const bank = this.bank;
    const T = this._t;
    if (!this.clenched || c.saplingHeight <= 0) {
      bank.hide(SAPLING);
      this._growth[SAPLING] = 0;
      return;
    }
    const H = c.saplingHeight;
    bank.begin();
    _a.copy(this.target);
    _p.copy(_a).setY(-0.15);
    bank.add(_p);
    _p.copy(_a).setY(0.05);
    bank.add(_p);
    _p.copy(_a).addScaledVector(this.side, H * 0.08).setY(H * 0.35);
    bank.add(_p);
    _p.copy(_a).addScaledVector(this.side, -H * 0.05).addScaledVector(this.direction, H * 0.04).setY(H * 0.7);
    bank.add(_p);
    _p.copy(_a).addScaledVector(this.side, H * 0.03).setY(H);
    bank.add(_p);
    bank.commit(SAPLING, c.saplingRadius, c.saplingRadius * 0.35, 0.6, 0.1, 3.3, this.side.x, this.side.y, this.side.z);
    const g = Easing.outCubic(saturate((age - T.saplingAt) / Math.max(0.05, c.saplingGrow)));
    const shrink = smoothstep(0.55, 1, fading);
    this._grow(SAPLING, g * (1 - shrink), shrink, (0.6 + 0.4 * Math.sin(age * 3)) * c.saplingGlow);
  }

  /** Write one curve's growth, wither and sap; a curve with nothing out is hidden. */
  _grow(ci, g, w, sap) {
    const st = this.bank.state[ci];
    st.x = saturate(g);
    st.y = saturate(w);
    st.z = sap;
    this._growth[ci] = st.x;
  }

  /** Centre, normal and tangent of curve `ci` at `u`, read back off the bank. */
  _frameAt(ci, u, P, N, Tn) {
    const bank = this.bank;
    bank.sample(ci, u, P);
    bank.sample(ci, Math.min(1, u + 1 / (ROOT_SAMPLES - 1)), _p);
    bank.sample(ci, Math.max(0, u - 1 / (ROOT_SAMPLES - 1)), Tn);
    Tn.subVectors(_p, Tn).normalize();
    const i = Math.round(saturate(u) * (ROOT_SAMPLES - 1));
    const o = (ci * 2 + 1) * ROOT_SAMPLES * 4 + i * 4;
    N.set(bank.data[o], bank.data[o + 1], bank.data[o + 2]);
    N.addScaledVector(Tn, -N.dot(Tn)).normalize();
  }

  /* ---- the look of every particle system, every frame ---- */

  _dress(c) {
    const g = settings.global;
    {
      const u = this.spores.uniforms;
      this.spores.setGradient(getColor('#ffffff'), getColor(c.colorGlyphHot), getColor(c.colorVein), getColor(c.colorMoss));
      u.uGravity.value.set(0, 0.35, 0);
      u.uDrag.value = 1.4;
      u.uTurbulence.value = 0.7 * g.turbulence;
      u.uTurbFrequency.value = 1.1;
      u.uEndSize.value = 0.3;
      u.uFadeIn.value = 0.15;
      u.uFadeOut.value = 0.5;
      u.uGlow.value = 2.0 * g.glow;
      u.uOpacity.value = 1;
    }
    {
      const u = this.leafParticles.uniforms;
      this.leafParticles.setGradient(getColor(c.colorLeaf), getColor(c.colorLeaf), getColor(c.colorLeafDark), getColor(c.colorDry));
      u.uGravity.value.set(0, -1.6, 0);
      u.uDrag.value = 1.8;
      u.uTurbulence.value = 1.0 * g.turbulence;
      u.uTurbFrequency.value = 0.8;
      u.uEndSize.value = 0.85;
      u.uFadeIn.value = 0.05;
      u.uFadeOut.value = 0.25;
      u.uGlow.value = 0.9;
      u.uOpacity.value = 1;
    }
    {
      const u = this.dirt.uniforms;
      this.dirt.setGradient(getColor(c.colorDirt), getColor(c.colorDirt), getColor(c.colorBarkDark), getColor(c.colorBarkDark));
      u.uGravity.value.set(0, 0.2, 0);
      u.uDrag.value = 2.2;
      u.uTurbulence.value = 0.5 * g.turbulence;
      u.uTurbFrequency.value = 0.9;
      u.uEndSize.value = 2.6;
      u.uFadeIn.value = 0.08;
      u.uFadeOut.value = 0.55;
      u.uGlow.value = 0.25;
      u.uOpacity.value = 0.55;
    }
    {
      const u = this.chips.uniforms;
      this.chips.setGradient(getColor(c.colorStone), getColor(c.colorDirt), getColor(c.colorBarkDark), getColor(c.colorBarkDark));
      u.uGravity.value.set(0, -16, 0);
      u.uDrag.value = 0.4;
      u.uTurbulence.value = 0;
      u.uEndSize.value = 0.8;
      u.uFadeOut.value = 0.25;
      u.uGlow.value = 0.8;
      u.uOpacity.value = 1;
    }
    {
      const u = this.glints.uniforms;
      this.glints.setGradient(getColor('#ffffff'), getColor(c.colorGlyphHot), getColor(c.colorVein), getColor(c.colorVein));
      u.uGravity.value.set(0, 0, 0);
      u.uDrag.value = 1;
      u.uTurbulence.value = 0;
      u.uEndSize.value = 0.6;
      u.uSizeIn.value = 0.001;
      u.uFadeIn.value = 0;
      u.uFadeOut.value = 0.4;
      u.uGlow.value = 2.6 * g.glow;
      u.uOpacity.value = 1;
    }
    {
      const u = this.sparks.uniforms;
      this.sparks.setGradient(getColor('#ffffff'), getColor(c.colorGlyphHot), getColor(c.colorVein), getColor(c.colorMoss));
      u.uGravity.value.set(0, -5, 0);
      u.uDrag.value = 1.6;
      u.uTurbulence.value = 0.2;
      u.uStretch.value = 0.05;
      u.uEndSize.value = 0.3;
      u.uFadeOut.value = 0.5;
      u.uGlow.value = 2.2 * g.glow;
      u.uOpacity.value = 1;
    }
  }
}
