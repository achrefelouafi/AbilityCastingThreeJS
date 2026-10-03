import { Euler, Group, Mesh, PlaneGeometry, Vector3 } from 'three';
import { Ability } from './Ability.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { DecalType } from '../effects/GroundDecals.js';
import { BurstMode } from '../effects/BurstSphere.js';
import { dragonMouth, instanceDragon, poseDragon } from '../assets/DragonRig.js';
import {
  DRAGON_BLAZE_COUNT,
  createBlazeGeometry,
  createBlazeMaterial,
  createBreathGeometry,
  createBreathMaterial,
  createDragonGroundMaterial,
  createDragonPortalMaterial,
  createRingGeometry,
  createRingMaterial,
  patchDragonMaterial
} from '../materials/DragonMaterials.js';
import { createHeatFieldMaterial } from '../materials/PhoenixMaterials.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { Easing, damp, saturate, smoothstep } from '../utils/math.js';

/** Which act of the show the dragon is in. */
export const DragonAct = Object.freeze({
  PORTAL: 'portal',
  ARRIVE: 'arrive',
  TRACE: 'trace',
  DEPART: 'depart',
  GONE: 'gone'
});

const TAU = Math.PI * 2;
const UP = new Vector3(0, 1, 0);
/** Bodies one cast can have alight at once. */
const MAX_BURNING = 12;
/** The portal quad's half-size, in units of the tear's open radius. */
const PORTAL_QUAD = 1 / 0.6;

const _a = new Vector3();
const _b = new Vector3();
const _p = new Vector3();
const _v = new Vector3();
const _dir = new Vector3();
const _head = new Vector3();
const _euler = new Euler(0, 0, 0, 'YXZ');
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
const _inherit = new Vector3();

/** Signed shortest turn from `from` to `to`, radians. */
const turnTo = (from, to) => Math.atan2(Math.sin(to - from), Math.cos(to - from));

/**
 * Cubic Hermite between two points with their velocities, over `h` seconds.
 * `x` is 0..1 through it. Writes the position and its rate of change, m/s.
 */
function hermite(p0, v0, p1, v1, h, x, outP, outV) {
  const x2 = x * x;
  const x3 = x2 * x;
  outP
    .set(0, 0, 0)
    .addScaledVector(p0, 2 * x3 - 3 * x2 + 1)
    .addScaledVector(v0, (x3 - 2 * x2 + x) * h)
    .addScaledVector(p1, -2 * x3 + 3 * x2)
    .addScaledVector(v1, (x3 - x2) * h);
  outV
    .set(0, 0, 0)
    .addScaledVector(p0, (6 * x2 - 6 * x) / h)
    .addScaledVector(v0, 3 * x2 - 4 * x + 1)
    .addScaledVector(p1, (-6 * x2 + 6 * x) / h)
    .addScaledVector(v1, 3 * x2 - 2 * x);
}

/**
 * THE DRAGONFIRE CIRCLE — a dragon, summoned onto a circle, that burns it.
 *
 * A far cast, and the longest performance in the sandbox. Everything after
 * the landing runs off one clock (`show`) and a plan re-solved from the
 * settings every frame (`_plan`), in four acts:
 *
 *   1. **the summons.** A fuse of embers runs out to the circle and the sky
 *      over it tears open — a ring of fire round a black vortex. The dragon
 *      dives out of it, *through* it: the hide is cut along the portal's
 *      plane with a molten band, so it comes out of the tear rather than
 *      fading in under it.
 *   2. **the ring.** It flies one lap of the circle just outside it, breathing
 *      onto the edge a little ahead of itself, and the ring of fire is drawn
 *      by the breath: the wall is lit by angle, a point at a time, as the
 *      breath goes past it, and it leaps where it has only just caught.
 *   3. **the leaving.** The ring closes with a flash, and the dragon pulls up
 *      off the end of its lap into the tear, opened again for it; it shuts
 *      behind the tail.
 *   4. **the burning.** A beat after the close the fire turns inward: a front
 *      runs from the ring to the middle with a torn, burning edge and a wall
 *      of flame standing on it; behind it the floor is char and glowing
 *      cracks and the field is ablaze, every tongue lit on the frame the
 *      front reaches it. Whatever is standing in the circle catches as the
 *      front gets to it: it staggers, chars, and burns away. The front meets
 *      in the middle and the middle erupts; then the fire settles, the floor
 *      cools from glowing cracks to ash, the smoke thins, and the char goes
 *      last.
 *
 * Nothing about the model is known here — `DragonRig` hands over a canonical
 * dragon and the pose call that flies it — and nothing about the fire is
 * stored per cast beyond a few angles and the clock: the ring, the front and
 * the blaze are all shaders reading the same handful of uniforms.
 *
 * It answers `handlesOwnHits`: the field's disc reading of a far cast would
 * fell everyone in the circle on the frame the fuse landed, and this cast's
 * whole point is that they burn when the fire gets to them.
 */
export class DragonAbility extends Ability {
  constructor(context) {
    super('dragon', context);
  }

  get handlesOwnHits() {
    return true;
  }

  /** Followed firmly: the circle is the stage, and the dragon is on it. */
  get cameraWeight() {
    return this.u < 1 ? saturate(1 - this.u * 0.4) : 0.8;
  }

  get impactDuration() {
    return this._plan(this.config).end;
  }

  get fadeDuration() {
    return Math.max(0.1, this.config.fadeTime);
  }

  get instanceCount() {
    return this.blaze.visible ? DRAGON_BLAZE_COUNT : 0;
  }

  /* ------------------------------------------------------------------ */
  /* construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    const rig = this.ctx.models?.dragon ?? null;
    this.rig = rig;

    // root: where it is and which way it faces. frame: the rig, scaled.
    this.root = new Group();
    this.root.name = 'DragonRoot';
    this.frame = new Group();
    this.frame.name = 'DragonFrame';
    this.root.add(this.frame);
    this.group.add(this.root);
    this.root.visible = false;

    this.dragon = null;
    this.hideMaterials = [];
    if (rig) {
      const dragon = instanceDragon(rig);
      this.dragon = dragon;
      for (const mesh of dragon.meshes) {
        // Its own copy: the portal and the fire under it are this cast's.
        const membrane = mesh.material?.name === 'Game_dragon';
        const material = patchDragonMaterial(mesh.material.clone(), { membrane });
        mesh.material = material;
        mesh.layers.set(LAYER.WORLD);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        this.hideMaterials.push(material);
      }
      this.frame.add(dragon.root);
    }

    /* ---- the tear in the sky ---- */
    this.portalMaterial = createDragonPortalMaterial();
    this.portal = new Mesh(new PlaneGeometry(1, 1), this.portalMaterial);
    this.portal.layers.set(LAYER.VFX);
    this.portal.renderOrder = 8;
    this.portal.frustumCulled = false;
    this.group.add(this.portal);

    /* ---- the floor ---- */
    const flat = new PlaneGeometry(1, 1);
    flat.rotateX(-Math.PI / 2);
    this.groundMaterial = createDragonGroundMaterial();
    this.ground = new Mesh(flat, this.groundMaterial);
    this.ground.layers.set(LAYER.VFX);
    this.ground.renderOrder = 5;
    this.ground.frustumCulled = false;
    this.group.add(this.ground);

    /* ---- the ring, and the front: one wall, twice ---- */
    const wall = createRingGeometry();
    this.ringMaterial = createRingMaterial();
    this.ring = new Mesh(wall, this.ringMaterial);
    this.ring.layers.set(LAYER.VFX);
    this.ring.renderOrder = 9;
    this.ring.frustumCulled = false;
    this.group.add(this.ring);

    // Not `front`: the base class owns that name, for the fuse's run.
    this.frontMaterial = createRingMaterial();
    this.frontWall = new Mesh(wall, this.frontMaterial);
    this.frontWall.layers.set(LAYER.VFX);
    this.frontWall.renderOrder = 9;
    this.frontWall.frustumCulled = false;
    this.group.add(this.frontWall);

    /* ---- the field ablaze ---- */
    this.blazeMaterial = createBlazeMaterial();
    this.blaze = new Mesh(createBlazeGeometry(), this.blazeMaterial);
    this.blaze.layers.set(LAYER.VFX);
    this.blaze.renderOrder = 9.5;
    this.blaze.frustumCulled = false;
    this.group.add(this.blaze);

    /* ---- the breath ---- */
    this.breathMaterial = createBreathMaterial();
    this.breath = new Mesh(createBreathGeometry(), this.breathMaterial);
    this.breath.layers.set(LAYER.VFX);
    this.breath.renderOrder = 10;
    this.breath.frustumCulled = false;
    this.group.add(this.breath);

    /* ---- the heat over it ---- */
    this.hazeMaterial = createHeatFieldMaterial();
    this.haze = new Mesh(new PlaneGeometry(1, 1), this.hazeMaterial);
    this.haze.layers.set(LAYER.DISTORTION);
    this.haze.frustumCulled = false;
    this.group.add(this.haze);

    /* ---- state ---- */
    this.act = DragonAct.PORTAL;
    this.show = 0;
    this.burnout = 0;
    this.centre = new Vector3();
    this.turn = 1;
    this.startAngle = 0;
    this.portalAt = new Vector3();
    this.portalNormal = new Vector3(0, -1, 0);
    this.pos = new Vector3();
    this.vel = new Vector3();
    this.accel = new Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;
    this.beat = 0;
    this.jaw = 0;
    this.aimWeight = 0;
    this.aim = new Vector3();
    this.mouth = new Vector3();
    this.breathAt = new Vector3();
    this.breathHeat = 0;
    /** Where the fire front is, metres from the centre. */
    this.frontRadius = 1e3;
    this.throat = 0;
    this.portalOpenNow = 0;
    this.closed = false;
    this.turnedIn = false;
    this.erupted = false;
    this.cameThrough = false;

    /** The plan of the show, re-solved every frame — see `_plan`. */
    this.plan = {
      arrive0: 0,
      arrive1: 0,
      trace1: 0,
      spread0: 0,
      spread1: 0,
      depart0: 0,
      depart1: 0,
      end: 0
    };

    this.fieldLight = null;
    this.hotLight = null;
    this.hotAt = new Vector3();

    /** Bodies the fire has caught, and how far along each one is. */
    this._burning = [];
    for (let i = 0; i < MAX_BURNING; i++) this._burning.push({ dummy: null, time: 0, eaten: 0 });
    /** Reused by `DummyField#findBodies`, so polling allocates nothing. */
    this._bodies = [];

    this._fuse = new RateEmitter(200);
    this._breathPuffs = new RateEmitter(100);
    this._splash = new RateEmitter(60);
    this._sparks = new RateEmitter(50);
    this._ringEmbers = new RateEmitter(60);
    this._fieldPuffs = new RateEmitter(60);
    this._fieldEmbers = new RateEmitter(120);
    this._smoke = new RateEmitter(16);
    this._bodyFlames = new RateEmitter(30);
  }

  createParticles() {
    const P = this.ctx.particles;
    // Eroded puffs, not discs: a round additive sprite the size of a flame
    // reads as a ball of light, and an eroded one reads as a gout of fire.
    this.flames = P.get('dragonFlame', {
      capacity: 2400,
      shape: ParticleShape.SMOKE,
      additive: true,
      curl: true,
      softFade: 0.4
    });
    this.embers = P.get('dragonEmber', {
      capacity: 1800,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.2
    });
    this.sparks = P.get('dragonSpark', {
      capacity: 700,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.1
    });
    this.smoke = P.get('dragonSmoke', {
      capacity: 500,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 0.8
    });
    this.flashes = P.get('dragonFlash', { capacity: 48, shape: ParticleShape.GLINT, additive: true });
  }

  /* ------------------------------------------------------------------ */
  /* the plan                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * When every act starts and ends, seconds after the landing.
   *
   * Solved from the settings on every call rather than once at the cast, so
   * the timing folder reshapes a show that is already running.
   */
  _plan(c) {
    const p = this.plan;
    p.arrive0 = Math.max(0.05, c.portalOpen) * 0.7;
    p.arrive1 = p.arrive0 + Math.max(0.3, c.arriveTime);
    p.trace1 = p.arrive1 + Math.max(0.6, c.traceTime);
    // The fire turns inward a beat after the ring closes, on its own.
    p.spread0 = p.trace1 + Math.max(0, c.spreadDelay);
    p.spread1 = p.spread0 + Math.max(0.3, c.spreadTime);
    // The dragon leaves straight off the end of its lap.
    p.depart0 = p.trace1;
    p.depart1 = p.depart0 + Math.max(0.4, c.departTime);
    p.end = Math.max(p.depart1, p.spread1) + 0.55;
    return p;
  }

  /** Which act a time falls in. */
  _actAt(t, p) {
    if (t < p.arrive0) return DragonAct.PORTAL;
    if (t < p.arrive1) return DragonAct.ARRIVE;
    if (t < p.trace1) return DragonAct.TRACE;
    if (t < p.depart1) return DragonAct.DEPART;
    return DragonAct.GONE;
  }

  /* ------------------------------------------------------------------ */
  /* lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    const c = this.config;
    this.pointAt(1, this.centre);
    this.act = DragonAct.PORTAL;
    this.show = 0;
    this.burnout = 0;
    this.turn = Math.random() < 0.5 ? 1 : -1;
    // The lap starts on the far side of the circle, so the dragon comes out
    // of the sky *toward* the caster before it turns onto it.
    this.startAngle = Math.atan2(this.direction.z, this.direction.x);
    this.closed = false;
    this.turnedIn = false;
    this.erupted = false;
    this.cameThrough = false;
    this.frontRadius = 1e3;
    this.breathHeat = 0;
    this.jaw = 0;
    this.aimWeight = 0;
    this.beat = Math.random() * TAU;
    this.vel.set(0, 0, 0);
    this.accel.set(0, 0, 0);
    for (const slot of this._burning) slot.dummy = null;
    this._fuse.reset();
    this._breathPuffs.reset();
    this._splash.reset();
    this._sparks.reset();
    this._ringEmbers.reset();
    this._fieldPuffs.reset();
    this._fieldEmbers.reset();
    this._smoke.reset();
    this._bodyFlames.reset();

    this.fieldLight = this.ctx.lights.acquire();
    this.hotLight = this.ctx.lights.acquire();

    this._placePortal(c);
    this.position.copy(this.origin);

    // Nothing is on the stage until the fuse lands.
    this.root.visible = false;
    this.portal.visible = false;
    this.ground.visible = false;
    this.ring.visible = false;
    this.frontWall.visible = false;
    this.blaze.visible = false;
    this.breath.visible = false;
    this.haze.visible = false;

    if (this.dragon?.idle) {
      this.dragon.idle.reset().play();
      this.dragon.mixer.setTime(Math.random() * 10);
    }
  }

  onDestroy() {
    this.ctx.lights.release(this.fieldLight);
    this.ctx.lights.release(this.hotLight);
    this.fieldLight = null;
    this.hotLight = null;
    // Anything still alight finishes on its own clock (`Dummy#update`).
    for (const slot of this._burning) slot.dummy = null;
    this.root.visible = false;
    this.portal.visible = false;
    this.breath.visible = false;
  }

  /** Where the tear opens: high over the far side, turned down at the circle. */
  _placePortal(c) {
    this.portalAt
      .copy(this.centre)
      .addScaledVector(this.direction, c.portalBack)
      .addScaledVector(UP, c.portalHeight);
    const tilt = c.portalTilt;
    this.portalNormal.copy(this.direction).multiplyScalar(-Math.sin(tilt)).addScaledVector(UP, -Math.cos(tilt)).normalize();
  }

  /* ------------------------------------------------------------------ */
  /* the fuse                                                            */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    const c = this.config;
    const g = settings.global;
    const time = frame.uTime.value;
    // A fuse, running along the floor: embers and sparks shed where it is.
    this.position.y = 0.08;
    const n = this._fuse.tick(dt, c.fuseEmbers * g.particleCount);
    for (let i = 0; i < n; i++) {
      // Spread back over the stretch it covered this frame, so a fast fuse
      // still leaves an unbroken line.
      const back = Math.random() * c.speed * g.speed * dt;
      _emit.position.copy(this.position).addScaledVector(this.direction, -back);
      _emit.direction.set(0, 1, 0);
      _emit.radius = 0.06;
      _emit.speed = 0.8;
      _emit.speedVariance = 0.6;
      _emit.spread = 0.6;
      _emit.size = 0.09;
      _emit.sizeVariance = 0.5;
      _emit.life = 0.9;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.inherit = null;
      _emit.time = time;
      this.embers.emit(1, _emit);
      if (Math.random() < 0.3) {
        _emit.direction.copy(this.direction).setY(1.2).normalize();
        _emit.speed = 3;
        _emit.size = 0.04;
        _emit.life = 0.35;
        this.sparks.emit(1, _emit);
      }
    }
    this._dress(c);
  }

  /* ------------------------------------------------------------------ */
  /* the landing: the sky tears                                          */
  /* ------------------------------------------------------------------ */

  onImpact() {
    const c = this.config;
    const g = settings.global;
    const R = c.zoneRadius;
    this.pointAt(1, this.centre);
    this._placePortal(c);
    this.show = 0;
    this.act = DragonAct.PORTAL;

    this.portal.visible = true;
    this.ground.visible = true;
    this.ring.visible = true;
    this.blaze.visible = true;
    this.haze.visible = true;

    // The circle is marked where the fuse lands: a thin hot ring run out to
    // the edge, a flash, and the sky answering.
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, this.centre, {
      radius: R * 1.05,
      life: 0.8,
      intensity: 0.8,
      width: 0.04,
      colorA: getColor(c.colorMid),
      colorB: getColor(c.colorEdge)
    });
    _emit.position.copy(this.centre).setY(0.3);
    _emit.direction.set(0, 1, 0);
    _emit.radius = 0;
    _emit.speed = 0;
    _emit.speedVariance = 0;
    _emit.spread = 0;
    _emit.size = 2.2;
    _emit.sizeVariance = 0.1;
    _emit.life = 0.18;
    _emit.lifeVariance = 0.1;
    _emit.spin = 2;
    _emit.tint = null;
    _emit.inherit = null;
    _emit.time = frame.uTime.value;
    this.flashes.emit(1, _emit);
    this.lightBoost = 30 * g.explosionIntensity;

    this._fly(0, c);
  }

  /* ------------------------------------------------------------------ */
  /* the show                                                            */
  /* ------------------------------------------------------------------ */

  /** @param {number} t 0..1 through the show, then 1..2 cooling */
  onFade(dt, t) {
    const c = this.config;
    const p = this._plan(c);
    if (t <= 1) this.show += dt;
    this.burnout = t > 1 ? saturate(t - 1) : 0;
    this.act = this._actAt(this.show, p);

    this._events(c, p);
    this._fly(dt, c);
    this._breathe(dt, c, p);
    this._burnBodies(dt, c, p);
    this._dress(c);
    this._emitters(dt, c, p);
    this._fieldLights(dt, c, p);
  }

  /** The one-shot beats: the dragon through the tear, the close, the roar, the eruption. */
  _events(c, p) {
    const g = settings.global;
    const t = this.show;

    if (!this.cameThrough && t >= p.arrive0 + Math.max(0.3, c.arriveTime) * 0.3) {
      this.cameThrough = true;
      this.ctx.shake.add(c.portalShake * g.cameraShake, 1.8, 14);
      this.lightBoost = Math.max(this.lightBoost, 25 * g.explosionIntensity);
    }

    if (!this.closed && t >= p.trace1) {
      this.closed = true;
      this._close(c);
    }

    if (!this.turnedIn && t >= p.spread0) {
      this.turnedIn = true;
      this._turnInward(c);
    }

    if (!this.erupted && t >= p.spread1) {
      this.erupted = true;
      this._erupt(c);
    }
  }

  /** The ring meets itself: a flash round the whole of it. */
  _close(c) {
    const g = settings.global;
    const time = frame.uTime.value;
    const R = c.zoneRadius;
    this.ctx.shake.add(c.closeShake * g.explosionIntensity * g.cameraShake, 2.4, 18);
    if (c.closeFlash > 0) this.ctx.flash.trigger(getColor(c.colorMid), c.closeFlash * g.explosionIntensity);
    this.lightBoost = Math.max(this.lightBoost, c.closeLight * g.explosionIntensity);
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, this.centre, {
      radius: R * 1.5,
      life: 0.9,
      intensity: 0.9,
      width: 0.07,
      colorA: getColor(c.colorCore),
      colorB: getColor(c.colorEdge)
    });
    // Sparks thrown up off the whole ring at once.
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * TAU + Math.random() * 0.1;
      _emit.position.set(this.centre.x + Math.cos(a) * R, 0.4, this.centre.z + Math.sin(a) * R);
      _emit.direction.set(Math.cos(a) * 0.3, 1, Math.sin(a) * 0.3).normalize();
      _emit.radius = 0.2;
      _emit.speed = 7;
      _emit.speedVariance = 0.5;
      _emit.spread = 0.4;
      _emit.size = 0.05;
      _emit.sizeVariance = 0.5;
      _emit.life = 0.8;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.inherit = null;
      _emit.time = time;
      this.sparks.emit(Math.max(1, Math.round(2 * g.particleCount)), _emit);
    }
  }

  /** The ring has closed: the fire turns inward. */
  _turnInward(c) {
    const g = settings.global;
    const R = c.zoneRadius;
    this.ctx.shake.add(c.inwardShake * g.cameraShake, 1.6, 9);
    if (c.inwardFlash > 0) this.ctx.flash.trigger(getColor(c.colorEdge), c.inwardFlash);
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, this.centre, {
      radius: R * 1.1,
      life: 0.7,
      intensity: 0.6,
      width: 0.05,
      colorA: getColor(c.colorMid),
      colorB: getColor(c.colorEdge)
    });
    this.ctx.decals.spawn(DecalType.DUSTRING, this.centre, {
      radius: R * 0.9,
      life: 1.6,
      intensity: 0.5,
      growth: 0.6,
      colorA: getColor('#5a4034'),
      colorB: getColor('#2a1d16')
    });
  }

  /** The front reaches the middle: it goes up. */
  _erupt(c) {
    const g = settings.global;
    const time = frame.uTime.value;
    const R = c.zoneRadius;
    _p.copy(this.centre).setY(0.4);
    this.ctx.bursts.spawn(BurstMode.FIRE, _p, {
      radius: 0.4,
      endRadius: R * 0.4,
      life: 0.55,
      intensity: 1.6 * g.explosionIntensity,
      opacity: 0.6,
      displace: 0.6,
      squash: 0.8,
      colorA: getColor(c.colorCore),
      colorB: getColor(c.colorMid),
      colorC: getColor(c.colorEdge)
    });
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, this.centre, {
      radius: R * 1.6,
      life: 0.8,
      intensity: 0.8,
      width: 0.08,
      colorA: getColor(c.colorCore),
      colorB: getColor(c.colorEdge)
    });
    const embers = Math.round(c.eruptionEmbers * g.particleCount);
    for (let i = 0; i < embers; i++) {
      const a = Math.random() * TAU;
      const r = Math.sqrt(Math.random()) * R * 0.5;
      _emit.position.set(this.centre.x + Math.cos(a) * r, 0.2, this.centre.z + Math.sin(a) * r);
      _emit.direction.set(Math.cos(a) * 0.35, 1.4, Math.sin(a) * 0.35).normalize();
      _emit.radius = 0.1;
      _emit.speed = 7;
      _emit.speedVariance = 0.6;
      _emit.spread = 0.45;
      _emit.size = 0.1;
      _emit.sizeVariance = 0.6;
      _emit.life = 2.2;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.inherit = null;
      _emit.time = time;
      this.embers.emit(1, _emit);
    }
    // A column of fire, thrown straight up.
    _emit.position.copy(this.centre).setY(0.3);
    _emit.direction.set(0, 1, 0);
    _emit.radius = 0.6;
    _emit.speed = 14;
    _emit.speedVariance = 0.6;
    _emit.spread = 0.12;
    _emit.size = 1.1;
    _emit.sizeVariance = 0.4;
    _emit.life = 1.0;
    _emit.lifeVariance = 0.3;
    _emit.spin = 1.5;
    this.flames.emit(Math.round(110 * g.particleCount), _emit);
    _emit.radius = 0.4;
    _emit.speed = 14;
    _emit.spread = 0.6;
    _emit.size = 0.06;
    _emit.life = 1.0;
    this.sparks.emit(Math.round(90 * g.particleCount), _emit);
    _emit.speed = 0;
    _emit.radius = 0;
    _emit.size = 5;
    _emit.life = 0.2;
    _emit.spin = 2;
    this.flashes.emit(1, _emit);

    this.lightBoost = Math.max(this.lightBoost, c.eruptionLight * g.explosionIntensity);
    this.ctx.shake.add(c.eruptionShake * g.explosionIntensity * g.cameraShake, 2.0, 16);
    if (c.eruptionFlash > 0) this.ctx.flash.trigger(getColor(c.colorCore), c.eruptionFlash * g.explosionIntensity);
  }

  /* ------------------------------------------------------------------ */
  /* the flight                                                          */
  /* ------------------------------------------------------------------ */

  /** The dragon's angle on its lap, and the fire's, at `u` 0..1 round it. */
  _lapAngle(u, c) {
    return this.startAngle + this.turn * (TAU * u - c.lag);
  }

  _fireAngle(u) {
    return this.startAngle + this.turn * TAU * u;
  }

  /** A point on the lap, and how fast it is being flown. */
  _lap(u, c, outP, outV) {
    const R = c.zoneRadius * c.orbitRadius;
    const a = this._lapAngle(u, c);
    outP.set(this.centre.x + Math.cos(a) * R, c.altitude, this.centre.z + Math.sin(a) * R);
    const w = (this.turn * TAU) / Math.max(0.6, c.traceTime);
    outV.set(-Math.sin(a) * R * w, 0, Math.cos(a) * R * w);
  }

  /** Behind the tear: where the dragon is before it comes, and after it goes. */
  _behindPortal(out, c) {
    const length = this.rig ? this.rig.length * (c.wingspan / Math.max(0.01, this.rig.wingspan)) : 6;
    return out.copy(this.portalAt).addScaledVector(this.portalNormal, -length * 0.85);
  }

  /** Place the dragon for this frame, and pose it. */
  _fly(dt, c) {
    const p = this.plan;
    const t = this.show;
    const g = settings.global;
    const act = this.act;

    const prevX = this.vel.x;
    const prevY = this.vel.y;
    const prevZ = this.vel.z;

    /* ---- where ---- */
    if (act === DragonAct.PORTAL || act === DragonAct.ARRIVE) {
      // Out of the tear along its normal, onto the lap along the lap.
      this._behindPortal(_a, c);
      const h = Math.max(0.3, c.arriveTime);
      const out = this.portalNormal;
      this._lap(0, c, _b, _v);
      const launch = _a.distanceTo(_b) / h;
      _dir.copy(out).multiplyScalar(launch * 1.2);
      const x = saturate((t - p.arrive0) / h);
      hermite(_a, _dir, _b, _v, h, x, this.pos, this.vel);
    } else if (act === DragonAct.TRACE) {
      const u = saturate((t - p.arrive1) / Math.max(0.6, c.traceTime));
      this._lap(u, c, this.pos, this.vel);
    } else {
      // Off the end of the lap, still at the lap's speed, and up into the
      // tear, which has opened again for it.
      this._lap(1, c, _a, _v);
      this._behindPortal(_b, c);
      const h = Math.max(0.4, c.departTime);
      const x = saturate((t - p.depart0) / h);
      _dir.copy(this.portalNormal).multiplyScalar(-_a.distanceTo(_b) / h * 1.3);
      hermite(_a, _v, _b, _dir, h, x, this.pos, this.vel);
    }

    // The lateral pull, for the bank. Smoothed: a finite difference of a
    // spline is noisy, and the lean has to be a lean.
    if (dt > 1e-4) {
      _a.set((this.vel.x - prevX) / dt, (this.vel.y - prevY) / dt, (this.vel.z - prevZ) / dt);
      this.accel.x = damp(this.accel.x, _a.x, 0.02, dt);
      this.accel.y = damp(this.accel.y, _a.y, 0.02, dt);
      this.accel.z = damp(this.accel.z, _a.z, 0.02, dt);
    }

    /* ---- which way it faces ---- */
    const flat = Math.hypot(this.vel.x, this.vel.z);
    // Slow enough to be standing still, it faces the caster.
    const yawTarget = flat > 1.5 ? Math.atan2(this.vel.x, this.vel.z) : Math.atan2(-this.direction.x, -this.direction.z);
    const pitchTarget = Math.max(-0.7, Math.min(0.9, Math.atan2(-this.vel.y, Math.max(flat, 2.5))));

    if (dt > 0) this.yaw += turnTo(this.yaw, yawTarget) * (1 - Math.pow(0.002, dt));
    else this.yaw = yawTarget;
    const left = _b.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const lateral = this.accel.dot(left);
    const rollTarget = -Math.atan2(lateral, 9.8) * c.bank;
    this.pitch = dt > 0 ? damp(this.pitch, pitchTarget, 0.05, dt) : pitchTarget;
    this.roll = dt > 0 ? damp(this.roll, Math.max(-0.7, Math.min(0.7, rollTarget)), 0.05, dt) : rollTarget;

    /* ---- the wings ---- */
    let rate = c.flapRate;
    let amp = c.flapAmplitude;
    let sweep = 0;
    let dihedral = c.dihedral;
    const neck = c.neckCurl;
    let jaw = 0;
    if (act === DragonAct.PORTAL || act === DragonAct.ARRIVE) {
      // Folded into the dive, opening and beating as it pulls out of it.
      const x = saturate((t - p.arrive0) / Math.max(0.3, c.arriveTime));
      const open = smoothstep(0.35, 0.85, x);
      sweep = c.diveSweep * (1 - open);
      amp = c.flapAmplitude * (0.25 + 0.95 * open);
      rate = c.flapRate * (0.7 + 0.5 * open);
      dihedral = c.dihedral + 0.25 * (1 - open);
      jaw = c.snarlJaw * Math.sin(Math.PI * smoothstep(0.05, 0.5, x));
    } else if (act === DragonAct.DEPART) {
      // Beating harder as it pulls up off the lap, folding as it goes in.
      const x = saturate((t - p.depart0) / Math.max(0.4, c.departTime));
      const climb = smoothstep(0, 0.35, x);
      rate = c.flapRate + (c.climbRate - c.flapRate) * climb;
      amp = c.flapAmplitude + (c.climbAmplitude - c.flapAmplitude) * climb;
      sweep = c.diveSweep * 0.4 * smoothstep(0.5, 1, x);
    }
    if (this.breathHeat > 0.01) jaw = Math.max(jaw, c.breathJaw * this.breathHeat);
    this.beat += dt * TAU * rate * g.animationSpeed;
    this.jaw = dt > 0 ? damp(this.jaw, jaw, 0.002, dt) : jaw;

    /* ---- place it ---- */
    const bob = -Math.cos(this.beat) * c.bob * (amp / Math.max(0.05, c.flapAmplitude)) * 0.6;
    this.root.position.set(this.pos.x, this.pos.y + bob, this.pos.z);
    _euler.set(this.pitch, this.yaw, this.roll, 'YXZ');
    this.root.quaternion.setFromEuler(_euler);
    const scale = this.rig ? c.wingspan / Math.max(0.01, this.rig.wingspan) : 1;
    this.frame.scale.setScalar(scale);
    this.root.updateMatrixWorld(true);

    if (this.dragon) {
      poseDragon(this.dragon, {
        dt: dt * g.animationSpeed,
        idleWeight: c.idleWeight,
        phase: this.beat,
        flap: amp,
        dihedral,
        sweep,
        jaw: this.jaw,
        neckPitch: neck,
        aim: this.aimWeight > 1e-3 ? this.aim : null,
        aimWeight: this.aimWeight,
        aimLimit: c.aimLimit,
        tailSway: c.tailSway,
        time: t
      });
      dragonMouth(this.dragon, this.mouth);
    } else {
      this.mouth.copy(this.root.position).addScaledVector(UP, -0.2);
    }

    // The camera frames the circle, leaning toward the dragon.
    this.position.lerpVectors(this.centre, this.root.position, 0.3);
    this.position.y = Math.min(this.position.y, 2.5);

    this.root.visible = !!this.dragon && act !== DragonAct.GONE && this.burnout <= 0;
  }

  /* ------------------------------------------------------------------ */
  /* the breath                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Where the breath is going, and how much of the jet there is.
   *
   * One window: the lap, onto the ring a little ahead of the dragon. The gas
   * runs out from the mouth at
   * `breathSpeed` and, when the window shuts, the tail of the jet leaves the
   * mouth and runs out after it — so a breath starts and stops like a jet
   * and not like a light being switched.
   */
  _breathe(dt, c, p) {
    const t = this.show;
    const on0 = p.arrive1;
    const on1 = p.trace1;

    // What it is breathing at: the ring, a little ahead of itself.
    const lap = saturate((t - p.arrive1) / Math.max(0.6, c.traceTime));
    const a = this._fireAngle(lap);
    this.breathAt.set(this.centre.x + Math.cos(a) * c.zoneRadius, 0, this.centre.z + Math.sin(a) * c.zoneRadius);

    // The neck comes onto it a little before the gas leaves, and lets go after.
    const aimTarget = t > on0 - 0.35 && t < on1 + 0.2 ? 1 : 0;
    this.aimWeight = dt > 0 ? damp(this.aimWeight, aimTarget, 0.004, dt) : aimTarget;
    this.aim.copy(this.breathAt);

    const len = Math.max(0.5, this.mouth.distanceTo(this.breathAt));
    const speed = Math.max(2, c.breathSpeed);
    const extend = t >= on0 ? saturate(((t - on0) * speed) / len) : 0;
    const cut = t >= on1 ? saturate(((t - on1) * speed) / len) : 0;
    const live = extend > 0 && cut < 1;
    this.breath.visible = live && this.root.visible;
    this.breathHeat = live ? saturate(extend * 4) * (1 - cut) : 0;
    // A low rumble for as long as it breathes.
    if (live && dt > 0) this.ctx.shake.rumble(c.breathShake * this.breathHeat, dt);
    // The throat lights first.
    this.throat = t > on0 - 0.4 && t < on1 ? smoothstep(on0 - 0.4, on0, t) : this.breathHeat;

    const u = this.breathMaterial.uniforms;
    u.uExtend.value = extend;
    u.uCut.value = cut;
    u.uLength.value = len;
    u.uFrom.value.copy(this.mouth);
    u.uTo.value.copy(this.breathAt);
    // Out of the mouth along the head, then bent: the gas that is landing
    // now left the mouth a moment ago, from where the dragon was then.
    if (this.dragon?.head) this.dragon.head.getWorldPosition(_head);
    else _head.copy(this.root.position);
    _dir.subVectors(this.mouth, _head).normalize();
    u.uBend.value
      .lerpVectors(this.mouth, this.breathAt, 0.45)
      .addScaledVector(_dir, len * 0.18)
      .addScaledVector(this.vel, -(len / speed) * c.breathBend);
  }

  /* ------------------------------------------------------------------ */
  /* the bodies                                                          */
  /* ------------------------------------------------------------------ */

  /** Catch whatever the fire has reached, and burn what has caught. */
  _burnBodies(dt, c, p) {
    const dummies = this.ctx.dummies;
    const t = this.show;
    const R = c.zoneRadius;
    const reachBody = settings.dummies.bodyRadius;

    // Only while the fire is being set: a body that walks onto the floor
    // after the dragon has gone finds it cooling, not burning.
    if (dummies?.findBodies && t > p.arrive1 && this.burnout <= 0) {
      const traced = this._traced(c, p);
      const found = dummies.findBodies(this.centre.x, this.centre.z, R + c.ringThick + 0.4, this._bodies);
      for (const dummy of found) {
        if (this._isBurning(dummy)) continue;
        const at = dummy.alive ? dummy.position : (dummy.bodyPoint(_p) ?? dummy.position);
        const dx = at.x - this.centre.x;
        const dz = at.z - this.centre.z;
        const r = Math.hypot(dx, dz);
        // Standing in the wall as the breath goes past.
        const arc = (((Math.atan2(dz, dx) - this.startAngle) * this.turn) % TAU + TAU) % TAU;
        const onRing = Math.abs(r - R) < c.ringThick + reachBody + 0.15 && traced - arc > 0.08;
        // Overrun by the front.
        const overrun = t > p.spread0 && r > this.frontRadius - reachBody;
        if (onRing || overrun) this._ignite(dummy, dx, dz, r, c);
      }
    }

    const b = c.burn;
    const time = frame.uTime.value;
    const g = settings.global;
    let alight = 0;
    for (const slot of this._burning) {
      const dummy = slot.dummy;
      if (!dummy) continue;
      if (dummy.state === 'gone' || dummy.alive) {
        slot.dummy = null;
        continue;
      }
      alight++;
      slot.time += dt;
      dummy.corrode(saturate(slot.time * Math.max(0, b.stain)), b.look);
      if (slot.time >= b.onset) {
        slot.eaten = Math.min(1, slot.eaten + Math.max(0, b.rate) * dt);
        dummy.consume(slot.eaten);
      }
      if (slot.eaten >= 1) slot.dummy = null;
    }

    // Fire off every body that is alight: they burn where they lie.
    if (alight > 0) {
      const n = this._bodyFlames.tick(dt, b.flames * alight * g.particleCount);
      for (let i = 0; i < n; i++) {
        let k = Math.floor(Math.random() * alight);
        let dummy = null;
        let heat = 1;
        for (const slot of this._burning) {
          if (!slot.dummy) continue;
          if (k-- === 0) {
            dummy = slot.dummy;
            heat = 1 - slot.eaten;
            break;
          }
        }
        if (!dummy) continue;
        if (!dummy.bodyPoint(_p)) _p.copy(dummy.position).setY(0.6);
        _emit.position.copy(_p);
        _emit.direction.set(0, 1, 0);
        _emit.radius = 0.45;
        _emit.speed = 1.6;
        _emit.speedVariance = 0.5;
        _emit.spread = 0.35;
        _emit.size = 0.55 * (0.4 + 0.6 * heat);
        _emit.sizeVariance = 0.4;
        _emit.life = 0.75;
        _emit.lifeVariance = 0.4;
        _emit.spin = 1.2;
        _emit.tint = null;
        _emit.inherit = null;
        _emit.time = time;
        this.flames.emit(1, _emit);
        if (Math.random() < 0.6) {
          _emit.size = 0.07;
          _emit.speed = 1.4;
          _emit.life = 1.6;
          _emit.spread = 0.7;
          this.embers.emit(1, _emit);
        }
        if (Math.random() < 0.18) {
          _emit.size = 0.6;
          _emit.speed = 0.9;
          _emit.life = 2.2;
          _emit.radius = 0.3;
          _emit.spin = 0.6;
          this.smoke.emit(1, _emit);
        }
      }
    }
  }

  _isBurning(dummy) {
    for (const slot of this._burning) if (slot.dummy === dummy) return true;
    return false;
  }

  /** A body catches: it staggers in off the fire, flares, and starts to char. */
  _ignite(dummy, dx, dz, r, c) {
    const slot = this._burning.find((s) => !s.dummy);
    if (!slot) return;
    const g = settings.global;
    // Inward: the fire came from the ring.
    const ix = r > 1e-3 ? -dx / r : this.direction.x;
    const iz = r > 1e-3 ? -dz / r : this.direction.z;
    if (dummy.alive) dummy.kill(ix, iz, c.burnHit);
    slot.dummy = dummy;
    slot.time = 0;
    slot.eaten = 0;

    _p.copy(dummy.position).setY(settings.dummies.height * 0.55);
    this.ctx.bursts.spawn(BurstMode.FIRE, _p, {
      radius: 0.1,
      endRadius: 0.75,
      life: 0.3,
      intensity: 1.2 * g.explosionIntensity,
      opacity: 0.5,
      displace: 0.5,
      colorA: getColor(c.colorCore),
      colorB: getColor(c.colorMid),
      colorC: getColor(c.colorEdge)
    });
    _p.setY(0);
    this.ctx.decals.spawn(DecalType.SCORCH, _p, {
      radius: 1.2,
      life: 6.0,
      intensity: 0.7,
      colorA: getColor(c.colorMid)
    });
    this.lightBoost = Math.max(this.lightBoost, 8 * g.explosionIntensity);
  }

  /* ------------------------------------------------------------------ */
  /* the fire's clocks                                                   */
  /* ------------------------------------------------------------------ */

  /** Radians of ring alight. Carries on past a lap so the seam comes up too. */
  _traced(c, p) {
    const t = this.show;
    if (t < p.arrive1) return 0;
    const rate = TAU / Math.max(0.6, c.traceTime);
    // The breath lands on the fire point a beat after it leaves the mouth.
    return Math.min(TAU + c.ringGrow * 4, Math.max(0, (t - p.arrive1 - 0.12) * rate));
  }

  /** 1 while the field is at full blaze, settling once the front is in, out by the end. */
  _fireLife(p) {
    const settle = 1 - 0.3 * smoothstep(p.spread1, p.end, this.show);
    return settle * (1 - smoothstep(0, 0.5, this.burnout));
  }

  /* ------------------------------------------------------------------ */
  /* dressing                                                            */
  /* ------------------------------------------------------------------ */

  /** Push the settings into every uniform, every frame. */
  _dress(c) {
    const g = settings.global;
    const p = this.plan;
    const t = this.show;
    const R = c.zoneRadius;
    const opacity = g.opacity;
    const landed = this.u >= 1;
    const life = this._fireLife(p);
    const traced = landed ? this._traced(c, p) : 0;

    // The front: from the ring to the middle over `spreadTime`, and on past
    // it so the last of the ragged edge clears.
    const spreadX = (t - p.spread0) / Math.max(0.3, c.spreadTime);
    this.frontRadius = landed && t >= p.spread0 ? R * (1 - spreadX) : R + c.frontWobble * 3 + 1;

    const fire = (u) => {
      u.uTempCore.value = c.tempCore;
      u.uTempEdge.value = c.tempEdge;
      u.uEmissionCurve.value = c.emissionCurve;
      u.uPalette.value = c.palette;
      u.uColorCore.value.copy(getColor(c.colorCore));
      u.uColorMid.value.copy(getColor(c.colorMid));
      u.uColorEdge.value.copy(getColor(c.colorEdge));
      u.uColorEmber.value.copy(getColor(c.colorEmber));
    };

    /* the tear */
    {
      const open0 = Easing.outBack(saturate(t / Math.max(0.05, c.portalOpen)));
      const shut0 = 1 - Easing.inQuad(saturate((t - p.arrive1 - 0.25) / 0.6));
      const open1 = Easing.outBack(saturate((t - (p.depart0 - c.portalOpen * 0.8)) / Math.max(0.05, c.portalOpen)));
      const shut1 = 1 - Easing.inQuad(saturate((t - p.depart1 - 0.05) / 0.45));
      const open = landed ? Math.max(open0 * shut0, open1 * shut1) * (1 - this.burnout) : 0;
      this.portalOpenNow = open;
      const u = this.portalMaterial.uniforms;
      fire(u);
      u.uOpen.value = Math.max(0, open);
      u.uSpin.value = c.portalSpin * this.turn;
      u.uIntensity.value = c.portalIntensity * g.glow * g.shaderIntensity;
      u.uVoid.value = c.portalVoid;
      u.uFade.value = opacity;
      this.portal.visible = landed && open > 0.002;
      this.portal.position.copy(this.portalAt);
      _a.copy(this.portalAt).add(this.portalNormal);
      this.portal.lookAt(_a);
      this.portal.scale.setScalar(c.portalRadius * 2 * PORTAL_QUAD);
    }

    /* the hide */
    {
      const revealing = this.act === DragonAct.PORTAL || this.act === DragonAct.ARRIVE || this.act === DragonAct.DEPART || this.act === DragonAct.GONE;
      const burning = saturate((traced / TAU) * 0.7 + (t >= p.spread0 ? 0.3 + 0.7 * saturate(1 - this.frontRadius / R) : 0));
      for (const material of this.hideMaterials) {
        const u = material.userData.dragon;
        u.uRevealOn.value = revealing ? 1 : 0;
        u.uRevealPoint.value.copy(this.portalAt);
        u.uRevealNormal.value.copy(this.portalNormal);
        u.uRevealWidth.value = c.revealWidth;
        u.uRevealGlow.value = c.revealGlow * g.glow;
        u.uRevealColor.value.copy(getColor(c.colorMid));
        u.uMouth.value.copy(this.mouth);
        u.uThroat.value = (this.throat ?? 0) * c.throatGlow * g.glow + this.jaw * 0.6;
        u.uThroatRadius.value = 0.55 * (c.wingspan / 8.5);
        u.uThroatColor.value.copy(getColor(c.colorMid));
        u.uUnder.value = c.underGlow * (0.15 + burning * life) * g.glow;
        u.uUnderColor.value.copy(getColor(c.colorHot));
        u.uRim.value = c.dragonRim * g.fresnel;
        u.uRimPower.value = c.dragonRimPower;
        u.uRimColor.value.copy(getColor(c.colorRim));
        u.uDissolve.value = 0;
      }
      // The part past the tear would still cast its shadow on the floor.
      if (this.dragon) for (const mesh of this.dragon.meshes) mesh.castShadow = !revealing;
    }

    /* the floor */
    {
      const u = this.groundMaterial.uniforms;
      u.uCentre.value.copy(this.centre);
      u.uRadius.value = R;
      u.uStart.value = this.startAngle;
      u.uDir.value = this.turn;
      u.uTraced.value = traced;
      u.uBand.value = c.ringBand;
      u.uFront.value = this.frontRadius;
      u.uWobble.value = c.frontWobble;
      u.uFrontWidth.value = c.frontWidth;
      u.uFrontGlow.value = c.frontGlow * g.glow * saturate(this.frontRadius + 0.6);
      u.uHeatReach.value = c.heatReach;
      u.uHeat.value = (0.25 + 0.75 * life) * (1 - smoothstep(0.1, 0.8, this.burnout));
      u.uChar.value = c.charDark;
      u.uCharFade.value = 1 - smoothstep(0.35, 1.0, this.burnout);
      u.uCrackScale.value = c.crackScale;
      u.uCrackWidth.value = c.crackWidth;
      u.uCrackGlow.value = c.crackGlow * g.glow;
      u.uEmberGlow.value = c.groundEmbers * g.glow;
      u.uAsh.value = c.ash;
      u.uFlash.value = this.lightBoost * 0.004;
      u.uColorChar.value.copy(getColor(c.colorChar));
      u.uColorAsh.value.copy(getColor(c.colorAsh));
      u.uColorHot.value.copy(getColor(c.colorHot));
      u.uColorCrack.value.copy(getColor(c.colorCrack));
      u.uColorEmber.value.copy(getColor(c.colorMid));
      this.ground.position.set(this.centre.x, 0.025, this.centre.z);
      this.ground.scale.setScalar(R * 2.8);
    }

    /* the ring */
    {
      const u = this.ringMaterial.uniforms;
      fire(u);
      u.uCentre.value.copy(this.centre);
      u.uRadius.value = R;
      u.uHeight.value = c.ringHeight * 1.6;
      u.uThick.value = c.ringThick;
      u.uWobble.value = 0;
      u.uStart.value = this.startAngle;
      u.uDir.value = this.turn;
      u.uTraced.value = traced;
      u.uGrow.value = c.ringGrow;
      u.uFlare.value = c.ringFlare;
      u.uNoiseScale.value = c.ringNoiseScale * g.noiseFrequency;
      u.uRise.value = c.ringRise * g.noiseSpeed;
      u.uShred.value = c.ringShred * g.noiseStrength;
      u.uIntensity.value = c.ringIntensity * g.glow * g.shaderIntensity;
      u.uOpacity.value = opacity;
      u.uLife.value = life / 1.6;
      this.ring.visible = landed && traced > 0.001 && life > 0.002;
    }

    /* the front */
    {
      const u = this.frontMaterial.uniforms;
      fire(u);
      const r = this.frontRadius;
      const rising = smoothstep(0, 0.35, t - p.spread0);
      const shrinking = saturate(r / 1.2);
      u.uCentre.value.copy(this.centre);
      u.uRadius.value = Math.max(0.05, r);
      u.uHeight.value = c.frontHeight * 1.6;
      u.uThick.value = c.ringThick * 0.8;
      // Only a little of the floor's raggedness: a wall pleated as hard as
      // the edge it stands on shows every pleat edge-on as a bright bar. The
      // blaze tongues lit along the edge carry the rest of it.
      u.uWobble.value = c.frontWobble * 0.2;
      u.uSeed.value = this.groundMaterial.uniforms.uSeed.value;
      u.uStart.value = 0;
      u.uDir.value = 1;
      u.uTraced.value = 100;
      u.uGrow.value = 0.01;
      u.uFlare.value = 0.4;
      u.uNoiseScale.value = c.ringNoiseScale * g.noiseFrequency;
      u.uRise.value = c.ringRise * g.noiseSpeed;
      u.uShred.value = c.ringShred * 1.4 * g.noiseStrength;
      u.uIntensity.value = c.ringIntensity * 0.8 * g.glow * g.shaderIntensity;
      u.uOpacity.value = opacity;
      u.uLife.value = (rising * shrinking) / 1.6;
      this.frontWall.visible = landed && t >= p.spread0 && r > 0.05 && r < R;
    }

    /* the blaze */
    {
      const u = this.blazeMaterial.uniforms;
      fire(u);
      u.uCentre.value.copy(this.centre);
      u.uRadius.value = R;
      u.uSeed.value = this.groundMaterial.uniforms.uSeed.value;
      u.uWobble.value = c.frontWobble;
      u.uClock.value = landed ? t - p.spread0 : -100;
      u.uSpreadTime.value = Math.max(0.3, c.spreadTime);
      u.uHeight.value = c.blazeHeight;
      u.uWidth.value = c.blazeWidth;
      u.uBurnTime.value = c.blazeBurn;
      u.uSustain.value = c.blazeSustain;
      u.uLeap.value = c.blazeLeap;
      u.uLife.value = life;
      u.uNoiseScale.value = c.blazeNoiseScale * g.noiseFrequency;
      u.uRise.value = c.ringRise * g.noiseSpeed;
      u.uShred.value = c.ringShred * g.noiseStrength;
      u.uIntensity.value = c.blazeIntensity * g.glow * g.shaderIntensity;
      u.uOpacity.value = opacity;
      this.blaze.visible = landed && t >= p.spread0 && life > 0.002;
    }

    /* the breath */
    {
      const u = this.breathMaterial.uniforms;
      fire(u);
      u.uWidthMouth.value = c.breathWidth * (c.wingspan / 8.5);
      u.uWidthEnd.value = c.breathSpread;
      u.uCore.value = c.breathCore;
      u.uFlow.value = c.breathSpeed * g.particleSpeed;
      u.uNoiseScale.value = c.breathNoiseScale * g.noiseFrequency;
      u.uShred.value = c.breathShred * g.noiseStrength;
      u.uIntensity.value = c.breathIntensity * g.glow * g.shaderIntensity;
      u.uOpacity.value = opacity;
    }

    /* the heat over it */
    {
      const u = this.hazeMaterial.uniforms;
      const heat = saturate((traced / TAU) * 0.5 + (t >= p.spread0 ? 0.5 : 0)) * life;
      u.uWidth.value = R * 2.4;
      u.uHeight.value = c.hazeHeight;
      u.uStrength.value = c.heatHaze * g.distortion;
      u.uFade.value = heat * (1 - smoothstep(0.2, 0.9, this.burnout));
      this.haze.position.set(this.centre.x, 0, this.centre.z);
      this.haze.visible = landed && u.uFade.value > 0.01;
    }

    /* the particle systems — shared, so re-dressed every frame */
    {
      const u = this.flames.uniforms;
      // Born orange, not white — a white puff the size of a flame reads as
      // steam — and gone before it cools: a red one reads as a ball.
      this.flames.setGradient(getColor(c.colorMid), getColor(c.colorMid), getColor(c.colorMid), getColor(c.colorEdge));
      u.uGravity.value.set(0, 3.0, 0);
      u.uDrag.value = 2.4;
      u.uTurbulence.value = 0.9 * g.turbulence;
      u.uTurbFrequency.value = 0.8;
      u.uTurbSpeed.value = 0.6;
      u.uEndSize.value = 1.4;
      u.uSizeIn.value = 0.08;
      u.uFadeIn.value = 0.06;
      // Gone before it cools to a ball of red: fire puffs are hot or nothing.
      u.uFadeOut.value = 0.8;
      u.uGlow.value = 1.5 * g.glow;
      u.uOpacity.value = 0.75 * opacity;
    }
    {
      const u = this.embers.uniforms;
      this.embers.setGradient(getColor('#ffffff'), getColor(c.colorCore), getColor(c.colorMid), getColor(c.colorEdge));
      u.uGravity.value.set(0, 1.5, 0);
      u.uDrag.value = 1.1;
      u.uTurbulence.value = 1.0 * g.turbulence;
      u.uTurbFrequency.value = 0.7;
      u.uTurbSpeed.value = 0.5;
      u.uEndSize.value = 0.3;
      u.uSizeIn.value = 0.05;
      u.uFadeIn.value = 0.05;
      u.uFadeOut.value = 0.5;
      u.uGlow.value = 2.6 * g.glow;
      u.uOpacity.value = opacity;
    }
    {
      const u = this.sparks.uniforms;
      this.sparks.setGradient(getColor('#ffffff'), getColor(c.colorCore), getColor(c.colorMid), getColor(c.colorEdge));
      u.uGravity.value.set(0, -9, 0);
      u.uDrag.value = 1.4;
      u.uTurbulence.value = 0.2;
      u.uStretch.value = 0.08;
      u.uEndSize.value = 0.3;
      u.uFadeOut.value = 0.5;
      u.uGlow.value = 2.4 * g.glow;
      u.uOpacity.value = opacity;
    }
    {
      const u = this.smoke.uniforms;
      this.smoke.setGradient(getColor('#4a3a30'), getColor('#2a221e'), getColor('#18130f'), getColor('#0e0b09'));
      u.uGravity.value.set(0, 1.0, 0);
      u.uDrag.value = 1.6;
      u.uTurbulence.value = 0.6 * g.turbulence;
      u.uTurbFrequency.value = 0.6;
      u.uEndSize.value = 3.2;
      u.uFadeIn.value = 0.15;
      u.uFadeOut.value = 0.45;
      u.uGlow.value = 0.3;
      u.uOpacity.value = c.smokeOpacity * opacity;
    }
    {
      const u = this.flashes.uniforms;
      this.flashes.setGradient(getColor('#ffffff'), getColor(c.colorCore), getColor(c.colorMid), getColor(c.colorMid));
      u.uGravity.value.set(0, 0, 0);
      u.uDrag.value = 1;
      u.uTurbulence.value = 0;
      u.uEndSize.value = 1.6;
      u.uSizeIn.value = 0.001;
      u.uFadeIn.value = 0;
      u.uFadeOut.value = 0.3;
      u.uGlow.value = 2.4 * g.glow;
      u.uOpacity.value = opacity;
    }
  }

  /* ------------------------------------------------------------------ */
  /* emitters                                                            */
  /* ------------------------------------------------------------------ */

  /** The breath's gas and its splash, the ring's embers, the field's fire and smoke. */
  _emitters(dt, c, p) {
    const g = settings.global;
    const time = frame.uTime.value;
    const R = c.zoneRadius;
    const t = this.show;
    const life = this._fireLife(p);

    _emit.tint = null;
    _emit.inherit = null;
    _emit.time = time;

    /* the breath: puffs down the jet, and a splash where it lands */
    if (this.breath.visible) {
      const bu = this.breathMaterial.uniforms;
      const A = bu.uFrom.value;
      const B = bu.uBend.value;
      const C = bu.uTo.value;
      const t0 = bu.uCut.value;
      const t1 = bu.uExtend.value;
      const n = this._breathPuffs.tick(dt, c.breathPuffs * g.particleCount);
      _inherit.copy(this.vel).multiplyScalar(0.35);
      for (let i = 0; i < n; i++) {
        const s = t0 + (t1 - t0) * Math.pow(Math.random(), 0.8);
        const q = 1 - s;
        _emit.position.set(0, 0, 0).addScaledVector(A, q * q).addScaledVector(B, 2 * q * s).addScaledVector(C, s * s);
        _emit.direction
          .set(0, 0, 0)
          .addScaledVector(B, 2 * q)
          .addScaledVector(A, -2 * q)
          .addScaledVector(C, 2 * s)
          .addScaledVector(B, -2 * s)
          .normalize();
        _emit.radius = c.breathSpread * 0.3 * s + 0.05;
        _emit.speed = c.breathSpeed * 0.35;
        _emit.speedVariance = 0.4;
        _emit.spread = 0.25;
        _emit.size = (c.breathWidth + c.breathSpread * s) * 1.1;
        _emit.sizeVariance = 0.4;
        _emit.life = 0.32;
        _emit.lifeVariance = 0.4;
        _emit.spin = 2;
        _emit.inherit = _inherit;
        this.flames.emit(1, _emit);
      }
      _emit.inherit = null;

      // Where it lands: thrown out along the floor, and sparks.
      if (t1 >= 0.98) {
        const m = this._splash.tick(dt, c.splashRate * g.particleCount * this.breathHeat);
        for (let i = 0; i < m; i++) {
          const a = Math.random() * TAU;
          _emit.position.copy(C).setY(0.25);
          _emit.direction.set(Math.cos(a), 0.55, Math.sin(a)).normalize();
          _emit.radius = 0.3;
          _emit.speed = 4.5;
          _emit.speedVariance = 0.5;
          _emit.spread = 0.3;
          _emit.size = 0.7;
          _emit.sizeVariance = 0.4;
          _emit.life = 0.55;
          _emit.lifeVariance = 0.4;
          _emit.spin = 1.5;
          this.flames.emit(1, _emit);
        }
        const k = this._sparks.tick(dt, c.breathSparks * g.particleCount * this.breathHeat);
        for (let i = 0; i < k; i++) {
          _emit.position.copy(C).setY(0.2);
          _emit.direction.set(Math.random() - 0.5, 1.2, Math.random() - 0.5).normalize();
          _emit.radius = 0.4;
          _emit.speed = 6.5;
          _emit.speedVariance = 0.5;
          _emit.spread = 0.6;
          _emit.size = 0.05;
          _emit.sizeVariance = 0.5;
          _emit.life = 0.7;
          _emit.lifeVariance = 0.4;
          _emit.spin = 0;
          this.sparks.emit(1, _emit);
        }
      }
    }

    /* embers and licks off the lit ring */
    const traced = this._traced(c, p);
    if (traced > 0.01) {
      const n = this._ringEmbers.tick(dt, c.ringEmbers * g.particleCount * life * (1 - this.burnout));
      const span = Math.min(traced, TAU);
      for (let i = 0; i < n; i++) {
        const a = this.startAngle + this.turn * Math.random() * span;
        const r = R + (Math.random() - 0.5) * c.ringThick * 2;
        _emit.position.set(this.centre.x + Math.cos(a) * r, 0.3 + Math.random() * c.ringHeight * 0.6, this.centre.z + Math.sin(a) * r);
        _emit.direction.set(0, 1, 0);
        _emit.radius = 0.1;
        _emit.speed = 1.6;
        _emit.speedVariance = 0.6;
        _emit.spread = 0.6;
        _emit.size = 0.07;
        _emit.sizeVariance = 0.6;
        _emit.life = 1.8;
        _emit.lifeVariance = 0.5;
        _emit.spin = 0;
        this.embers.emit(1, _emit);
        if (Math.random() < 0.35) {
          _emit.position.y = 0.2;
          _emit.radius = 0.25;
          _emit.speed = 1.2;
          _emit.size = 0.75;
          _emit.life = 0.6;
          _emit.spin = 1.4;
          this.flames.emit(1, _emit);
        }
      }
    }

    /* the field: fire, embers and smoke everywhere the front has been */
    const burntOut = Math.min(R, R - this.frontRadius);
    if (t >= p.spread0 && burntOut > 0.05) {
      // Weighted by area: the burnt annulus is what is alight.
      const inner = Math.max(0, this.frontRadius);
      const share = 1 - (inner * inner) / (R * R);
      const pick = (out) => {
        const a = Math.random() * TAU;
        const r = Math.sqrt(inner * inner + Math.random() * (R * R - inner * inner));
        return out.set(this.centre.x + Math.cos(a) * r, 0, this.centre.z + Math.sin(a) * r);
      };
      const f = this._fieldPuffs.tick(dt, c.fieldPuffs * share * g.particleCount * life * (1 - this.burnout) ** 3);
      for (let i = 0; i < f; i++) {
        pick(_emit.position).setY(0.25);
        _emit.direction.set(0, 1, 0);
        _emit.radius = 0.3;
        _emit.speed = 2.4;
        _emit.speedVariance = 0.5;
        _emit.spread = 0.2;
        _emit.size = 0.45;
        _emit.sizeVariance = 0.4;
        _emit.life = 0.5;
        _emit.lifeVariance = 0.4;
        _emit.spin = 1.2;
        this.flames.emit(1, _emit);
      }
      const linger = this.burnout > 0 ? c.lingerEmbers * (1 - this.burnout) : 0;
      const e = this._fieldEmbers.tick(dt, (c.fieldEmbers * share * life + linger) * g.particleCount);
      for (let i = 0; i < e; i++) {
        pick(_emit.position).setY(0.1 + Math.random() * 0.4);
        _emit.direction.set(0, 1, 0);
        _emit.radius = 0.1;
        _emit.speed = 1.3;
        _emit.speedVariance = 0.6;
        _emit.spread = 0.6;
        _emit.size = 0.07;
        _emit.sizeVariance = 0.6;
        _emit.life = 2.2;
        _emit.lifeVariance = 0.5;
        _emit.spin = 0;
        this.embers.emit(1, _emit);
      }
      // Smoke climbs off the field as it burns, and goes on climbing after.
      const smoke = c.smokeRate * share * (0.5 + 0.5 * life) * (1 - smoothstep(0.4, 1, this.burnout));
      const s = this._smoke.tick(dt, smoke * g.particleCount);
      for (let i = 0; i < s; i++) {
        pick(_emit.position).setY(c.blazeHeight * 0.8);
        _emit.direction.set(0, 1, 0);
        _emit.radius = 0.6;
        _emit.speed = 1.2;
        _emit.speedVariance = 0.5;
        _emit.spread = 0.3;
        _emit.size = 1.3;
        _emit.sizeVariance = 0.4;
        _emit.life = 3.2;
        _emit.lifeVariance = 0.3;
        _emit.spin = 0.5;
        this.smoke.emit(1, _emit);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* lights                                                              */
  /* ------------------------------------------------------------------ */

  /** The field's glow, and one hot light that follows the breath or sits in the tear. */
  _fieldLights(dt, c, p) {
    const g = settings.global;
    const life = this._fireLife(p);
    const R = c.zoneRadius;
    const t = this.show;

    if (this.fieldLight) {
      const ring = saturate(this._traced(c, p) / TAU);
      const field = t >= p.spread0 ? saturate(1 - Math.max(0, this.frontRadius) / R) : 0;
      const gutter = 0.85 + 0.15 * Math.sin(t * 9.1) * Math.sin(t * 3.3 + 1.1);
      _p.set(this.centre.x, 1.4, this.centre.z);
      this.lightColor.copy(getColor(c.colorHot));
      this.ctx.lights.set(
        this.fieldLight,
        _p,
        this.lightColor,
        c.fieldLight * (ring * 0.45 + field * 0.75) * life * gutter,
        c.fieldLightRadius,
        dt
      );
    }

    if (this.hotLight) {
      let intensity = 0;
      if (this.breath.visible) {
        this.hotAt.copy(this.breathAt).lerp(this.mouth, 0.35).setY(Math.max(0.8, this.hotAt.y));
        intensity = c.breathLight * this.breathHeat;
      } else if (this.portalOpenNow > 0.01) {
        this.hotAt.copy(this.portalAt).addScaledVector(this.portalNormal, 1.5);
        intensity = c.portalLight * this.portalOpenNow;
      }
      this.lightColor.copy(getColor(c.colorMid));
      this.ctx.lights.set(this.hotLight, this.hotAt, this.lightColor, intensity * g.explosionIntensity, c.portalLightRadius, dt);
    }
  }

  /**
   * The ability's own light rides the dragon, not the camera's framing point:
   * it is the fire's light on the beast, and it goes where the beast goes.
   */
  _updateLight(dt, scale) {
    if (!this.light) return;
    const c = this.config;
    const at = this.u >= 1 && this.root.visible ? this.root.position : this.position;
    this.lightColor.copy(getColor(c.lightColor));
    this.ctx.lights.set(
      this.light,
      at,
      this.lightColor,
      c.lightIntensity * scale * this.lightShimmer() + this.lightBoost,
      c.lightRadius * (1 + this.lightBoost * 0.02),
      dt
    );
    this.lightBoost = Math.max(0, this.lightBoost - this.lightBoost * 4.5 * dt - 0.5 * dt);
  }

  /** A gutter, not a shimmer: it is a fire. */
  lightShimmer() {
    const c = this.config;
    const t = this.age;
    const gutter = Math.sin(t * c.lightGutterSpeed) * Math.sin(t * c.lightGutterSpeed * 0.37 + 1.3);
    const on = this.u < 1 ? 0.5 : this.root.visible ? 1 : 0;
    return (1 - c.lightGutter * 0.5 + c.lightGutter * 0.5 * gutter) * on;
  }

  dispose() {
    super.dispose();
    for (const material of this.hideMaterials) material.dispose();
    this.portalMaterial.dispose();
    this.groundMaterial.dispose();
    this.ringMaterial.dispose();
    this.frontMaterial.dispose();
    this.blazeMaterial.dispose();
    this.breathMaterial.dispose();
    this.hazeMaterial.dispose();
    this.portal.geometry.dispose();
    this.ground.geometry.dispose();
    this.ring.geometry.dispose();
    this.blaze.geometry.dispose();
    this.breath.geometry.dispose();
    this.haze.geometry.dispose();
  }
}
