import {
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  PlaneGeometry,
  Quaternion,
  Vector3
} from 'three';
import { Ability } from './Ability.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { DecalType } from '../effects/GroundDecals.js';
import { createHookGeometry, createLinkGeometry } from '../assets/ChainGeometry.js';
import {
  createChainMaterial,
  createPortalMaterial,
  createPortalWarpMaterial,
  createSealMaterial
} from '../materials/ChainMaterials.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { Easing, saturate, smoothstep } from '../utils/math.js';

const TAU = Math.PI * 2;
/** Links one cast can draw, across every chain. */
const MAX_LINKS = 1800;
/** Points in one chain's centreline: the coil and the span to its portal. */
const MAX_PATH = 200;

/**
 * The chains, and what each one is for.
 *
 * `from` → `to` is the bone the chain winds round, and `wrap` the stretch of
 * it the coil covers (fractions of that bone); `pin` is the joint the body is
 * held by. `dir` is where the portal stands, in the body's own frame — left,
 * up, forward — so the rite is laid out round whoever it took, facing the way
 * they faced; `ground` puts it in the floor instead, that far to the side and
 * the front (× `groundSpan`), and `floor` straight under the body. `reach` is
 * how far from the trunk that joint is held while the body hangs, metres.
 * `tear` is the limb it pulls off, and when (0 first), and `give` how far
 * that socket stretches before it does, × `stretch` — a hip is a deeper
 * joint than a shoulder. The two without a limb hold the trunk: one lets go,
 * the other takes it down through the floor.
 */
const SPECS = [
  { id: 'waist', region: null, from: 'Hips', to: 'Spine1', wrap: [0.2, 0.95], pin: 'Spine', dir: [0, -1, 0], reach: 0, girth: 0.16, floor: true, order: 0 },
  { id: 'head', region: 'head', from: 'Head', to: 'HeadTop_End', wrap: [0.12, 0.55], pin: 'HeadTop_End', dir: [0.12, 1, -0.3], reach: 0.78, girth: 0.105, order: 1, tear: 4, give: 0.6 },
  { id: 'armL', region: 'armL', from: 'LeftForeArm', to: 'LeftHand', wrap: [0.2, 0.92], pin: 'LeftHand', dir: [1, 0.55, 0.18], reach: 0.82, girth: 0.05, order: 2, tear: 0 },
  { id: 'armR', region: 'armR', from: 'RightForeArm', to: 'RightHand', wrap: [0.2, 0.92], pin: 'RightHand', dir: [-1, 0.55, 0.18], reach: 0.82, girth: 0.05, order: 3, tear: 1 },
  { id: 'legL', region: 'legL', from: 'LeftLeg', to: 'LeftFoot', wrap: [0.3, 0.88], pin: 'LeftFoot', ground: [1, 0.25], reach: 0.98, girth: 0.062, order: 4, tear: 2, give: 0.55 },
  { id: 'legR', region: 'legR', from: 'RightLeg', to: 'RightFoot', wrap: [0.3, 0.88], pin: 'RightFoot', ground: [-1, 0.25], reach: 0.98, girth: 0.062, order: 5, tear: 3, give: 0.55 },
  { id: 'chest', region: null, from: 'Spine1', to: 'Neck', wrap: [0.15, 0.8], pin: 'Spine2', dir: [0.15, 0.5, -1], reach: 0.28, girth: 0.17, order: 6, release: true }
];

const UP = new Vector3(0, 1, 0);
const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _d = new Vector3();
const _e = new Vector3();
const _p = new Vector3();
const _t = new Vector3();
const _n = new Vector3();
const _x = new Vector3();
const _y = new Vector3();
const _z = new Vector3();
const _u = new Vector3();
const _v = new Vector3();
const _s = new Vector3();
const _q = new Quaternion();
const _m = new Matrix4();
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

/** A unit vector perpendicular to `n`. */
function anyPerpendicular(n, out) {
  out.crossVectors(n, Math.abs(n.y) < 0.9 ? UP : _x.set(1, 0, 0));
  return out.normalize();
}

/** Quadratic Bézier and its tangent. */
function bezier(p0, p1, p2, t, out, tangent) {
  const k = 1 - t;
  out.set(0, 0, 0).addScaledVector(p0, k * k).addScaledVector(p1, 2 * k * t).addScaledVector(p2, t * t);
  if (tangent) {
    tangent.set(0, 0, 0).addScaledVector(p0, -2 * k).addScaledVector(p1, 2 * (k - t)).addScaledVector(p2, 2 * t);
  }
  return out;
}

/**
 * One chain's centreline, tip first: the points a frame's links are laid
 * along, with the distance to each from the tip.
 */
class Path {
  constructor() {
    this.points = Array.from({ length: MAX_PATH }, () => new Vector3());
    this.dist = new Float32Array(MAX_PATH);
    this.count = 0;
    this._cursor = 0;
  }

  reset() {
    this.count = 0;
    this._cursor = 0;
  }

  push(point) {
    if (this.count >= MAX_PATH) return;
    const i = this.count++;
    this.points[i].copy(point);
    this.dist[i] = i ? this.dist[i - 1] + point.distanceTo(this.points[i - 1]) : 0;
  }

  get length() {
    return this.count > 1 ? this.dist[this.count - 1] : 0;
  }

  /** The point `s` metres from the tip, and the way the chain runs there. Call with rising `s`. */
  sample(s, out, tangent) {
    const n = this.count;
    let i = this._cursor;
    while (i < n - 2 && this.dist[i + 1] < s) i++;
    this._cursor = i;
    const a = this.points[i];
    const b = this.points[Math.min(n - 1, i + 1)];
    const span = this.dist[Math.min(n - 1, i + 1)] - this.dist[i];
    const k = span > 1e-6 ? saturate((s - this.dist[i]) / span) : 0;
    out.lerpVectors(a, b, k);
    tangent.subVectors(b, a);
    if (tangent.lengthSq() < 1e-12) tangent.set(0, 1, 0);
    return tangent.normalize();
  }
}

/** One of the apertures in the air: its surface, its lens, and where it stands. */
class Portal {
  constructor(group) {
    this.centre = new Vector3();
    this.normal = new Vector3(0, 0, 1);
    this.axisX = new Vector3(1, 0, 0);
    this.axisY = new Vector3(0, 1, 0);
    this.radius = 0.4;
    this.seed = 0;
    this.flare = 0;
    this.pulse = 0;
    this.open = 0;
    this.live = false;
    this._state = {
      centre: this.centre,
      axisX: this.axisX,
      axisY: this.axisY,
      normal: this.normal,
      radius: 0.4,
      open: 0,
      draw: 0,
      ignite: 0,
      flare: 0,
      spin: 0,
      seed: 0,
      fade: 1,
      collapse: 0,
      strength: 0,
      pulse: 0
    };

    const quad = new PlaneGeometry(1, 1);
    this.material = createPortalMaterial();
    this.mesh = new Mesh(quad, this.material);
    this.mesh.name = 'ChainPortal';
    this.mesh.layers.set(LAYER.VFX);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 8;

    this.warpMaterial = createPortalWarpMaterial();
    this.warp = new Mesh(quad, this.warpMaterial);
    this.warp.layers.set(LAYER.DISTORTION);
    this.warp.frustumCulled = false;

    group.add(this.mesh, this.warp);
    this.hide();
  }

  hide() {
    this.mesh.visible = false;
    this.warp.visible = false;
    this.live = false;
    this.open = 0;
  }

  /** Stand it at `centre`, facing along `normal`. */
  place(centre, normal) {
    this.centre.copy(centre);
    this.normal.copy(normal).normalize();
    anyPerpendicular(this.normal, this.axisX);
    this.axisY.crossVectors(this.normal, this.axisX).normalize();
  }
}

/**
 * CHAINS OF PENANCE — a targeted far cast: one body, taken apart.
 *
 * The circle locks onto whoever is under the cursor. When the cast lands the
 * rite is laid out round them, facing the way they face, in five beats:
 *
 *   1. **The apertures.** Four small portals inscribe themselves in the air
 *      round the body, two in the floor at its feet and one under it — a
 *      stylus of light runs
 *      round each, leaving gold filigree, and an iris of black lacquer opens
 *      on a tunnel of rune light. A seal is cut into the stone under the body
 *      with a spoke run out toward every one of them.
 *   2. **The throw.** A chain comes out of each, barbed head first, on an arc
 *      with a wave thrown down it, homing on a limb. The first to land knocks
 *      the body off its feet; each one winds itself round its limb.
 *   3. **The hold.** They haul the body up off the floor and hold it spread
 *      in the air — every limb pinned out toward its own portal
 *      (`Ragdoll#pin`), the trunk held at the centre from the floor.
 *   4. **The strain.** They haul again, in ratchets, each one a jerk that
 *      sends a wave and a pulse of heat down every chain from its portal.
 *      The sockets give (`Ragdoll#loosen`) — the limbs come visibly out of
 *      the body, the skin stretching over the gap — and the seams the limbs
 *      will come away along light up, with veins of heat cracking out from
 *      them (`Dummy#strain`).
 *   5. **The quartering.** The limbs come away one after another
 *      (`Dummy#tear`) — arms, legs, then the head — each with a burst of
 *      blood and embers, each dragged straight back through its own portal
 *      and cut off by it as it goes (`Dummy#clip`). The chest chain lets go
 *      and whips home; the waist chain takes the trunk down through the floor.
 *      Every portal shuts behind what it took, and the blood is left on the
 *      seal.
 *
 * Like every ability here it captures nothing at the cast but a handful of
 * random numbers: where the portals stand, when each beat lands, how far
 * each limb is held out — all of it is re-solved off `settings.chains` every
 * frame, so the editor re-lays a rite that is half done. The chains are
 * built *after* the bodies have stepped (`lateUpdate`), off the joints the
 * solver has just placed, so a coil never trails the limb it is round.
 */
export class ChainsAbility extends Ability {
  constructor(context) {
    super('chains', context);
  }

  /** It picks one body and decides for itself when it is hit. */
  get handlesOwnHits() {
    return true;
  }

  get cameraWeight() {
    return this.u < 1 ? saturate(1 - this.u * 0.4) : 0.7;
  }

  get impactDuration() {
    return Math.max(this.endAt + 0.05, settings.chains.showTime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.chains.fadeTime);
  }

  get instanceCount() {
    return this.linkMesh.count;
  }

  /* ------------------------------------------------------------------ */
  /* construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /* ---- the links: one instanced draw for every chain ---- */
    const link = createLinkGeometry();
    this.glow = new InstancedBufferAttribute(new Float32Array(MAX_LINKS), 1).setUsage(DynamicDrawUsage);
    this.seed = new InstancedBufferAttribute(new Float32Array(MAX_LINKS), 1).setUsage(DynamicDrawUsage);
    link.setAttribute('aGlow', this.glow);
    link.setAttribute('aSeed', this.seed);
    this.linkMaterial = createChainMaterial();
    this.linkMesh = new InstancedMesh(link, this.linkMaterial, MAX_LINKS);
    this.linkMesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.linkMesh.name = 'ChainLinks';
    this.linkMesh.layers.set(LAYER.WORLD);
    this.linkMesh.castShadow = true;
    this.linkMesh.receiveShadow = true;
    this.linkMesh.frustumCulled = false;
    this.linkMesh.count = 0;
    this.group.add(this.linkMesh);

    /* ---- the barbed heads ---- */
    const hook = createHookGeometry();
    this.hookGlow = new InstancedBufferAttribute(new Float32Array(SPECS.length), 1).setUsage(DynamicDrawUsage);
    this.hookSeed = new InstancedBufferAttribute(new Float32Array(SPECS.length), 1).setUsage(DynamicDrawUsage);
    hook.setAttribute('aGlow', this.hookGlow);
    hook.setAttribute('aSeed', this.hookSeed);
    this.hookMaterial = createChainMaterial({ hook: true });
    this.hookMesh = new InstancedMesh(hook, this.hookMaterial, SPECS.length);
    this.hookMesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.hookMesh.name = 'ChainHooks';
    this.hookMesh.layers.set(LAYER.WORLD);
    this.hookMesh.castShadow = true;
    this.hookMesh.frustumCulled = false;
    this.hookMesh.count = 0;
    this.group.add(this.hookMesh);

    /* ---- the portals ---- */
    this.portals = SPECS.map(() => new Portal(this.group));

    /* ---- the seal on the floor ---- */
    const flat = new PlaneGeometry(1, 1);
    flat.rotateX(-Math.PI / 2);
    this.sealMaterial = createSealMaterial();
    this.seal = new Mesh(flat, this.sealMaterial);
    this.seal.name = 'ChainSeal';
    this.seal.layers.set(LAYER.VFX);
    this.seal.renderOrder = 5;
    this.seal.frustumCulled = false;
    this.seal.visible = false;
    this.group.add(this.seal);
    this._sealState = {
      quad: 6,
      radius: 2,
      draw: 0,
      glow: 1,
      flare: 0,
      seed: 0,
      fade: 1,
      blood: 0,
      bloodAmount: 0,
      bloodX: 0,
      bloodZ: 0,
      spokes: SPECS.map(() => ({ x: 0, z: 0, w: 0 }))
    };

    /* ---- the chains ---- */
    this.chains = SPECS.map((spec, i) => ({
      spec,
      portal: this.portals[i],
      path: new Path(),
      jitter: new Vector3(),
      curl: new Vector3(),
      spread: 0,
      seed: 0,
      phase: 0,
      // the timeline, re-solved every frame
      openAt: 0,
      fireAt: 0,
      hitAt: 0,
      tearAt: Infinity,
      releaseAt: Infinity,
      homeAt: Infinity,
      closeAt: Infinity,
      // what has happened to it
      hit: false,
      caught: false,
      torn: false,
      released: false,
      home: false,
      coilFlip: false,
      coilTheta: 0,
      // where it was when things happened
      tearFrom: new Vector3(),
      releaseFrom: new Vector3(),
      // what this frame made of it
      tip: new Vector3(),
      tipDir: new Vector3(0, 1, 0),
      coilStart: new Vector3(),
      hold: new Vector3(),
      length: 0,
      lastLength: 0,
      coilLength: 0,
      tension: 0,
      heat: 0,
      flash: 0,
      wrap: 0,
      visible: false
    }));

    /* ---- state ---- */
    this.target = new Vector3();
    this.hang = new Vector3();
    this.hangFrom = new Vector3();
    this.hangNow = new Vector3();
    this.left = new Vector3(1, 0, 0);
    this.fwd = new Vector3(0, 0, 1);
    this.victim = null;
    this.taken = false;
    this.victimDone = false;
    this.fieldAge = 0;
    this.firstHit = Infinity;
    this.tearStart = Infinity;
    this.lastTear = Infinity;
    this.dragAt = Infinity;
    this.endAt = 0;
    this.haul = 0;
    this.jerk = 0;
    this.jerkAt = -1;
    this.firstBlood = Infinity;
    this.portalLight = null;
    this._targets = [];
    this._joint = new Vector3();
    this._jointB = new Vector3();
    this._jointQ = new Quaternion();
    this._sealSeed = 0;

    this._embers = new RateEmitter(20);
    this._smoke = new RateEmitter(6);
    this._sparks = new RateEmitter(30);
    this._travel = new RateEmitter(60);
    this._drips = new RateEmitter(40);
  }

  createParticles() {
    const P = this.ctx.particles;
    this.sparks = P.get('chainSpark', {
      capacity: 900,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.1
    });
    this.embers = P.get('chainEmber', {
      capacity: 600,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.2
    });
    this.blood = P.get('chainBlood', {
      capacity: 1200,
      shape: ParticleShape.DROPLET,
      additive: false,
      stretch: true,
      softFade: 0.1
    });
    this.gore = P.get('chainGore', {
      capacity: 160,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.05
    });
    this.smoke = P.get('chainSmoke', {
      capacity: 320,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 0.6
    });
    this.glints = P.get('chainGlint', { capacity: 120, shape: ParticleShape.GLINT, additive: true });
  }

  /* ------------------------------------------------------------------ */
  /* lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.fieldAge = 0;
    this.victim = null;
    this.taken = false;
    this.victimDone = false;
    this.firstHit = Infinity;
    this.endAt = 0;
    this.haul = 0;
    this.jerk = 0;
    this.jerkAt = -1;
    this.firstBlood = Infinity;
    for (const chain of this.chains) this._resetChain(chain);
    for (const portal of this.portals) portal.hide();
    this.linkMesh.count = 0;
    this.hookMesh.count = 0;
    this.seal.visible = false;
    for (const emitter of [this._embers, this._smoke, this._sparks, this._travel, this._drips]) emitter.reset();
  }

  _resetChain(chain) {
    chain.hit = false;
    chain.caught = false;
    chain.torn = false;
    chain.released = false;
    chain.home = false;
    chain.visible = false;
    chain.length = 0;
    chain.lastLength = 0;
    chain.flash = 0;
    chain.wrap = 0;
    chain.tension = 0;
    chain.heat = 0;
  }

  onDestroy() {
    this._letGo();
    this.ctx.lights.release(this.portalLight);
    this.portalLight = null;
    for (const portal of this.portals) portal.hide();
    this.linkMesh.count = 0;
    this.hookMesh.count = 0;
    this.seal.visible = false;
  }

  /** Whatever the chains had hold of falls from wherever it has got to. */
  _letGo() {
    const victim = this.victim;
    if (victim && this.taken && !this.victimDone) {
      victim.unpin();
      for (const chain of this.chains) {
        if (chain.spec.region) victim.clip(chain.spec.region, null);
      }
      victim.clip(null, null);
      victim.release();
    }
    this.victim = null;
    this.taken = false;
  }

  /* ------------------------------------------------------------------ */
  /* the cast's run to the target                                        */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    // A line of gold sparks skating over the stone to where it is going.
    const n = this._travel.tick(dt, 60 * settings.global.particleCount);
    for (let i = 0; i < n; i++) {
      _emit.position.copy(this.position).setY(0.06);
      _emit.direction.copy(this.direction).negate().setY(0.6).normalize();
      _emit.radius = 0.12;
      _emit.speed = 3;
      _emit.speedVariance = 0.5;
      _emit.spread = 0.5;
      _emit.size = 0.035;
      _emit.sizeVariance = 0.5;
      _emit.life = 0.35;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = frame.uTime.value;
      this.sparks.emit(1, _emit);
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

    // The body's own frame — the rite is laid out the way they were facing.
    const yaw = this.victim ? this.victim.facing : Math.atan2(-this.direction.x, -this.direction.z);
    this.fwd.set(Math.sin(yaw), 0, Math.cos(yaw));
    this.left.set(Math.cos(yaw), 0, -Math.sin(yaw));

    for (const chain of this.chains) {
      this._resetChain(chain);
      chain.jitter.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(2);
      chain.curl.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      chain.spread = Math.random();
      chain.seed = Math.random() * 10;
      chain.phase = Math.random() * TAU;
      chain.portal.seed = Math.random() * 10;
      chain.portal.flare = 0;
      chain.portal.pulse = 0;
      chain.portal.live = true;
    }
    this._sealSeed = Math.random();
    this.seal.visible = true;
    this.hangFrom.copy(this.target).setY(1.0);
    this.hangNow.copy(this.hangFrom);

    if (!this.portalLight) this.portalLight = this.ctx.lights.acquire();
    this._plan(c);
    this.position.copy(this.hang);
  }

  /* ------------------------------------------------------------------ */
  /* the plan                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Lay the rite out against the current settings: where every portal
   * stands, and when every beat lands. Pure — called every frame.
   */
  _plan(c) {
    this.hang.set(this.target.x, c.hangHeight, this.target.z);

    for (const chain of this.chains) {
      const spec = chain.spec;
      const portal = chain.portal;
      if (spec.floor) {
        _p.set(this.target.x, 0.03, this.target.z);
        portal.place(_p, UP);
        portal.radius = c.floorPortalRadius;
      } else if (spec.ground) {
        const span = c.groundSpan * (1 + chain.spread * 0.25);
        _p.copy(this.target)
          .addScaledVector(this.left, spec.ground[0] * span + chain.jitter.x * c.portalJitter)
          .addScaledVector(this.fwd, spec.ground[1] * span + chain.jitter.z * c.portalJitter);
        _p.y = 0.03;
        portal.place(_p, UP);
        portal.radius = c.portalRadius * 1.1;
      } else {
        _d.set(0, 0, 0)
          .addScaledVector(this.left, spec.dir[0])
          .addScaledVector(UP, spec.dir[1])
          .addScaledVector(this.fwd, spec.dir[2])
          .normalize()
          .addScaledVector(chain.jitter, c.portalJitter)
          .normalize();
        const distance = c.portalDistance + chain.spread * c.portalSpread;
        _p.copy(this.hang).addScaledVector(_d, distance);
        _p.y = Math.max(_p.y, c.portalMinHeight + c.portalRadius);
        // Facing the point it is going to hold its limb at.
        _n.copy(this.hang).addScaledVector(_d, spec.reach * c.reach).sub(_p).normalize();
        portal.place(_p, _n);
        portal.radius = c.portalRadius;
      }

      chain.openAt = spec.order * c.portalStagger;
      chain.fireAt = c.fireDelay + spec.order * c.fireStagger;
      chain.hitAt = chain.fireAt + Math.max(0.03, c.flightTime);
    }

    // The hauls, then the limbs in order, then the trunk.
    const ratchets = Math.max(1, Math.round(c.ratchets));
    this.tearStart = c.strainStart + ratchets * c.ratchetPeriod;
    let lastTear = this.tearStart;
    for (const chain of this.chains) {
      const spec = chain.spec;
      chain.tearAt = Infinity;
      if (!chain.released) chain.releaseAt = Infinity;
      if (spec.tear !== undefined && !(chain.released && !chain.torn)) {
        chain.tearAt = this.tearStart + spec.tear * c.tearStagger;
        lastTear = Math.max(lastTear, chain.tearAt);
      }
      if (spec.release && !chain.released) chain.releaseAt = this.tearStart + 2.5 * c.tearStagger;
    }
    this.lastTear = lastTear;
    this.dragAt = lastTear + c.dragDelay;

    // With nobody to hold, every chain lets go when the hauling would start.
    if (!this.taken && this.firstHit < Infinity) {
      for (const chain of this.chains) {
        if (chain.torn) continue;
        chain.tearAt = Infinity;
        if (!chain.released) chain.releaseAt = Math.min(chain.releaseAt, c.strainStart);
      }
      this.dragAt = Infinity;
    }

    const retract = 0.3;
    let end = 0;
    for (const chain of this.chains) {
      const spec = chain.spec;
      let home;
      if (spec.floor) home = this.dragAt < Infinity ? this.dragAt + c.dragTime : chain.releaseAt + retract;
      else if (chain.tearAt < Infinity && !chain.released) home = chain.tearAt + c.recoilTime;
      else home = chain.releaseAt + retract;
      if (!Number.isFinite(home)) home = this.tearStart + retract;
      chain.homeAt = home;
      chain.closeAt = home + c.closeDelay;
      end = Math.max(end, chain.closeAt + c.closeTime);
    }
    this.endAt = end;
  }

  /** Where the body's centre is held at this moment of the rite. */
  _hangPoint(c, age, out) {
    if (this.firstHit === Infinity) return out.copy(this.hangFrom);
    const lift = Easing.inOutCubic(saturate((age - this.firstHit) / Math.max(0.05, c.liftTime)));
    return out.lerpVectors(this.hangFrom, this.hang, lift);
  }

  /** 0..1, how far the hauling has got — a step per ratchet, each one a jerk. */
  _haulLevel(c, age) {
    const ratchets = Math.max(1, Math.round(c.ratchets));
    let level = 0;
    let jerk = 0;
    for (let k = 0; k < ratchets; k++) {
      const at = c.strainStart + k * c.ratchetPeriod;
      const x = (age - at) / Math.max(0.01, c.ratchetSnap);
      if (x <= 0) continue;
      level += Easing.outBack(Math.min(1, x));
      if (x < 6) jerk = Math.max(jerk, Math.exp(-x * 0.9) * (0.6 + 0.4 * (k + 1) / ratchets));
    }
    // A slow creep between the jerks, so the seams never stop climbing.
    const creep = saturate((age - c.strainStart) / Math.max(0.05, ratchets * c.ratchetPeriod)) * 0.12;
    this.jerk = jerk;
    return saturate(level / ratchets * 0.9 + creep);
  }

  /* ------------------------------------------------------------------ */
  /* the rite                                                            */
  /* ------------------------------------------------------------------ */

  /** @param {number} t 0..1 the rite, 1..2 the seal and the blood fading */
  onFade(dt, t) {
    const c = this.config;
    this.fieldAge += dt;
    const age = this.fieldAge;
    const fading = t > 1 ? saturate(t - 1) : 0;
    this._plan(c);

    this.haul = this._haulLevel(c, age);
    this._hangPoint(c, age, this.hangNow);

    this._throw(c, age);
    this._hold(dt, c, age);
    this._portalFrame(dt, c, age);
    this._ambient(dt, c, age);
    this._sealFrame(dt, c, age, fading);
    this._lights(dt, c);
    this._dress(c);

    this.position.copy(this.hangNow);
    if (this.dragAt < Infinity && age > this.dragAt) {
      this.position.y = Math.max(0.6, this.hangNow.y - (age - this.dragAt) * 2);
    }
  }

  /**
   * The rite's own light comes up off the seal, not out of the body: a light
   * inside the thing it is lighting only blows it out, and gold from below is
   * the look of the whole ability anyway.
   */
  _updateLight(dt, scale) {
    const at = this.position;
    const saved = _a.copy(at);
    if (this.phase !== 'travel') at.set(this.target.x, 0.45, this.target.z);
    super._updateLight(dt, scale);
    at.copy(saved);
  }

  /* ---- the throw and the catch ---- */

  _throw(c, age) {
    for (const chain of this.chains) {
      if (chain.hit || age < chain.hitAt) continue;
      chain.hit = true;
      const victim = this.victim;

      // The first chain to land takes the body off its feet.
      if (victim && !this.taken && this.firstHit === Infinity) {
        if (victim.alive) {
          victim.kill(this.direction.x, this.direction.z, c.kick);
          this.taken = true;
        } else if (victim.state === 'dead' && !victim.sliced) {
          this.taken = true;
        } else {
          this.victim = null;
        }
      }
      if (this.firstHit === Infinity) {
        this.firstHit = age;
        // The hang starts from wherever the body was when it was struck.
        if (!this.taken || !this.victim.bodyPoint(this.hangFrom)) this.hangFrom.copy(this.target).setY(1.0);
      }

      if (this.taken) this._measureCoil(chain);
      this._hitFx(chain, c);
    }
  }

  /**
   * Where on its limb a chain's coil starts, and which way round it winds —
   * fixed in the bone's own frame at the moment it lands, so the coil turns
   * with the limb from then on rather than sliding round it.
   */
  _measureCoil(chain) {
    const victim = this.victim;
    const spec = chain.spec;
    if (!victim?.joint(spec.from, _a) || !victim.joint(spec.to, _b) || !victim.jointQuaternion(spec.from, this._jointQ)) return;
    const P = chain.portal.centre;
    _e.subVectors(_b, _a);
    const near0 = _c.copy(_a).addScaledVector(_e, spec.wrap[0]).distanceToSquared(P);
    const near1 = _c.copy(_a).addScaledVector(_e, spec.wrap[1]).distanceToSquared(P);
    chain.coilFlip = near1 < near0;
    this._coilAxes(_e, this._jointQ, _u, _v);
    _d.subVectors(P, _a);
    chain.coilTheta = Math.atan2(_d.dot(_v), _d.dot(_u));
  }

  /** Two axes square to the limb, turning with its bone. */
  _coilAxes(axis, quat, u, v) {
    _n.copy(axis).normalize();
    u.set(1, 0, 0).applyQuaternion(quat);
    u.addScaledVector(_n, -u.dot(_n));
    if (u.lengthSq() < 1e-6) {
      u.set(0, 0, 1).applyQuaternion(quat);
      u.addScaledVector(_n, -u.dot(_n));
    }
    u.normalize();
    v.crossVectors(_n, u).normalize();
  }

  /**
   * A point on a chain's coil. `tau` runs 0 where the chain arrives to 1 at
   * the far end of the winding. False if the limb cannot be found.
   */
  _coilPoint(chain, tau, c, out) {
    const victim = this.victim;
    const spec = chain.spec;
    if (!victim) return false;
    if (!victim.joint(spec.from, this._joint) || !victim.joint(spec.to, this._jointB)) return false;
    if (!victim.jointQuaternion(spec.from, this._jointQ)) return false;
    _e.subVectors(this._jointB, this._joint);
    this._coilAxes(_e, this._jointQ, _u, _v);
    const mid = (spec.wrap[0] + spec.wrap[1]) * 0.5;
    const half = (spec.wrap[1] - spec.wrap[0]) * 0.5 * c.wrapReach;
    const f0 = chain.coilFlip ? mid + half : mid - half;
    const f1 = chain.coilFlip ? mid - half : mid + half;
    const along = f0 + (f1 - f0) * tau;
    const theta = chain.coilTheta + tau * c.wrapTurns * TAU;
    const r = spec.girth * c.wrapRadius + c.linkLength * 0.16 * c.linkThickness;
    out.copy(this._joint).addScaledVector(_e, along);
    out.addScaledVector(_u, Math.cos(theta) * r).addScaledVector(_v, Math.sin(theta) * r);
    return true;
  }

  _hitFx(chain, c) {
    const g = settings.global;
    const time = frame.uTime.value;
    if (this.taken) this._coilPoint(chain, 0, c, _p);
    else _p.copy(this.hang).addScaledVector(_d.subVectors(chain.portal.centre, this.hang).normalize(), 0.35);
    chain.flash = 1;
    chain.portal.flare = Math.max(chain.portal.flare, 0.8);

    _emit.position.copy(_p);
    _emit.direction.subVectors(_p, chain.portal.centre).normalize();
    _emit.radius = 0.05;
    _emit.speed = 5;
    _emit.speedVariance = 0.6;
    _emit.spread = 0.9;
    _emit.size = 0.03;
    _emit.sizeVariance = 0.5;
    _emit.life = 0.4;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.sparks.emit(Math.round(26 * g.particleCount), _emit);
    _emit.speed = 0;
    _emit.spread = 0;
    _emit.size = 0.55;
    _emit.life = 0.14;
    _emit.spin = 3;
    this.glints.emit(1, _emit);

    this.lightBoost = Math.max(this.lightBoost, 6 * g.explosionIntensity);
    this.ctx.shake.add(0.05 * g.explosionIntensity * g.cameraShake, 3, 26);
  }

  /* ---- the hold, the strain and the quartering ---- */

  _hold(dt, c, age) {
    const victim = this.victim;
    if (!victim || !this.taken || this.victimDone) return;

    // Somebody stood it back up (T), or something else finished it.
    if (victim.alive || victim.state === 'gone' || victim.state === 'frozen') {
      this.victim = null;
      this.taken = false;
      for (const chain of this.chains) {
        if (!chain.released && !chain.torn) {
          chain.released = true;
          chain.releaseAt = age;
          chain.releaseFrom.copy(chain.tip);
        }
      }
      return;
    }

    victim.hold();
    const haul = this.haul;
    const H = this.hangNow;

    for (const chain of this.chains) {
      const spec = chain.spec;
      if (!chain.hit) continue;
      const P = chain.portal.centre;
      const catchK = smoothstep(0, 1, (age - chain.hitAt - c.wrapTime * 0.5) / Math.max(0.01, c.catchTime));

      /* ---- the limbs come away ---- */
      if (spec.region && !chain.torn && age >= chain.tearAt) {
        victim.joint(spec.pin, chain.tearFrom);
        if (victim.tear(spec.region, c.tear)) {
          chain.torn = true;
          victim.clip(spec.region, chain.portal.normal, P);
          // Its way home is through the floor: take the floor away.
          if (spec.ground) victim.sink(c.recoilDepth + 2);
          this._tearFx(chain, c);
        } else {
          chain.released = true;
          chain.releaseAt = age;
          chain.releaseFrom.copy(chain.tip);
        }
      }

      /* ---- the chest lets go ---- */
      if (spec.release && !chain.released && age >= chain.releaseAt) {
        chain.released = true;
        chain.releaseFrom.copy(chain.tip);
        victim.unpin(spec.pin);
        chain.portal.flare = Math.max(chain.portal.flare, 0.6);
      }
      if (chain.released) continue;

      if (chain.torn) {
        // Dragged home: back along the chain's line and on through the portal.
        const x = saturate((age - chain.tearAt) / Math.max(0.05, c.recoilTime));
        _p.lerpVectors(chain.tearFrom, P, Easing.inCubic(Math.min(1, x * 1.25)));
        if (x > 0.8) _p.addScaledVector(chain.portal.normal, -c.recoilDepth * (x - 0.8) / 0.2);
        victim.pin(spec.pin, _p, 0.5);
        continue;
      }

      if (spec.floor) {
        if (this.dragAt < Infinity && age >= this.dragAt) {
          // Down through the floor.
          const x = Easing.inCubic(saturate((age - this.dragAt) / Math.max(0.05, c.dragTime)));
          _p.copy(H).lerp(P, Math.min(1, x * 1.15));
          _p.y -= Math.max(0, x * 1.15 - 1) * 2 + x * 1.2;
          victim.pin(spec.pin, _p, 0.4);
          victim.sink(4);
          victim.clip(null, UP, P);
        } else {
          victim.pin(spec.pin, H, c.waistGrip * catchK);
        }
        continue;
      }

      // Held out toward its portal — and hauled further on every ratchet.
      _d.subVectors(P, H).normalize();
      const reach = spec.reach * c.reach * (1 + c.reachGain * haul);
      chain.hold.copy(H).addScaledVector(_d, reach);
      victim.pin(spec.pin, chain.hold, c.grip * catchK);

      if (spec.region) {
        victim.strain(spec.region, haul * c.seamStrain, c.tear);
        victim.loosen(spec.region, haul * c.stretch * (spec.give ?? 1));
      }
    }

    // The trunk is through: the rite is over for this body.
    if (this.dragAt < Infinity && age > this.dragAt + c.dragTime + 0.1) {
      victim.consume(1);
      victim.unpin();
      this.victimDone = true;
    }

    if (haul > 0 && age < this.tearStart) {
      this.ctx.shake.rumble?.(c.strainRumble * haul * settings.global.cameraShake, dt);
    }
    // Every haul: a jerk down every chain.
    if (this.jerk > 0.55 && age - this.jerkAt > c.ratchetPeriod * 0.6 && age < this.tearStart) {
      this.jerkAt = age;
      this._ratchetFx(c);
    }
  }

  _ratchetFx(c) {
    const g = settings.global;
    const time = frame.uTime.value;
    for (const chain of this.chains) {
      if (!chain.hit || chain.released || chain.torn) continue;
      chain.portal.flare = Math.max(chain.portal.flare, 1);
      chain.portal.pulse = 0.001;
      chain.flash = Math.max(chain.flash, 0.7);
      // Sparks off the coil, where it bites.
      _emit.position.copy(chain.coilStart);
      _emit.direction.subVectors(chain.portal.centre, chain.coilStart).normalize().negate();
      _emit.radius = 0.06;
      _emit.speed = 3.5;
      _emit.speedVariance = 0.6;
      _emit.spread = 1;
      _emit.size = 0.025;
      _emit.sizeVariance = 0.5;
      _emit.life = 0.35;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.sparks.emit(Math.round(10 * g.particleCount), _emit);
    }
    this._sealState.flare = 1;
    this.lightBoost = Math.max(this.lightBoost, c.ratchetLight * g.explosionIntensity);
    this.ctx.shake.add(c.jerkShake * g.explosionIntensity * g.cameraShake, 4, 30);
  }

  /** A limb coming away: blood, meat, embers, and the hit of it. */
  _tearFx(chain, c) {
    const g = settings.global;
    const time = frame.uTime.value;
    const victim = this.victim;
    const socket = victim?.joint(TEAR_SOCKET[chain.spec.region], _p) ?? chain.tearFrom;
    _d.subVectors(chain.tearFrom, socket).normalize();
    if (this.firstBlood === Infinity) {
      this.firstBlood = this.fieldAge;
      this._sealState.bloodX = 0;
      this._sealState.bloodZ = 0;
    }

    // Blood out of the wound, both ways: after the limb and out of the trunk.
    for (const sign of [1, -0.6]) {
      _emit.position.copy(socket);
      _emit.direction.copy(_d).multiplyScalar(sign).addScaledVector(UP, 0.35).normalize();
      _emit.radius = 0.06;
      _emit.speed = c.bloodSpeed * Math.abs(sign);
      _emit.speedVariance = 0.6;
      _emit.spread = 0.55;
      _emit.size = 0.03;
      _emit.sizeVariance = 0.7;
      _emit.life = 1.1;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.blood.emit(Math.round(c.bloodCount * 0.5 * g.particleCount), _emit);
    }
    _emit.position.copy(socket);
    _emit.direction.copy(_d);
    _emit.speed = c.bloodSpeed * 0.7;
    _emit.spread = 0.9;
    _emit.size = 0.045;
    _emit.sizeVariance = 0.6;
    _emit.life = 1.4;
    _emit.spin = 9;
    this.gore.emit(Math.round(c.goreCount * g.particleCount), _emit);

    _emit.speed = 4;
    _emit.spread = 1;
    _emit.size = 0.05;
    _emit.life = 0.9;
    _emit.spin = 0;
    this.embers.emit(Math.round(c.emberCount * g.particleCount), _emit);
    _emit.speed = 7;
    _emit.size = 0.03;
    _emit.life = 0.45;
    this.sparks.emit(Math.round(c.emberCount * 0.6 * g.particleCount), _emit);

    _emit.speed = 0.8;
    _emit.spread = 0.8;
    _emit.size = 0.45;
    _emit.sizeVariance = 0.4;
    _emit.life = 1.3;
    _emit.spin = 1.2;
    this.smoke.emit(Math.round(c.mistCount * g.particleCount), _emit);

    _emit.speed = 0;
    _emit.spread = 0;
    _emit.size = 1.2;
    _emit.life = 0.12;
    _emit.spin = 3;
    this.glints.emit(1, _emit);

    // One ring across the floor for the first limb, and one for the last.
    const spec = chain.spec;
    if (spec.tear === 0 || spec.tear === 4) {
      _p.set(this.hang.x, 0, this.hang.z);
      this.ctx.decals.spawn(DecalType.SHOCKWAVE, _p, {
        radius: spec.tear === 4 ? 4 : 3,
        life: 0.5,
        intensity: 0.45,
        width: 0.035,
        colorA: getColor(c.colorGold),
        colorB: getColor(c.colorDeep)
      });
    }

    chain.flash = 1.6;
    chain.portal.flare = 1.4;
    chain.portal.pulse = 0.001;
    this._sealState.flare = 1.2;
    this.lightBoost = Math.max(this.lightBoost, c.tearLight * g.explosionIntensity);
    this.ctx.shake.add(c.tearShake * g.explosionIntensity * g.cameraShake, 3, 24);
    if (c.tearFlash > 0) this.ctx.flash.trigger(getColor(c.colorDeep), c.tearFlash * g.explosionIntensity);
  }

  /* ---- the portals ---- */

  _portalFrame(dt, c, age) {
    for (const chain of this.chains) {
      const portal = chain.portal;
      const s = portal._state;
      const local = age - chain.openAt;
      if (local < 0 || !portal.live) {
        portal.mesh.visible = false;
        portal.warp.visible = false;
        portal.open = 0;
        continue;
      }

      const openTime = Math.max(0.05, c.portalOpen);
      const closeTime = Math.max(0.05, c.closeTime);
      const draw = saturate(local / (openTime * 0.6));
      let open = Easing.outBack(saturate((local - openTime * 0.35) / (openTime * 0.65)));
      const closing = age - chain.closeAt;
      const shut = saturate(closing / (closeTime * 0.45));
      const collapse = Easing.inCubic(saturate((closing - closeTime * 0.3) / (closeTime * 0.7)));
      open *= 1 - Easing.inQuad(shut);
      // A spark lights it, and another puts it out.
      const ignite = Math.exp(-local * 16) + (closing > 0 ? Math.exp(-Math.max(0, closing - closeTime * 0.8) * 18) * smoothstep(closeTime * 0.5, closeTime * 0.85, closing) : 0);

      if (closing > closeTime) {
        if (portal.live) this._closeFx(portal, c);
        portal.hide();
        continue;
      }

      portal.open = open;
      portal.flare = Math.max(0, portal.flare - dt * 4.5);
      if (portal.pulse > 0) portal.pulse = portal.pulse >= 1 ? 0 : Math.min(1, portal.pulse + dt / 0.45);

      s.radius = portal.radius;
      s.open = open;
      s.draw = draw;
      s.ignite = ignite;
      s.flare = portal.flare;
      s.spin = age * c.portalSpin + portal.seed;
      s.seed = portal.seed;
      s.fade = 1 - collapse * collapse;
      s.collapse = collapse;
      s.strength = Math.max(open, portal.flare * 0.5);
      s.pulse = portal.pulse;
      portal.material.userData.sync(s);
      portal.mesh.visible = true;
      portal.warp.visible = c.warpStrength > 0 && s.strength > 0.01;
      if (portal.warp.visible) portal.warpMaterial.userData.sync(s);

      if (local < dt * 1.5 && local >= 0) this._igniteFx(portal);
    }
  }

  _igniteFx(portal) {
    _emit.position.copy(portal.centre);
    _emit.direction.copy(portal.normal);
    _emit.radius = 0;
    _emit.speed = 0;
    _emit.spread = 0;
    _emit.size = 0.9;
    _emit.sizeVariance = 0.2;
    _emit.life = 0.16;
    _emit.lifeVariance = 0.2;
    _emit.spin = 4;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.glints.emit(1, _emit);
  }

  _closeFx(portal, c) {
    const g = settings.global;
    _emit.position.copy(portal.centre);
    _emit.direction.copy(portal.normal);
    _emit.radius = portal.radius * 0.6;
    _emit.speed = 2.2;
    _emit.speedVariance = 0.6;
    _emit.spread = 1;
    _emit.size = 0.035;
    _emit.sizeVariance = 0.5;
    _emit.life = 0.6;
    _emit.lifeVariance = 0.4;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.embers.emit(Math.round(18 * g.particleCount), _emit);
    _emit.radius = 0;
    _emit.speed = 0;
    _emit.spread = 0;
    _emit.size = 0.7;
    _emit.life = 0.12;
    _emit.spin = 3;
    this.glints.emit(1, _emit);
    this.lightBoost = Math.max(this.lightBoost, 4 * g.explosionIntensity);
  }

  /* ---- the air round it ---- */

  _ambient(dt, c, age) {
    const g = settings.global;
    const time = frame.uTime.value;
    let open = 0;
    for (const portal of this.portals) if (portal.open > 0.2) open++;
    if (!open) return;

    const embers = this._embers.tick(dt, c.emberRate * open * g.particleCount);
    const smoke = this._smoke.tick(dt, c.smokeRate * open * g.particleCount);
    let k = 0;
    for (const portal of this.portals) {
      if (portal.open <= 0.2) continue;
      const share = (count) => Math.floor(count / open) + (k < count % open ? 1 : 0);
      const ne = share(embers);
      for (let i = 0; i < ne; i++) {
        const a = Math.random() * TAU;
        const r = portal.radius * (0.9 + Math.random() * 0.4);
        _emit.position.copy(portal.centre).addScaledVector(portal.axisX, Math.cos(a) * r).addScaledVector(portal.axisY, Math.sin(a) * r);
        _emit.direction.copy(portal.normal).addScaledVector(UP, 0.6).normalize();
        _emit.radius = 0.02;
        _emit.speed = 0.5;
        _emit.speedVariance = 0.6;
        _emit.spread = 0.6;
        _emit.size = 0.022;
        _emit.sizeVariance = 0.5;
        _emit.life = 1.1;
        _emit.lifeVariance = 0.4;
        _emit.spin = 0;
        _emit.tint = null;
        _emit.time = time;
        this.embers.emit(1, _emit);
      }
      const ns = share(smoke);
      for (let i = 0; i < ns; i++) {
        _emit.position.copy(portal.centre).addScaledVector(portal.normal, 0.05);
        _emit.direction.copy(portal.normal).addScaledVector(UP, 0.3).normalize();
        _emit.radius = portal.radius * 0.5;
        _emit.speed = 0.35;
        _emit.speedVariance = 0.5;
        _emit.spread = 0.4;
        _emit.size = portal.radius * 0.9;
        _emit.sizeVariance = 0.4;
        _emit.life = 1.4;
        _emit.lifeVariance = 0.3;
        _emit.spin = 0.8;
        this.smoke.emit(1, _emit);
      }
      k++;
    }

    // Blood off the torn limbs on their way home.
    const drips = this._drips.tick(dt, 40 * g.particleCount);
    if (drips && this.victim) {
      for (const chain of this.chains) {
        if (!chain.torn || age > chain.tearAt + c.recoilTime) continue;
        if (!this.victim.joint(TEAR_SOCKET[chain.spec.region], _p)) continue;
        _emit.position.copy(_p);
        _emit.direction.set(0, -1, 0);
        _emit.radius = 0.05;
        _emit.speed = 0.8;
        _emit.speedVariance = 0.5;
        _emit.spread = 0.5;
        _emit.size = 0.025;
        _emit.sizeVariance = 0.5;
        _emit.life = 0.8;
        _emit.lifeVariance = 0.3;
        _emit.spin = 0;
        _emit.tint = null;
        _emit.time = time;
        this.blood.emit(Math.max(1, Math.round(drips / 3)), _emit);
      }
    }
  }

  /* ---- the seal ---- */

  _sealFrame(dt, c, age, fading) {
    const s = this._sealState;
    const R = Math.max(0.3, c.sealRadius);
    s.radius = R;
    s.quad = R * 2 * 1.9;
    s.draw = saturate(age / Math.max(0.05, c.sealDraw));
    s.flare = Math.max(0, s.flare - dt * 3);
    // The gold goes out once the trunk is gone; the blood stays and dries.
    const lit = 1 - smoothstep(this.endAt - 0.6, this.endAt, age);
    s.glow = lit * (0.6 + 0.4 * this.haul);
    s.seed = this._sealSeed;
    s.fade = 1 - fading;
    const bled = this.firstBlood < Infinity ? saturate((age - this.firstBlood) / Math.max(0.05, c.bloodGrow)) : 0;
    s.blood = c.bloodPool * Math.sqrt(bled);
    s.bloodAmount = bled > 0 ? 1 : 0;
    for (let i = 0; i < this.chains.length; i++) {
      const chain = this.chains[i];
      const spoke = s.spokes[i];
      if (chain.spec.floor) {
        spoke.w = 0;
        continue;
      }
      _d.subVectors(chain.portal.centre, this.hang).setY(0);
      const len = _d.length();
      if (len < 1e-3) {
        spoke.w = 0;
        continue;
      }
      spoke.x = _d.x / len;
      spoke.z = _d.z / len;
      spoke.w = smoothstep(chain.openAt, chain.openAt + 0.2, age) * (chain.home ? 0.4 : 1);
    }
    this.seal.position.set(this.target.x, 0.012, this.target.z);
    this.seal.scale.set(s.quad, 1, s.quad);
    this.sealMaterial.userData.sync(s);
    this.seal.visible = s.fade > 0.001;
  }

  _lights(dt, c) {
    const g = settings.global;
    if (!this.portalLight) return;
    let best = null;
    let level = 0;
    for (const portal of this.portals) {
      if (!portal.mesh.visible) continue;
      const v = portal.open * 0.4 + portal.flare;
      if (v > level) {
        level = v;
        best = portal;
      }
    }
    if (!best) {
      this.ctx.lights.set(this.portalLight, this.hang, getColor(c.colorGold), 0, c.portalLightRadius, dt);
      return;
    }
    _p.copy(best.centre).addScaledVector(best.normal, 0.3);
    this.ctx.lights.set(this.portalLight, _p, getColor(c.colorGold), c.portalLight * level * g.lightIntensity, c.portalLightRadius * g.lightRadius, dt);
  }

  lightShimmer() {
    return 0.85 + 0.15 * Math.sin(this.age * 23.0) * Math.sin(this.age * 7.1);
  }

  /* ------------------------------------------------------------------ */
  /* the chains themselves — after the bodies have stepped               */
  /* ------------------------------------------------------------------ */

  /**
   * Lay every link of every chain, off the joints the solver has just placed.
   *
   * Called by the manager after the field has stepped the bodies, so the coil
   * is wound round the limb as it is on the frame that is drawn — built in
   * `update` it would trail every limb by a frame, and a coil that lags the
   * arm it is round reads as loose at exactly the moment it is meant to bite.
   */
  lateUpdate(dt) {
    if (this.phase === 'idle' || this.phase === 'done') return;
    const c = this.config;
    const age = this.fieldAge;
    this.linkMaterial.userData.sync();
    this.hookMaterial.userData.sync();

    let links = 0;
    let hooks = 0;
    if (this.phase === 'impact') {
      for (const chain of this.chains) {
        if (!this._buildPath(chain, c, age)) {
          chain.visible = false;
          continue;
        }
        chain.visible = true;
        const speed = dt > 0 ? (chain.length - chain.lastLength) / dt : 0;
        chain.lastLength = chain.length;
        links = this._layLinks(chain, c, age, links);
        hooks = this._layHook(chain, c, hooks);
        this._grind(chain, c, dt, speed);
        chain.flash = Math.max(0, chain.flash - dt * 2.5);
      }
    }
    this.linkMesh.count = links;
    this.linkMesh.visible = links > 0;
    this.linkMesh.instanceMatrix.needsUpdate = true;
    this.glow.needsUpdate = true;
    this.seed.needsUpdate = true;
    this.hookMesh.count = hooks;
    this.hookMesh.visible = hooks > 0;
    this.hookMesh.instanceMatrix.needsUpdate = true;
    this.hookGlow.needsUpdate = true;
    this.hookSeed.needsUpdate = true;
  }

  /**
   * One chain's centreline for this frame, tip first, into `chain.path`.
   * False if it is not out of its portal.
   */
  _buildPath(chain, c, age) {
    const path = chain.path;
    path.reset();
    if (age < chain.fireAt || age > chain.homeAt + 0.05) return false;
    const P = chain.portal.centre;
    const held = this.taken && this.victim;

    /* ---- in flight ---- */
    if (age < chain.hitAt) {
      const x = saturate((age - chain.fireAt) / Math.max(0.03, chain.hitAt - chain.fireAt));
      const u = 1 - Math.pow(1 - x, 1.6);
      if (!this._attachPoint(chain, c, _c)) {
        _c.copy(this.hang).addScaledVector(_d.subVectors(P, this.hang).normalize(), 0.35);
      }
      // The arc: off the straight to one side, flattening as it arrives.
      _b.lerpVectors(P, _c, 0.5).addScaledVector(chain.curl, c.curl * (1 - x * 0.6));
      const n = 28;
      _d.subVectors(_c, P).normalize();
      anyPerpendicular(_d, _x);
      _y.crossVectors(_d, _x).normalize();
      for (let i = 0; i <= n; i++) {
        const k = u * (1 - i / n);
        bezier(P, _b, _c, k, _p, null);
        // A wave thrown down it from the portal, dying as it goes.
        const along = k / Math.max(u, 1e-3);
        const wave = c.whip * (1 - x) * Math.sin(Math.PI * along) * Math.sin(TAU * (c.whipWaves * along - age * 7) + chain.phase);
        _p.addScaledVector(_x, wave).addScaledVector(_y, wave * 0.5 * Math.cos(chain.phase));
        if (i === 0) {
          chain.tip.copy(_p);
          bezier(P, _b, _c, k, _t, chain.tipDir);
          chain.tipDir.normalize();
        }
        path.push(_p);
      }
      chain.wrap = 0;
      chain.coilLength = 0;
      chain.coilStart.copy(_c);
      chain.tension = 0;
      chain.length = path.length;
      return path.count > 1;
    }

    /* ---- nobody there: the chains meet on the empty air, then go home ---- */
    if (!held && !chain.released && age < chain.releaseAt) {
      _c.copy(this.hang).addScaledVector(_d.subVectors(P, this.hang).normalize(), 0.3);
      _d.subVectors(P, _c);
      const L = _d.length();
      _d.normalize();
      anyPerpendicular(_d, _x);
      const vib = c.vibration;
      for (let i = 0; i <= 20; i++) {
        const s = i / 20;
        _p.copy(_c).addScaledVector(_d, L * s);
        _p.addScaledVector(_x, vib * Math.sin(Math.PI * s) * Math.sin(age * c.vibrationFreq * TAU + chain.phase));
        if (i === 0) chain.tip.copy(_p);
        path.push(_p);
      }
      chain.tipDir.copy(_d).negate();
      chain.wrap = 0;
      chain.coilLength = 0;
      chain.tension = 0.4;
      chain.length = path.length;
      return path.count > 1;
    }

    /* ---- let go: unwinding, and whipping home ---- */
    if (chain.released || !held) {
      if (!chain.released) {
        chain.released = true;
        chain.releaseAt = age;
        chain.releaseFrom.copy(chain.tip);
      }
      const x = saturate((age - chain.releaseAt) / Math.max(0.05, chain.homeAt - chain.releaseAt));
      _c.lerpVectors(chain.releaseFrom, P, Easing.inQuad(x));
      _d.subVectors(_c, P);
      const L = _d.length();
      if (L < 0.02) return false;
      _d.normalize();
      anyPerpendicular(_d, _x);
      const n = 20;
      for (let i = 0; i <= n; i++) {
        const k = 1 - i / n;
        _p.copy(P).addScaledVector(_d, L * k);
        const wave = c.whip * 0.6 * Math.sin(Math.PI * k) * Math.sin(TAU * (1.5 * k - age * 9) + chain.phase) * (1 - x);
        _p.addScaledVector(_x, wave);
        _p.y -= c.sag * L * 4 * k * (1 - k) * (1 - x);
        if (i === 0) chain.tip.copy(_p);
        path.push(_p);
      }
      chain.tipDir.copy(_d);
      chain.wrap = 0;
      chain.coilLength = 0;
      chain.tension = 0;
      chain.length = path.length;
      return path.count > 1;
    }

    /* ---- wound round its limb ---- */
    const w = Easing.outCubic(saturate((age - chain.hitAt) / Math.max(0.02, c.wrapTime)));
    chain.wrap = w;
    const turns = Math.max(0.25, c.wrapTurns * w);
    const coilPoints = Math.min(120, Math.ceil(turns * 18) + 2);
    let ok = true;
    for (let i = 0; i <= coilPoints; i++) {
      const tau = w * (1 - i / coilPoints);
      if (!this._coilPoint(chain, tau, c, _p)) {
        ok = false;
        break;
      }
      if (i === 0) chain.tip.copy(_p);
      if (i === 1) chain.tipDir.subVectors(chain.tip, _p).normalize();
      path.push(_p);
    }
    if (!ok) return false;
    chain.coilStart.copy(path.points[path.count - 1]);
    chain.coilLength = path.length;

    // The span home to the portal: slack as it lands, taut once it bites,
    // thrumming under the haul, and every ratchet a wave run down it.
    const C0 = chain.coilStart;
    _d.subVectors(P, C0);
    const L = _d.length();
    _d.normalize();
    anyPerpendicular(_d, _x);
    _y.crossVectors(_d, _x).normalize();
    const caught = smoothstep(0, 1, (age - chain.hitAt) / Math.max(0.02, c.wrapTime + c.catchTime));
    const slack = chain.torn ? 0 : 1 - caught;
    const tension = chain.torn ? 0.5 : caught * (0.35 + 0.65 * this.haul);
    chain.tension = tension;
    const vib = c.vibration * tension;
    const t = age * c.vibrationFreq * TAU;
    const jerkAge = age - this.jerkAt;
    const n = 22;
    for (let i = 1; i <= n; i++) {
      const s = i / n;
      _p.copy(C0).addScaledVector(_d, L * s);
      const bell = Math.sin(Math.PI * s);
      _p.addScaledVector(_x, vib * bell * Math.sin(t + chain.phase + s * 3));
      _p.addScaledVector(_y, vib * 0.7 * Math.sin(TAU * s) * Math.cos(t * 1.31 + chain.phase));
      if (this.jerkAt >= 0 && jerkAge < 0.5 && !chain.torn) {
        // The wave a haul sends from the portal toward the body.
        const front = 1 - jerkAge * 3.2;
        const pulse = Math.exp(-Math.pow((s - front) * 6, 2)) * (1 - jerkAge * 2);
        _p.addScaledVector(_x, c.jerkWave * pulse * Math.sin(chain.phase + 1.7));
        _p.addScaledVector(_y, c.jerkWave * pulse * 0.6);
      }
      _p.y -= c.sag * L * 4 * s * (1 - s) * slack;
      path.push(_p);
    }
    chain.length = path.length;
    return path.count > 1;
  }

  /** Where a chain in flight is going: the start of its coil, on the limb as it is now. */
  _attachPoint(chain, c, out) {
    if (!this.victim) return false;
    // Measured off the pose the limb is in now, until the chain bites.
    if (!chain.hit) this._measureCoil(chain);
    return this._coilPoint(chain, 0, c, out);
  }

  /**
   * Links along a chain's path, from the tip back to the portal, each turned
   * a quarter turn from the last. Anything already back through the portal
   * is not drawn.
   */
  _layLinks(chain, c, age, n) {
    const path = chain.path;
    const L = path.length;
    const size = Math.max(0.02, c.linkLength);
    const pitch = size * 0.74;
    const thick = c.linkThickness;
    const P = chain.portal.centre;
    const N = chain.portal.normal;
    const coilLength = chain.coilLength;
    const strain = age < this.tearStart ? this.haul : 0;
    const tearHot = chain.torn ? Math.exp(-(age - chain.tearAt) * 3) * 1.6 : 0;
    const jerkAge = age - this.jerkAt;

    // Parallel transport from the tip, so the links do not twist about at random.
    path._cursor = 0;
    let first = true;
    let index = 0;
    for (let s = pitch * 0.5; s < L && n < MAX_LINKS; s += pitch, index++) {
      path.sample(s, _p, _t);
      if (first) {
        anyPerpendicular(_t, _n);
        first = false;
      } else {
        _n.addScaledVector(_t, -_n.dot(_t));
        if (_n.lengthSq() < 1e-8) anyPerpendicular(_t, _n);
        _n.normalize();
      }
      // Through the portal already: somewhere else.
      if (_s.subVectors(_p, P).dot(N) < -0.01) continue;

      _z.copy(_n);
      if (index & 1) _z.crossVectors(_t, _n);
      _x.crossVectors(_t, _z).normalize();
      _m.makeBasis(_x, _t, _z);
      _q.setFromRotationMatrix(_m);
      _s.set(size * thick, size, size * thick);
      _m.compose(_p, _q, _s);
      this.linkMesh.setMatrixAt(n, _m);

      // Heat: in from the portal as it hauls, searing on the coil, a flash on
      // every haul and on the tear, and the run of light out of the portal
      // behind a chain in flight.
      const fromPortal = L - s;
      // The heat comes in from the portal and stops short of the body.
      const front = strain * 0.85 * L;
      let glow = 0.1 + chain.flash * 0.9 * Math.exp(-s * 1.2);
      glow += strain * 1.05 * (1 - smoothstep(front - 0.5, front + 0.3, fromPortal));
      if (s < coilLength) glow += 0.2 * chain.wrap + strain * 0.55;
      if (age < chain.hitAt + 0.15) glow += 1.6 * Math.exp(-s * 2.5);
      if (this.jerkAt >= 0 && jerkAge < 0.5 && !chain.torn) {
        const at = jerkAge * 3.2 * L;
        glow += 1.4 * Math.exp(-Math.pow((fromPortal - at) * 2.2, 2)) * (1 - jerkAge * 2);
      }
      glow += tearHot;
      this.glow.array[n] = glow;
      this.seed.array[n] = (index * 0.618 + chain.seed) % 10;
      n++;
    }
    return n;
  }

  _layHook(chain, c, n) {
    const P = chain.portal.centre;
    if (_s.subVectors(chain.tip, P).dot(chain.portal.normal) < -0.01) return n;
    _y.copy(chain.tipDir);
    if (_y.lengthSq() < 1e-6) _y.set(0, 1, 0);
    _y.normalize();
    anyPerpendicular(_y, _z);
    _x.crossVectors(_y, _z).normalize();
    _m.makeBasis(_x, _y, _z);
    _q.setFromRotationMatrix(_m);
    const size = c.hookSize;
    _s.set(size, size, size);
    // The socket sits on the last link; the point leads.
    _p.copy(chain.tip).addScaledVector(_y, -size * 0.08);
    _m.compose(_p, _q, _s);
    this.hookMesh.setMatrixAt(n, _m);
    this.hookGlow.array[n] = 0.15 + chain.flash * 1.2 + (chain.wrap > 0 ? this.haul * 0.6 : 0);
    this.hookSeed.array[n] = chain.seed;
    return n + 1;
  }

  /** Sparks where a chain runs through its portal, as fast as it is running. */
  _grind(chain, c, dt, speed) {
    const rate = Math.min(400, Math.abs(speed) * c.sparkRate * 0.25 + (chain.tension > 0.6 ? 6 : 0));
    if (rate <= 0) return;
    const n = this._sparks.tick(dt, rate * settings.global.particleCount);
    if (!n) return;
    const portal = chain.portal;
    _emit.position.copy(portal.centre).addScaledVector(portal.normal, 0.04);
    _emit.direction.copy(portal.normal).multiplyScalar(speed >= 0 ? 1 : -0.4).addScaledVector(UP, 0.3).normalize();
    _emit.radius = 0.08;
    _emit.speed = 3 + Math.min(6, Math.abs(speed) * 0.2);
    _emit.speedVariance = 0.6;
    _emit.spread = 0.8;
    _emit.size = 0.022;
    _emit.sizeVariance = 0.5;
    _emit.life = 0.35;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.sparks.emit(n, _emit);
  }

  /* ---- the look of every particle system, every frame ---- */

  _dress(c) {
    const g = settings.global;
    {
      const u = this.sparks.uniforms;
      this.sparks.setGradient(getColor(c.colorCore), getColor(c.colorGold), getColor(c.colorHeat), getColor(c.colorDeep));
      u.uGravity.value.set(0, -9, 0);
      u.uDrag.value = 1.4;
      u.uTurbulence.value = 0.1;
      u.uStretch.value = 0.06;
      u.uEndSize.value = 0.3;
      u.uFadeOut.value = 0.5;
      u.uGlow.value = 2.2 * g.glow;
      u.uOpacity.value = 1;
    }
    {
      const u = this.embers.uniforms;
      this.embers.setGradient(getColor(c.colorCore), getColor(c.colorEmber), getColor(c.colorHeat), getColor(c.colorDeep));
      u.uGravity.value.set(0, 0.6, 0);
      u.uDrag.value = 1.8;
      u.uTurbulence.value = 0.7 * g.turbulence;
      u.uTurbFrequency.value = 1.2;
      u.uEndSize.value = 0.2;
      u.uFadeIn.value = 0.05;
      u.uFadeOut.value = 0.5;
      u.uGlow.value = 2.0 * g.glow;
      u.uOpacity.value = 1;
    }
    {
      const u = this.blood.uniforms;
      this.blood.setGradient(getColor(c.colorBlood), getColor(c.colorBlood), getColor(c.colorBloodDark), getColor(c.colorBloodDark));
      u.uGravity.value.set(0, -17, 0);
      u.uDrag.value = 0.5;
      u.uTurbulence.value = 0.05;
      u.uStretch.value = 0.05;
      u.uEndSize.value = 0.7;
      u.uSizeIn.value = 0.02;
      u.uFadeIn.value = 0.01;
      u.uFadeOut.value = 0.3;
      u.uGlow.value = 0.6;
      u.uOpacity.value = 0.95;
    }
    {
      const u = this.gore.uniforms;
      this.gore.setGradient(getColor(c.colorBlood), getColor(c.colorBlood), getColor(c.colorBloodDark), getColor(c.colorBloodDark));
      u.uGravity.value.set(0, -18, 0);
      u.uDrag.value = 0.3;
      u.uTurbulence.value = 0;
      u.uEndSize.value = 0.9;
      u.uFadeOut.value = 0.25;
      u.uGlow.value = 0.5;
      u.uOpacity.value = 1;
    }
    {
      const u = this.smoke.uniforms;
      this.smoke.setGradient(getColor(c.colorDeep), getColor(c.colorSmoke), getColor(c.colorSmoke), getColor(c.colorVoid));
      u.uGravity.value.set(0, 0.35, 0);
      u.uDrag.value = 2.0;
      u.uTurbulence.value = 0.5 * g.turbulence;
      u.uTurbFrequency.value = 0.9;
      u.uEndSize.value = 2.6;
      u.uFadeIn.value = 0.1;
      u.uFadeOut.value = 0.45;
      u.uGlow.value = 0.25;
      u.uOpacity.value = 0.45;
    }
    {
      const u = this.glints.uniforms;
      this.glints.setGradient(getColor('#ffffff'), getColor(c.colorCore), getColor(c.colorGold), getColor(c.colorGold));
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
  }
}

/** The joint each torn limb leaves the trunk at — where the blood comes out. */
const TEAR_SOCKET = {
  head: 'Head',
  armL: 'LeftArm',
  armR: 'RightArm',
  legL: 'LeftUpLeg',
  legR: 'RightUpLeg'
};
