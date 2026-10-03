import { CylinderGeometry, Group, Mesh, PlaneGeometry, Quaternion, Vector3 } from 'three';
import { Ability, AbilityPhase } from './Ability.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { DecalType } from '../effects/GroundDecals.js';
import { BurstMode } from '../effects/BurstSphere.js';
import { LightningBolt } from '../effects/LightningBolt.js';
import { createBoltMaterial } from '../materials/GyroscopeMaterials.js';
import {
  createFanMaterial,
  createOrbMaterial,
  createOrbitMaterial,
  createTomeBodyUniforms,
  createTomeSigilMaterial,
  patchTomeBody
} from '../materials/TomeMaterials.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { Easing, saturate } from '../utils/math.js';

/** Where the show is. `Ability#phase` only says active or done; this is the real machine. */
export const TomeAct = Object.freeze({
  CONJURE: 'conjure',
  FLIGHT: 'flight',
  GROW: 'grow',
  OPEN: 'open',
  JUDGE: 'judge',
  CLOSE: 'close',
  GONE: 'gone'
});

const TAU = Math.PI * 2;
/** Planets the orrery can carry, at most; `planets` in the settings picks how many show. */
const PLANETS = 6;
/** Two tight rings turn round the star itself, gyroscope-fashion. */
const CORE_RINGS = 2;
/** Lights in the air at once, at most. */
const COMETS = 16;
/** The beam each light draws behind it. */
const BEAMS = COMETS;

/** How steep each orbit is tilted, before a little jitter per cast — the first is the big crossing one. */
const ORBIT_TILT = [1.2, 0.38, 0.85, 0.55, 1.02, 0.22];
/** Each orbit's radius, × `holoRadius`. */
const ORBIT_RADIUS = [1.0, 0.78, 0.6, 0.46, 0.88, 0.68];
/** Each planet's speed round its orbit, × `orbitSpeed`; inner ones run faster. */
const ORBIT_RATE = [0.55, 0.8, 1.1, 1.45, 0.65, 0.95];

const UP = new Vector3(0, 1, 0);
const _p = new Vector3();
const _q = new Vector3();
const _d = new Vector3();
const _eye = new Vector3();
const _quat = new Quaternion();
const _emit = {
  position: new Vector3(),
  direction: new Vector3(),
  inherit: null,
  anchor: null,
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

/** A random unit vector, uniform on the sphere. */
function randomUnit(out) {
  const z = Math.random() * 2 - 1;
  const a = Math.random() * TAU;
  const s = Math.sqrt(1 - z * z);
  return out.set(Math.cos(a) * s, z, Math.sin(a) * s);
}

/** Quadratic Bézier, `a` → `b` bowed toward `c`. */
function bezier(a, c, b, t, out) {
  const s = 1 - t;
  return out.set(
    s * s * a.x + 2 * s * t * c.x + t * t * b.x,
    s * s * a.y + 2 * s * t * c.y + t * t * b.y,
    s * s * a.z + 2 * s * t * c.z + t * t * b.z
  );
}

/**
 * THE ASTRAL TOME — a book that opens the sky over a circle.
 *
 * A far cast. Then:
 *
 *   1. **The conjuring.** The tome materialises at the caster's shoulder,
 *      small, burning in out of nothing along a front of blue fire while motes
 *      spiral into it.
 *   2. **The flight.** It sails up and over to the middle of the circle,
 *      turning as it goes and shedding starlight behind it.
 *   3. **The growing.** It swells to full size over the circle, the zodiac
 *      writes itself round the floor, and the dial on its cover lights.
 *   4. **The opening.** A fan of light pours up out of the dial; a star rises
 *      out of it and the orrery draws itself round the star — orbits of light
 *      at every tilt, a planet on each, and a field of stars about them all.
 *   5. **The judgement.** Every `strikeInterval` a planet tears free of its
 *      orbit and comes down on the nearest body in the circle as a light,
 *      drawing a beam behind it, and that body is struck dead. The planet
 *      regathers on its orbit. With nobody left the lights fall on the floor.
 *   6. **The closing.** The star throws a light at everyone still standing,
 *      the orrery collapses back into the dial, and the tome unmakes itself.
 *
 * It answers `handlesOwnHits`: it decides who is struck, and when.
 *
 * Nothing about the model is known here: `TomeRig` hands over a tome a metre
 * across, centred, cover up, with the height of its dial — and that is the
 * whole contract.
 */
export class TomeAbility extends Ability {
  constructor(context) {
    super('tome', context);
  }

  get handlesOwnHits() {
    return true;
  }

  /** The tome roams from the caster to the circle; keep it framed throughout. */
  get cameraWeight() {
    return 0.65;
  }

  /* ------------------------------------------------------------------ */
  /* construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    const rig = this.ctx.models?.tome ?? null;
    this.rig = rig;

    /* ---- the book ---- */
    this.book = new Group();
    this.book.name = 'Tome';
    this.book.rotation.order = 'YXZ';
    this.group.add(this.book);
    this.bodyUniforms = createTomeBodyUniforms();
    this.bodyMeshes = [];
    this.bodyMaterials = [];
    if (rig) {
      for (const source of rig.source.children) {
        // One set of materials per instance, so one tome's materialising
        // never prints out another's.
        const material = patchTomeBody(source.material.clone(), this.bodyUniforms);
        const mesh = new Mesh(source.geometry, material);
        mesh.name = source.name;
        mesh.layers.set(LAYER.WORLD);
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        this.book.add(mesh);
        this.bodyMeshes.push(mesh);
        this.bodyMaterials.push(material);
      }
    }

    /* ---- the zodiac on the floor ---- */
    const flat = new PlaneGeometry(1, 1);
    flat.rotateX(-Math.PI / 2);
    this.sigilMaterial = createTomeSigilMaterial();
    this.sigil = new Mesh(flat, this.sigilMaterial);
    this.sigil.layers.set(LAYER.VFX);
    this.sigil.renderOrder = 6;
    this.sigil.frustumCulled = false;
    this.group.add(this.sigil);

    /* ---- the fan of light out of the dial ---- */
    const fan = new CylinderGeometry(1, 0.08, 1, 64, 1, true);
    fan.translate(0, 0.5, 0);
    this.fanMaterial = createFanMaterial();
    this.fan = new Mesh(fan, this.fanMaterial);
    this.fan.layers.set(LAYER.VFX);
    this.fan.renderOrder = 9;
    this.fan.frustumCulled = false;
    this.group.add(this.fan);

    /* ---- the orrery ---- */
    const quad = new PlaneGeometry(1, 1);
    const ringQuad = new PlaneGeometry(2.3, 2.3);
    ringQuad.rotateX(-Math.PI / 2);

    const makeOrb = (order) => {
      const mesh = new Mesh(quad, createOrbMaterial());
      mesh.layers.set(LAYER.VFX);
      mesh.renderOrder = order;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      return mesh;
    };

    this.core = makeOrb(17);
    this.planets = [];
    for (let i = 0; i < PLANETS; i++) {
      this.planets.push({
        mesh: makeOrb(16),
        angle: 0,
        charge: 1,
        position: new Vector3()
      });
    }

    this.orbits = [];
    for (let i = 0; i < PLANETS + CORE_RINGS; i++) {
      const mesh = new Mesh(ringQuad, createOrbitMaterial());
      mesh.layers.set(LAYER.VFX);
      mesh.renderOrder = 12;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.orbits.push({ mesh, tilt: new Quaternion(), reveal: 0 });
    }

    /* ---- the lights it throws, and the beams behind them ---- */
    this.comets = [];
    for (let i = 0; i < COMETS; i++) {
      this.comets.push({
        live: false,
        mesh: makeOrb(18),
        from: new Vector3(),
        to: new Vector3(),
        bow: new Vector3(),
        at: new Vector3(),
        length: 1,
        age: 0,
        flight: 0.4,
        dummy: null,
        dirX: 0,
        dirZ: 1,
        big: false
      });
    }
    this.beams = [];
    for (let i = 0; i < BEAMS; i++) {
      const beam = new LightningBolt(createBoltMaterial());
      this.beams.push(beam);
      this.group.add(beam.mesh);
    }

    /* ---- state ---- */
    this.centre = new Vector3();
    this.conjureAt = new Vector3();
    this.hoverAt = new Vector3();
    this.flyControl = new Vector3();
    this.bookPos = new Vector3();
    this.dialTop = new Vector3();
    this.corePos = new Vector3();
    this.act = TomeAct.CONJURE;
    this.show = 0;
    this.flightTime = 1;
    this.yaw = 0;
    this.bookScale = 1;
    this.materialise = 0;
    this.holo = 0;
    this.lift = 0;
    this.fanRise = 0;
    this.coreAppear = 0;
    this.charge = 0;
    this.pulse = 0;
    this.sigilReveal = 0;
    this.sigilFade = 1;
    this.lightScale = 0;
    this.strikeTimer = 0;
    this.nextPlanet = 0;
    this.finaleDone = false;
    this.hitLight = null;
    this.hitLightAt = new Vector3();
    this.hitLightPower = 0;
    this.shadowsOn = false;
    this._targets = [];

    this._motes = new RateEmitter(60);
    this._trail = new RateEmitter(60);
    this._stars = new RateEmitter(60);
    this._rise = new RateEmitter(60);
    this._shed = new RateEmitter(60);
  }

  createParticles() {
    const P = this.ctx.particles;
    this.motes = P.get('tomeMote', {
      capacity: 900,
      shape: ParticleShape.SOFT,
      additive: true,
      swirl: true,
      softFade: 0.1
    });
    this.stars = P.get('tomeStar', { capacity: 700, shape: ParticleShape.GLINT, additive: true });
    this.sparks = P.get('tomeSpark', {
      capacity: 900,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.1
    });
    this.flashes = P.get('tomeFlash', { capacity: 128, shape: ParticleShape.GLINT, additive: true });
    this.trail = P.get('tomeTrail', { capacity: 1400, shape: ParticleShape.SOFT, additive: true, softFade: 0.1 });
  }

  /* ------------------------------------------------------------------ */
  /* the plan                                                            */
  /* ------------------------------------------------------------------ */

  /** Act boundaries in show seconds, re-read every frame so the editor is live. */
  _plan(c) {
    const p = this._planned ?? (this._planned = {});
    p.conjure1 = Math.max(0.2, c.conjureTime);
    p.flight1 = p.conjure1 + this.flightTime;
    p.grow1 = p.flight1 + Math.max(0.1, c.growTime);
    p.open1 = p.grow1 + Math.max(0.1, c.openTime);
    p.judge1 = p.open1 + Math.max(0.2, c.judgeTime);
    p.close1 = p.judge1 + Math.max(0.2, c.closeTime);
    return p;
  }

  _actAt(t, p) {
    if (t < p.conjure1) return TomeAct.CONJURE;
    if (t < p.flight1) return TomeAct.FLIGHT;
    if (t < p.grow1) return TomeAct.GROW;
    if (t < p.open1) return TomeAct.OPEN;
    if (t < p.judge1) return TomeAct.JUDGE;
    if (t < p.close1) return TomeAct.CLOSE;
    // Never leave with a light still in the air: it owes somebody a death.
    return this._cometsLive() ? TomeAct.CLOSE : TomeAct.GONE;
  }

  /* ------------------------------------------------------------------ */
  /* lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    const c = this.config;
    // The base class would run a front along the line; this cast has its own
    // clock, and the line only says where the circle is.
    this.phase = AbilityPhase.IMPACT;
    this.u = 1;
    this.pointAt(1, this.centre);

    // At the caster's shoulder, a little ahead and to the side.
    this.conjureAt
      .copy(this.origin)
      .addScaledVector(this.direction, c.conjureReach)
      .addScaledVector(this.side, c.conjureSide)
      .setY(c.conjureHeight);
    this.hoverAt.copy(this.centre).setY(c.hoverHeight);
    this.flyControl.addVectors(this.conjureAt, this.hoverAt).multiplyScalar(0.5);
    this.flyControl.y = Math.max(this.conjureAt.y, this.hoverAt.y) + c.flyArc;
    const distance = this.conjureAt.distanceTo(this.hoverAt);
    this.flightTime = Math.min(c.flyMax, Math.max(c.flyMin, distance / Math.max(0.5, c.flySpeed)));

    this.act = TomeAct.CONJURE;
    this.show = 0;
    this.yaw = Math.atan2(this.direction.x, this.direction.z);
    this.bookPos.copy(this.conjureAt);
    this.position.copy(this.conjureAt);
    this.bookScale = c.conjureSize;
    this.materialise = 0;
    this.holo = 0;
    this.lift = 0;
    this.fanRise = 0;
    this.coreAppear = 0;
    this.charge = 0;
    this.pulse = 0;
    this.sigilReveal = 0;
    this.sigilFade = 1;
    this.lightScale = 0;
    this.strikeTimer = 0;
    this.nextPlanet = 0;
    this.finaleDone = false;
    this.hitLightPower = 0;

    // Every cast a new sky: the orbits are tilted afresh, the planets start
    // somewhere else on them.
    for (let i = 0; i < PLANETS; i++) {
      const tilt = ORBIT_TILT[i] + (Math.random() - 0.5) * 0.3;
      const heading = Math.random() * TAU;
      this.orbits[i].tilt.setFromAxisAngle(_d.set(Math.cos(heading), 0, Math.sin(heading)), tilt);
      this.orbits[i].reveal = 0;
      this.planets[i].angle = Math.random() * TAU;
      this.planets[i].charge = 1;
    }
    for (const comet of this.comets) {
      comet.live = false;
      comet.dummy = null;
    }
    for (const beam of this.beams) beam.kill();
    this._motes.reset();
    this._trail.reset();
    this._stars.reset();
    this._rise.reset();
    this._shed.reset();

    this.hitLight = this.ctx.lights.acquire();
    this._castShadows(false);
    this._hideAll();
    this.book.visible = !!this.rig;

    // A flash at the shoulder as it is called.
    _emit.position.copy(this.conjureAt);
    _emit.direction.set(0, 1, 0);
    _emit.radius = 0;
    _emit.speed = 0;
    _emit.spread = 0;
    _emit.size = 1.4;
    _emit.sizeVariance = 0.1;
    _emit.life = 0.25;
    _emit.lifeVariance = 0.1;
    _emit.spin = 2;
    _emit.anchor = null;
    _emit.time = frame.uTime.value;
    this.flashes.emit(1, _emit);
  }

  onDestroy() {
    this.ctx.lights.release(this.hitLight);
    this.hitLight = null;
    for (const beam of this.beams) beam.kill();
    for (const comet of this.comets) {
      comet.live = false;
      comet.dummy = null;
    }
    this._hideAll();
    this._castShadows(false);
  }

  _hideAll() {
    this.book.visible = false;
    this.sigil.visible = false;
    this.fan.visible = false;
    this.core.visible = false;
    for (const planet of this.planets) planet.mesh.visible = false;
    for (const orbit of this.orbits) orbit.mesh.visible = false;
    for (const comet of this.comets) comet.mesh.visible = false;
  }

  _castShadows(on) {
    if (this.shadowsOn === on) return;
    this.shadowsOn = on;
    for (const mesh of this.bodyMeshes) mesh.castShadow = on;
  }

  _cometsLive() {
    for (const comet of this.comets) if (comet.live) return true;
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* the frame                                                           */
  /* ------------------------------------------------------------------ */

  update(dt) {
    if (!this.isActive) return;
    this.age += dt;
    const c = this.config;
    const p = this._plan(c);

    this.show += dt;
    const act = this._actAt(this.show, p);
    if (act !== this.act) this._enter(act, c);
    if (this.act === TomeAct.GONE) {
      this.phase = AbilityPhase.DONE;
      return;
    }

    this._perform(dt, c, p);
    if (this.act === TomeAct.JUDGE) this._judge(dt, c);
    this._comets(dt, c);
    this._emitters(dt, c, p);
    this._beams(dt);
    this._dress(c);
    this._updateLight(dt, this.lightScale);
    this._hitLightFrame(dt, c);
  }

  /** One-shot work on the frame an act begins. */
  _enter(act, c) {
    const g = settings.global;
    this.act = act;
    switch (act) {
      case TomeAct.FLIGHT:
        this.ctx.shake.add(0.04 * g.cameraShake, 3, 18);
        break;
      case TomeAct.GROW:
        this.sigil.visible = true;
        this.ctx.decals.spawn(DecalType.SHOCKWAVE, this.centre, {
          radius: c.zoneRadius,
          life: 0.8,
          intensity: 0.8,
          width: 0.05,
          colorA: getColor(c.colorSigil),
          colorB: getColor(c.colorSpark)
        });
        break;
      case TomeAct.OPEN:
        this._opened(c);
        break;
      case TomeAct.JUDGE:
        // The judgement opens on a throw, not on a wait.
        this.strikeTimer = 1e3;
        break;
      case TomeAct.CLOSE:
        this._finale(c);
        break;
      default:
        break;
    }
  }

  /* ---- the show, read off the clock ---- */

  _perform(dt, c, p) {
    const t = this.show;
    const g = settings.global;
    const bob = Math.sin(this.age * c.bobRate * TAU) * c.hoverBob;
    let pitch = 0;
    let roll = Math.sin(this.age * 1.7) * 0.04;
    let yawRate = c.yawSpeed;

    switch (this.act) {
      case TomeAct.CONJURE: {
        const k = saturate(t / p.conjure1);
        this.bookPos.copy(this.conjureAt).y += bob;
        this.bookScale = c.conjureSize * (0.55 + 0.45 * Easing.outBack(k));
        this.materialise = Easing.outCubic(saturate(k / 0.85));
        this.charge = 0.3 * this.materialise;
        yawRate = 0.9;
        break;
      }
      case TomeAct.FLIGHT: {
        const k = saturate((t - p.conjure1) / this.flightTime);
        const e = Easing.inOutCubic(k);
        bezier(this.conjureAt, this.flyControl, this.hoverAt, e, this.bookPos);
        this.bookPos.y += bob;
        this.bookScale = c.conjureSize;
        this.materialise = 1;
        // It turns as it flies, all of `flySpin` spent over the flight.
        yawRate = c.yawSpeed + (c.flySpin * TAU * Math.PI * 0.5 * Math.sin(Math.PI * k)) / this.flightTime;
        pitch = Math.sin(Math.PI * e) * c.flyTilt;
        roll += Math.sin(TAU * e) * 0.18;
        this.charge = 0.3;
        break;
      }
      case TomeAct.GROW: {
        const k = saturate((t - p.flight1) / (p.grow1 - p.flight1));
        this.bookPos.copy(this.hoverAt).y += bob;
        this.bookScale = c.conjureSize + (c.size - c.conjureSize) * Easing.outBack(k);
        this.materialise = 1;
        this.charge = 0.3 + 0.7 * Easing.inOutQuad(k);
        this.sigilReveal = Easing.inOutCubic(k);
        yawRate = c.yawSpeed + 1.4 * (1 - k);
        break;
      }
      case TomeAct.OPEN: {
        const k = saturate((t - p.grow1) / (p.open1 - p.grow1));
        this.bookPos.copy(this.hoverAt).y += bob;
        this.bookScale = c.size;
        this.charge = 1 + 0.5 * Math.sin(Math.PI * k);
        this.sigilReveal = 1;
        this.fanRise = Easing.outQuad(saturate(k / 0.45));
        this.lift = Easing.outCubic(saturate(k / 0.6));
        this.coreAppear = Easing.outBack(saturate((k - 0.15) / 0.45));
        this.holo = Easing.outCubic(saturate((k - 0.25) / 0.6));
        for (let i = 0; i < this.orbits.length; i++) {
          this.orbits[i].reveal = Easing.inOutQuad(saturate((k - 0.3 - i * 0.05) / 0.45));
        }
        break;
      }
      case TomeAct.JUDGE: {
        this.bookPos.copy(this.hoverAt).y += bob;
        this.bookScale = c.size;
        this.charge = 1;
        this.fanRise = 1;
        this.lift = 1;
        this.coreAppear = 1;
        this.holo = 1;
        for (const orbit of this.orbits) orbit.reveal = 1;
        break;
      }
      case TomeAct.CLOSE: {
        const k = saturate((t - p.judge1) / (p.close1 - p.judge1));
        // The orrery holds while the last lights leave, then falls in.
        const fall = Easing.inCubic(saturate((k - 0.2) / 0.45));
        this.holo = 1 - fall;
        this.lift = 1 - fall;
        this.coreAppear = 1 - fall;
        this.fanRise = 1 - Easing.inQuad(saturate((k - 0.35) / 0.35));
        this.charge = 1 - Easing.outQuad(saturate((k - 0.4) / 0.4));
        const unmake = saturate((k - 0.55) / 0.45);
        this.materialise = 1 - Easing.inQuad(unmake);
        this.bookPos.copy(this.hoverAt).y += bob + 0.5 * Easing.inQuad(unmake);
        this.bookScale = c.size * (1 - 0.2 * unmake);
        this.sigilFade = 1 - Easing.inQuad(saturate((k - 0.5) / 0.5));
        yawRate = c.yawSpeed + 3 * unmake;
        break;
      }
      default:
        break;
    }

    this.pulse = Math.max(0, this.pulse - dt * 2.2);
    this.yaw += yawRate * dt;

    this.book.position.copy(this.bookPos);
    this.book.rotation.set(pitch, this.yaw, roll);
    this.book.scale.setScalar(this.bookScale);
    this.book.updateMatrixWorld(true);

    // The dial, and the star the orrery turns round, over it.
    const dialY = this.rig ? this.rig.dialY : 0.2;
    this.dialTop.set(0, dialY, 0).applyMatrix4(this.book.matrixWorld);
    this.corePos.copy(this.dialTop);
    this.corePos.y += c.holoHeight * this.lift;

    // Planets run round their orbits all the time; they are only seen once
    // there is an orrery to see them in. A spent one gathers itself again.
    const R = c.holoRadius * this.holo;
    for (let i = 0; i < PLANETS; i++) {
      const planet = this.planets[i];
      planet.angle += dt * c.orbitSpeed * ORBIT_RATE[i];
      planet.charge = Math.min(1, planet.charge + dt / Math.max(0.05, c.planetRegrow));
      _p.set(Math.cos(planet.angle), 0, Math.sin(planet.angle)).multiplyScalar(R * ORBIT_RADIUS[i]);
      planet.position.copy(_p.applyQuaternion(this.orbits[i].tilt)).add(this.corePos);
    }
    // The two tight rings round the star turn on axes that wander.
    _quat.setFromAxisAngle(_d.set(1, 0, 0), this.age * 1.3);
    this.orbits[PLANETS].tilt.setFromAxisAngle(_d.set(0, 0, 1), this.age * 0.7).multiply(_quat);
    _quat.setFromAxisAngle(_d.set(0, 0, 1), this.age * -1.1);
    this.orbits[PLANETS + 1].tilt.setFromAxisAngle(_d.set(1, 0, 0), 0.9 + this.age * 0.5).multiply(_quat);

    this._castShadows(this.materialise > 0.98);

    // What the camera follows, and where the light sits: the book while it is
    // on its way, sliding up to the star once there is one.
    const onStar = saturate(this.coreAppear);
    this.position.lerpVectors(this.bookPos, this.corePos, onStar);
    this.lightScale =
      (0.25 + 0.3 * this.materialise * this.charge) * (1 - onStar) +
      (0.4 + 0.6 * Math.min(1.5, this.charge)) * onStar;

    if (this.act === TomeAct.OPEN) this.ctx.shake.rumble(0.03 * this.fanRise * g.cameraShake, dt);
  }

  /** The dial opens: a flash out of it, a pulse across the floor. */
  _opened(c) {
    const g = settings.global;
    _emit.position.copy(this.dialTop);
    _emit.direction.set(0, 1, 0);
    _emit.radius = 0;
    _emit.speed = 0;
    _emit.spread = 0;
    _emit.size = 3.0;
    _emit.sizeVariance = 0.1;
    _emit.life = 0.25;
    _emit.lifeVariance = 0.1;
    _emit.spin = 2;
    _emit.anchor = null;
    _emit.time = frame.uTime.value;
    this.flashes.emit(1, _emit);
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, this.centre, {
      radius: c.zoneRadius * 0.9,
      life: 0.9,
      intensity: 1.0,
      width: 0.07,
      colorA: getColor(c.colorSigil),
      colorB: getColor(c.colorSpark)
    });
    this.pulse = 1;
    this.lightBoost = 25 * g.explosionIntensity;
    this.ctx.shake.add(0.18 * g.cameraShake, 3, 20);
    if (c.openFlash > 0) this.ctx.flash.trigger(getColor(c.colorGlow), c.openFlash * g.explosionIntensity);
  }

  /* ---- the judgement ---- */

  _judge(dt, c) {
    const found = this.ctx.dummies?.findTargets?.(this.centre.x, this.centre.z, c.zoneRadius, this._targets) ?? this._targets;

    this.strikeTimer += dt;
    if (this.strikeTimer < Math.max(0.05, c.strikeInterval)) return;

    // The nearest body no light is already falling on.
    let mark = null;
    for (const dummy of found) {
      if (dummy.alive && !this._booked(dummy)) {
        mark = dummy;
        break;
      }
    }

    if (mark) {
      this.strikeTimer = 0;
      this._launch(this._source(_q), mark, null, c, false);
    } else if (this.strikeTimer >= 1 / Math.max(0.1, c.idleStrikeRate)) {
      // Nobody left: the lights fall on the floor of the circle anyway.
      this.strikeTimer = 0;
      const a = Math.random() * TAU;
      const r = Math.sqrt(0.15 + Math.random() * 0.85) * c.zoneRadius * 0.85;
      _p.set(this.centre.x + Math.cos(a) * r, 0.05, this.centre.z + Math.sin(a) * r);
      this._launch(this._source(_q), null, _p, c, false);
    }
  }

  /**
   * Where the next light leaves from: the most gathered planet, in turn — or
   * the star, if every planet is still spent.
   */
  _source(out) {
    const count = this._planetCount();
    for (let n = 0; n < count; n++) {
      const i = (this.nextPlanet + n) % count;
      const planet = this.planets[i];
      if (planet.charge >= 0.95) {
        this.nextPlanet = (i + 1) % count;
        planet.charge = 0;
        return out.copy(planet.position);
      }
    }
    return out.copy(this.corePos);
  }

  _planetCount() {
    return Math.min(PLANETS, Math.max(0, Math.round(this.config.planets)));
  }

  /** Whether a light is already on its way to this body. */
  _booked(dummy) {
    for (const comet of this.comets) if (comet.live && comet.dummy === dummy) return true;
    return false;
  }

  /** Where a light lands on a body: partway up it. */
  _aim(dummy, out) {
    return out.set(dummy.position.x, settings.dummies.height * saturate(this.config.aimHeight), dummy.position.z);
  }

  /**
   * Throw a light from `from` at a body — or, with no body, at `point`.
   * It flies the same bowed path the beam behind it is drawn along, so the
   * beam's head *is* the light.
   */
  _launch(from, dummy, point, c, big) {
    const comet = this.comets.find((s) => !s.live);
    if (!comet) return;
    comet.live = true;
    comet.big = big;
    comet.dummy = dummy;
    comet.age = 0;
    comet.from.copy(from);
    if (dummy) this._aim(dummy, comet.to);
    else comet.to.copy(point);
    comet.length = Math.max(0.1, comet.from.distanceTo(comet.to));
    comet.flight = Math.max(0.05, c.cometFlight) * (0.75 + 0.35 * Math.min(1, comet.length / 8));
    comet.at.copy(comet.from);

    // Bowed up and out, so it arcs over rather than ruling a line.
    _d.subVectors(comet.to, comet.from).normalize();
    comet.bow.copy(UP).addScaledVector(_d, -_d.y);
    if (comet.bow.lengthSq() < 1e-4) comet.bow.set(1, 0, 0);
    comet.bow.normalize();

    _p.set(comet.to.x - this.centre.x, 0, comet.to.z - this.centre.z);
    const flat = _p.length();
    comet.dirX = flat > 1e-3 ? _p.x / flat : this.direction.x;
    comet.dirZ = flat > 1e-3 ? _p.z / flat : this.direction.z;

    const k = big ? 1.3 : 1;
    this._beam(comet.from, comet.to, {
      width: c.beamWidth * k,
      jag: 0.008,
      arch: c.cometArc,
      forks: 0,
      life: comet.flight * 2.4 + 0.15,
      leader: comet.flight,
      restrikes: 0,
      intensity: c.beamIntensity * k
    }, comet.bow);

    // A glint where it tears free.
    _emit.position.copy(comet.from);
    _emit.direction.set(0, 1, 0);
    _emit.radius = 0;
    _emit.speed = 0;
    _emit.spread = 0;
    _emit.size = c.planetSize * 2.2;
    _emit.sizeVariance = 0.1;
    _emit.life = 0.18;
    _emit.lifeVariance = 0.1;
    _emit.spin = 3;
    _emit.anchor = null;
    _emit.time = frame.uTime.value;
    this.flashes.emit(1, _emit);
    this.pulse = Math.max(this.pulse, 0.5);
  }

  /** Lights in flight: along their arc, a trail behind them, and the landing. */
  _comets(dt, c) {
    const g = settings.global;
    const time = frame.uTime.value;
    for (const comet of this.comets) {
      if (!comet.live) continue;
      _q.copy(comet.at);
      comet.age += dt;
      const u = saturate(comet.age / comet.flight);
      comet.at.lerpVectors(comet.from, comet.to, u).addScaledVector(comet.bow, Math.sin(u * Math.PI) * c.cometArc * comet.length);

      // A trail of soft light and a few sparks, laid along this frame's step.
      const n = Math.max(1, Math.round(c.trailDensity * comet.length * (dt / comet.flight) * g.particleCount));
      for (let i = 0; i < n; i++) {
        _emit.position.lerpVectors(_q, comet.at, (i + Math.random()) / n);
        _emit.direction.set(0, 1, 0);
        _emit.radius = 0.04;
        _emit.speed = 0.25;
        _emit.speedVariance = 0.5;
        _emit.spread = 1;
        _emit.size = c.cometSize * 0.45;
        _emit.sizeVariance = 0.4;
        _emit.life = 0.4;
        _emit.lifeVariance = 0.4;
        _emit.spin = 0;
        _emit.anchor = null;
        _emit.time = time;
        this.trail.emit(1, _emit);
      }

      if (u < 1) continue;
      comet.live = false;
      comet.mesh.visible = false;
      const dummy = comet.dummy;
      comet.dummy = null;
      this._impact(comet.to, c, dummy ? (comet.big ? 1.3 : 1) : 0.6);
      if (!dummy || !dummy.alive) continue;
      if (!dummy.kill(comet.dirX, comet.dirZ, c.hit)) continue;

      _p.set(dummy.position.x, 0, dummy.position.z);
      this.ctx.decals.spawn(DecalType.SCORCH, _p, {
        radius: 0.8,
        life: 3.0,
        intensity: 0.5,
        colorA: getColor(c.colorGlow)
      });
      this.ctx.bursts.spawn(BurstMode.STORM, comet.to, {
        radius: 0.2,
        endRadius: 1.4,
        life: 0.4,
        intensity: 1.3 * g.explosionIntensity,
        opacity: 0.7,
        colorA: getColor(c.colorSpark),
        colorB: getColor(c.colorGlow),
        colorC: getColor(c.colorLine)
      });
    }
  }

  /** Where a light lands: sparks, a flash, stars, a ring on the floor. */
  _impact(point, c, k) {
    const g = settings.global;
    const time = frame.uTime.value;

    _emit.position.copy(point);
    _emit.direction.set(0, 1, 0);
    _emit.radius = 0.1;
    _emit.speed = 6;
    _emit.speedVariance = 0.6;
    _emit.spread = 1;
    _emit.size = 0.05;
    _emit.sizeVariance = 0.5;
    _emit.life = 0.5;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.anchor = null;
    _emit.time = time;
    this.sparks.emit(Math.round(c.impactSparks * k * g.particleCount), _emit);

    _emit.speed = 0;
    _emit.spread = 0;
    _emit.radius = 0;
    _emit.size = 1.8 * k;
    _emit.life = 0.16;
    _emit.spin = 4;
    this.flashes.emit(1, _emit);

    _emit.radius = 0.4;
    _emit.speed = 1.4;
    _emit.spread = 1;
    _emit.size = c.starSize * 2;
    _emit.life = 0.7;
    _emit.lifeVariance = 0.5;
    _emit.spin = 3;
    this.stars.emit(Math.round(10 * k * g.particleCount), _emit);

    _p.set(point.x, 0, point.z);
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _p, {
      radius: 1.3 * k,
      life: 0.5,
      intensity: 0.9,
      width: 0.06,
      colorA: getColor(c.colorLine),
      colorB: getColor(c.colorSpark)
    });

    this.hitLightAt.copy(point);
    this.hitLightPower = Math.max(this.hitLightPower, c.strikeLight * k * g.explosionIntensity);
    this.ctx.shake.add(c.strikeShake * k * g.explosionIntensity * g.cameraShake, 4.5, 26);
    if (c.strikeFlash > 0) this.ctx.flash.trigger(getColor(c.colorGlow), c.strikeFlash * k * g.explosionIntensity);
  }

  /** The star throws a light at everyone left, and the circle answers. */
  _finale(c) {
    if (this.finaleDone) return;
    this.finaleDone = true;
    const g = settings.global;
    const found = this.ctx.dummies?.findTargets?.(this.centre.x, this.centre.z, c.zoneRadius, this._targets) ?? this._targets;
    for (const dummy of found) {
      if (dummy.alive && !this._booked(dummy)) this._launch(this.corePos, dummy, null, c, true);
    }

    this.ctx.decals.spawn(DecalType.SHOCKWAVE, this.centre, {
      radius: c.zoneRadius * 1.1,
      life: 0.9,
      intensity: 1.2,
      width: 0.09,
      colorA: getColor(c.colorSigil),
      colorB: getColor(c.colorSpark)
    });

    const time = frame.uTime.value;
    _emit.position.copy(this.corePos);
    _emit.direction.set(0, 1, 0);
    _emit.radius = 0.3;
    _emit.speed = 7;
    _emit.speedVariance = 0.5;
    _emit.spread = 1;
    _emit.size = 0.05;
    _emit.sizeVariance = 0.5;
    _emit.life = 0.8;
    _emit.lifeVariance = 0.4;
    _emit.spin = 0;
    _emit.anchor = null;
    _emit.time = time;
    this.sparks.emit(Math.round(120 * g.particleCount), _emit);
    _emit.speed = 0;
    _emit.spread = 0;
    _emit.radius = 0;
    _emit.size = 5;
    _emit.life = 0.25;
    _emit.spin = 3;
    this.flashes.emit(1, _emit);

    this.pulse = 1;
    this.lightBoost = c.finaleLight * g.explosionIntensity;
    this.ctx.shake.add(c.finaleShake * g.explosionIntensity * g.cameraShake, 2.4, 22);
    if (c.finaleFlash > 0) this.ctx.flash.trigger(getColor(c.colorGlow), c.finaleFlash * g.explosionIntensity);
  }

  /* ---- beams ---- */

  /** A free beam — or, failing that, the one nearest its end — drawn. */
  _beam(from, to, opts, bow) {
    let pick = null;
    let oldest = -1;
    for (const beam of this.beams) {
      if (!beam.alive) {
        pick = beam;
        break;
      }
      const left = beam.age / Math.max(0.01, beam.opts.life);
      if (left > oldest) {
        oldest = left;
        pick = beam;
      }
    }
    pick.fire(from, to, opts, bow);
  }

  _beams(dt) {
    _eye.setFromMatrixPosition(this.ctx.camera.matrixWorld);
    for (const beam of this.beams) beam.update(dt, _eye);
  }

  /* ---- particles ---- */

  _emitters(dt, c, p) {
    const g = settings.global;
    const time = frame.uTime.value;

    /* motes spiralling into the book as it is conjured */
    const moteRate = this.act === TomeAct.CONJURE ? c.conjureMotes : this.act === TomeAct.GROW ? c.conjureMotes * 0.5 : 0;
    const motes = this._motes.tick(dt, moteRate * g.particleCount);
    for (let i = 0; i < motes; i++) {
      randomUnit(_d);
      const r = this.bookScale * (1.2 + Math.random() * 1.6);
      _emit.position.copy(this.bookPos).addScaledVector(_d, r);
      _emit.anchor = this.bookPos;
      _emit.direction.set(0, 1, 0);
      _emit.radius = 0;
      _emit.speed = 0;
      _emit.speedVariance = 0;
      _emit.spread = 0;
      _emit.size = c.moteSize;
      _emit.sizeVariance = 0.5;
      _emit.life = 0.7;
      _emit.lifeVariance = 0.3;
      _emit.spin = 0;
      _emit.time = time;
      this.motes.emit(1, _emit);
    }
    _emit.anchor = null;

    /* starlight shed behind it as it flies */
    const trailRate = this.act === TomeAct.FLIGHT ? c.flyTrail : 0;
    const trail = this._trail.tick(dt, trailRate * g.particleCount);
    for (let i = 0; i < trail; i++) {
      randomUnit(_d);
      _emit.position.copy(this.bookPos).addScaledVector(_d, this.bookScale * 0.4 * Math.random());
      _emit.direction.copy(_d);
      _emit.radius = 0;
      _emit.speed = 0.3;
      _emit.speedVariance = 0.5;
      _emit.spread = 1;
      _emit.size = i % 3 === 0 ? c.starSize * 1.6 : c.moteSize * 1.3;
      _emit.sizeVariance = 0.5;
      _emit.life = 0.6;
      _emit.lifeVariance = 0.4;
      _emit.spin = 2;
      _emit.time = time;
      if (i % 3 === 0) this.stars.emit(1, _emit);
      else this.trail.emit(1, _emit);
    }

    /* the field of stars about the orrery */
    const starRate = c.starRate * this.holo * (this.act === TomeAct.CLOSE ? 0.3 : 1);
    const stars = this._stars.tick(dt, starRate * g.particleCount);
    for (let i = 0; i < stars; i++) {
      randomUnit(_d);
      _d.y *= 0.75;
      const r = c.holoRadius * (0.25 + Math.random() * c.starReach);
      _emit.position.copy(this.corePos).addScaledVector(_d, r);
      _emit.direction.copy(_d);
      _emit.radius = 0;
      _emit.speed = 0.08;
      _emit.speedVariance = 0.6;
      _emit.spread = 1;
      _emit.size = c.starSize;
      _emit.sizeVariance = 0.6;
      _emit.life = 1.4;
      _emit.lifeVariance = 0.5;
      _emit.spin = 2;
      _emit.time = time;
      this.stars.emit(1, _emit);
    }

    /* motes climbing the fan out of the dial */
    const riseRate = c.fanMotes * this.fanRise * (this.act === TomeAct.CLOSE ? 0.3 : 1);
    const rise = this._rise.tick(dt, riseRate * g.particleCount);
    for (let i = 0; i < rise; i++) {
      const a = Math.random() * TAU;
      const r = Math.random() * 0.15 * this.bookScale;
      _emit.position.set(this.dialTop.x + Math.cos(a) * r, this.dialTop.y + 0.02, this.dialTop.z + Math.sin(a) * r);
      const out = c.fanRadius / Math.max(0.3, c.holoHeight);
      _emit.direction.set(Math.cos(a) * out * Math.random(), 1, Math.sin(a) * out * Math.random()).normalize();
      _emit.radius = 0;
      _emit.speed = c.holoHeight * 1.1;
      _emit.speedVariance = 0.4;
      _emit.spread = 0.05;
      _emit.size = c.moteSize * 0.8;
      _emit.sizeVariance = 0.5;
      _emit.life = 0.9;
      _emit.lifeVariance = 0.3;
      _emit.spin = 0;
      _emit.time = time;
      this.trail.emit(1, _emit);
    }

    /* unmaking: it sheds itself as rising sparks of light */
    if (this.act === TomeAct.CLOSE && this.materialise < 0.999 && this.materialise > 0.001) {
      const shed = this._shed.tick(dt, 160 * g.particleCount);
      for (let i = 0; i < shed; i++) {
        _d.set((Math.random() - 0.5) * 1.0, (Math.random() - 0.5) * 0.35, (Math.random() - 0.5) * 0.75);
        _emit.position.copy(this.bookPos).addScaledVector(_d, this.bookScale);
        _emit.direction.set(_d.x * 0.3, 1, _d.z * 0.3);
        _emit.radius = 0.02;
        _emit.speed = 1.4;
        _emit.speedVariance = 0.5;
        _emit.spread = 0.3;
        _emit.size = c.starSize * 1.3;
        _emit.sizeVariance = 0.5;
        _emit.life = 0.9;
        _emit.lifeVariance = 0.3;
        _emit.spin = 3;
        _emit.time = time;
        this.stars.emit(1, _emit);
      }
    }
  }

  /* ---- light ---- */

  _hitLightFrame(dt, c) {
    if (!this.hitLight) return;
    this.lightColor.copy(getColor(c.colorGlow));
    this.ctx.lights.set(this.hitLight, this.hitLightAt, this.lightColor, this.hitLightPower, c.strikeLightRadius, dt);
    this.hitLightPower = Math.max(0, this.hitLightPower - this.hitLightPower * 8 * dt - dt);
  }

  /** Starlight: a slow twinkle. */
  lightShimmer() {
    return 0.88 + 0.12 * Math.sin(this.age * 5.3) * Math.sin(this.age * 2.1 + 0.7);
  }

  /* ---- every uniform, every frame ---- */

  _dress(c) {
    const g = settings.global;
    const opacity = g.opacity;
    const camera = this.ctx.camera;
    const live = this.phase !== AbilityPhase.DONE;

    /* the book */
    {
      const u = this.bodyUniforms;
      u.uMaterialise.value = this.materialise;
      u.uEdgeWidth.value = Math.max(0.01, c.edgeWidth);
      u.uEdgeColor.value.copy(getColor(c.colorEdge));
      u.uEdgeGlow.value = c.edgeGlow * g.glow;
      u.uEmissiveBoost.value = 0.6 + c.glyphGlow * this.charge + this.pulse * c.glyphGlow * 0.5;
      u.uRimColor.value.copy(getColor(c.colorGlow));
      u.uRimStrength.value = c.rimStrength * g.fresnel * (0.4 + 0.6 * this.charge);
      this.book.visible = live && !!this.rig && this.materialise > 0.001;
    }

    /* the zodiac */
    {
      const u = this.sigilMaterial.uniforms;
      const quad = (c.zoneRadius + 1) * 2;
      u.uQuadSize.value = quad;
      u.uRadius.value = c.zoneRadius;
      u.uReveal.value = this.sigilReveal;
      u.uCharge.value = Math.min(1.5, this.charge * this.holo);
      u.uPulse.value = this.pulse;
      u.uSpin.value = c.sigilSpin;
      u.uIntensity.value = c.sigilIntensity * this.sigilFade * g.shaderIntensity;
      u.uOpacity.value = opacity;
      u.uColorA.value.copy(getColor(c.colorSigil));
      u.uColorB.value.copy(getColor(c.colorSpark));
      this.sigil.position.set(this.centre.x, 0.035, this.centre.z);
      this.sigil.scale.setScalar(quad);
      this.sigil.visible = live && this.sigilReveal > 0.001 && this.sigilFade > 0.001;
    }

    /* the fan */
    {
      const u = this.fanMaterial.uniforms;
      u.uIntensity.value = c.fanIntensity * Math.min(1, this.fanRise * 1.5) * g.shaderIntensity;
      u.uRise.value = Math.max(0.001, this.fanRise);
      u.uOpacity.value = opacity;
      u.uColor.value.copy(getColor(c.colorGlow));
      u.uColorCore.value.copy(getColor(c.colorSpark));
      const height = Math.max(0.05, this.corePos.y - this.dialTop.y);
      const r = c.fanRadius * Math.max(0.05, this.holo);
      this.fan.position.copy(this.dialTop);
      this.fan.scale.set(r, height, r);
      this.fan.visible = live && this.fanRise > 0.002;
    }

    /* the star */
    {
      const u = this.core.material.uniforms;
      u.uIntensity.value = c.coreIntensity * g.glow * (1 + this.pulse * 0.5);
      u.uRings.value = 3;
      u.uRingAmt.value = this.holo;
      u.uFlare.value = 0.8;
      u.uOpacity.value = opacity;
      u.uColorCore.value.copy(getColor(c.colorCore));
      u.uColorGlow.value.copy(getColor(c.colorGlow));
      const size = c.coreSize * Math.max(0, this.coreAppear) * (1 + this.pulse * 0.25);
      this.core.position.copy(this.corePos);
      this.core.quaternion.copy(camera.quaternion);
      this.core.scale.setScalar(Math.max(1e-3, size));
      this.core.visible = live && this.coreAppear > 0.01;
    }

    /* the orbits */
    const planets = this._planetCount();
    for (let i = 0; i < this.orbits.length; i++) {
      const orbit = this.orbits[i];
      const isCore = i >= PLANETS;
      const shown = isCore || i < planets;
      const R = isCore
        ? c.coreSize * (i === PLANETS ? 0.42 : 0.55) * this.coreAppear
        : c.holoRadius * ORBIT_RADIUS[i] * this.holo;
      const u = orbit.mesh.material.uniforms;
      u.uIntensity.value = c.orbitIntensity * (isCore ? 1.2 : 1) * g.shaderIntensity;
      u.uWidth.value = Math.max(0.002, c.orbitWidth / Math.max(0.05, R));
      u.uReveal.value = orbit.reveal;
      u.uSpeed.value = isCore ? 0.9 : 0.25 + 0.06 * i;
      u.uOpacity.value = opacity;
      u.uColorLine.value.copy(getColor(c.colorLine));
      u.uColorSpark.value.copy(getColor(c.colorSpark));
      orbit.mesh.position.copy(this.corePos);
      orbit.mesh.quaternion.copy(orbit.tilt);
      orbit.mesh.scale.setScalar(Math.max(1e-3, R));
      orbit.mesh.visible = live && shown && R > 0.01 && orbit.reveal > 0.001;
    }

    /* the planets */
    for (let i = 0; i < PLANETS; i++) {
      const planet = this.planets[i];
      const shown = i < planets;
      // A planet appears once its orbit is drawn as far as it, near enough.
      const here = saturate(this.orbits[i].reveal * 1.4 - 0.4) * this.holo;
      const gathered = Easing.outBack(saturate(planet.charge));
      const size = c.planetSize * here * gathered * (0.85 + 0.15 * Math.sin(this.age * 3 + i));
      const u = planet.mesh.material.uniforms;
      u.uIntensity.value = c.planetIntensity * g.glow;
      u.uRings.value = 1;
      u.uRingAmt.value = 1;
      u.uFlare.value = 0.4;
      u.uOpacity.value = opacity;
      u.uColorCore.value.copy(getColor(c.colorCore));
      u.uColorGlow.value.copy(getColor(c.colorGlow));
      planet.mesh.position.copy(planet.position);
      planet.mesh.quaternion.copy(camera.quaternion);
      planet.mesh.scale.setScalar(Math.max(1e-3, size));
      planet.mesh.visible = live && shown && size > 0.01;
    }

    /* the lights in flight */
    for (const comet of this.comets) {
      if (!comet.live) {
        comet.mesh.visible = false;
        continue;
      }
      const u = comet.mesh.material.uniforms;
      u.uIntensity.value = c.cometIntensity * g.glow;
      u.uRings.value = 0;
      u.uRingAmt.value = 0;
      u.uFlare.value = 1.2;
      u.uOpacity.value = opacity;
      u.uColorCore.value.copy(getColor(c.colorCore));
      u.uColorGlow.value.copy(getColor(c.colorGlow));
      comet.mesh.position.copy(comet.at);
      comet.mesh.quaternion.copy(camera.quaternion);
      comet.mesh.scale.setScalar(c.cometSize * (comet.big ? 1.3 : 1));
      comet.mesh.visible = live;
    }

    /* the beams */
    for (const beam of this.beams) {
      if (!beam.alive) continue;
      const u = beam.material.uniforms;
      u.uCoreWidth.value = 0.22;
      u.uOpacity.value = opacity;
      u.uColorCore.value.copy(getColor(c.colorCore));
      u.uColorBolt.value.copy(getColor(c.colorLine));
      u.uColorGlow.value.copy(getColor(c.colorGlow));
    }

    /* the particle systems — shared, so re-dressed every frame */
    {
      const u = this.motes.uniforms;
      this.motes.setGradient(getColor(c.colorSpark), getColor(c.colorLine), getColor(c.colorGlow), getColor(c.colorGlow));
      u.uGravity.value.set(0, 0, 0);
      u.uDrag.value = 1;
      u.uTurbulence.value = 0.05;
      u.uSwirl.value = c.moteSwirl;
      u.uSwirlExpand.value = -0.97;
      u.uEndSize.value = 0.3;
      u.uSizeIn.value = 0.15;
      u.uFadeIn.value = 0.2;
      u.uFadeOut.value = 0.2;
      u.uGlow.value = 2.2 * g.glow;
      u.uOpacity.value = opacity;
    }
    {
      const u = this.stars.uniforms;
      this.stars.setGradient(getColor('#ffffff'), getColor(c.colorStar), getColor(c.colorLine), getColor(c.colorGlow));
      u.uGravity.value.set(0, 0, 0);
      u.uDrag.value = 1.5;
      u.uTurbulence.value = 0.1;
      u.uEndSize.value = 0.3;
      u.uSizeIn.value = 0.2;
      u.uFadeIn.value = 0.25;
      u.uFadeOut.value = 0.45;
      u.uGlow.value = 2.6 * g.glow;
      u.uOpacity.value = opacity;
    }
    {
      const u = this.sparks.uniforms;
      this.sparks.setGradient(getColor('#ffffff'), getColor(c.colorSpark), getColor(c.colorLine), getColor(c.colorGlow));
      u.uGravity.value.set(0, -9, 0);
      u.uDrag.value = 1.6;
      u.uTurbulence.value = 0.1;
      u.uStretch.value = 0.08;
      u.uEndSize.value = 0.3;
      u.uSizeIn.value = 0.01;
      u.uFadeIn.value = 0;
      u.uFadeOut.value = 0.5;
      u.uGlow.value = 2.2 * g.glow;
      u.uOpacity.value = opacity;
    }
    {
      const u = this.flashes.uniforms;
      this.flashes.setGradient(getColor('#ffffff'), getColor(c.colorSpark), getColor(c.colorGlow), getColor(c.colorGlow));
      u.uGravity.value.set(0, 0, 0);
      u.uDrag.value = 1;
      u.uTurbulence.value = 0;
      u.uEndSize.value = 1.5;
      u.uSizeIn.value = 0.001;
      u.uFadeIn.value = 0;
      u.uFadeOut.value = 0.35;
      u.uGlow.value = 2.4 * g.glow;
      u.uOpacity.value = opacity;
    }
    {
      const u = this.trail.uniforms;
      this.trail.setGradient(getColor(c.colorSpark), getColor(c.colorLine), getColor(c.colorGlow), getColor(c.colorDeep));
      u.uGravity.value.set(0, 0, 0);
      u.uDrag.value = 2;
      u.uTurbulence.value = 0.15;
      u.uEndSize.value = 0.2;
      u.uSizeIn.value = 0.05;
      u.uFadeIn.value = 0.05;
      u.uFadeOut.value = 0.6;
      u.uGlow.value = 2.0 * g.glow;
      u.uOpacity.value = opacity;
    }
  }

  dispose() {
    super.dispose();
    for (const material of this.bodyMaterials) material.dispose();
    this.sigilMaterial.dispose();
    this.fanMaterial.dispose();
    this.core.material.dispose();
    for (const planet of this.planets) planet.mesh.material.dispose();
    for (const orbit of this.orbits) orbit.mesh.material.dispose();
    for (const comet of this.comets) comet.mesh.material.dispose();
    for (const beam of this.beams) beam.dispose();
  }
}
