import {
  BufferAttribute,
  CylinderGeometry,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  PlaneGeometry,
  Sphere,
  Vector3
} from 'three';
import { Ability } from './Ability.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { DecalType } from '../effects/GroundDecals.js';
import { LightningBolt } from '../effects/LightningBolt.js';
import { createBoltMaterial } from '../materials/GyroscopeMaterials.js';
import {
  createBeamMaterial,
  createFlareMaterial,
  createRibbonMaterial,
  createSigilMaterial
} from '../materials/LanceMaterials.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { Easing, clamp, saturate, smoothstep } from '../utils/math.js';

const TAU = Math.PI * 2;
/** Streamers one cast can wind round its beam. */
const MAX_RIBBONS = 12;
/** Points along each streamer. */
const RIBBON_SEGMENTS = 160;
/** Arcs crawling over the beam at once. */
const ARCS = 5;

const UP = new Vector3(0, 1, 0);
const AXIS_Y = new Vector3(0, 1, 0);
const AXIS_Z = new Vector3(0, 0, 1);
const _a = new Vector3();
const _b = new Vector3();
const _d = new Vector3();
const _p = new Vector3();
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

/** One streamer per row: phase, radius, twist, width, hue, speed. */
function buildRibbonGeometry() {
  const geometry = new InstancedBufferGeometry();
  const verts = (RIBBON_SEGMENTS + 1) * 2;
  const position = new Float32Array(verts * 3);
  for (let i = 0; i <= RIBBON_SEGMENTS; i++) {
    const t = i / RIBBON_SEGMENTS;
    position.set([t, -1, 0, t, 1, 0], i * 6);
  }
  const index = [];
  for (let i = 0; i < RIBBON_SEGMENTS; i++) {
    const a = i * 2;
    index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  geometry.setAttribute('position', new BufferAttribute(position, 3));
  geometry.setIndex(index);
  for (const name of ['aPhase', 'aRadius', 'aTwist', 'aWidth', 'aHue', 'aSpeed']) {
    geometry.setAttribute(name, new InstancedBufferAttribute(new Float32Array(MAX_RIBBONS), 1));
  }
  geometry.instanceCount = 0;
  geometry.boundingSphere = new Sphere(new Vector3(), 1e4);
  return geometry;
}

/**
 * STARBREAKER LANCE — a targeted shot: one body, one beam.
 *
 * The circle locks onto whoever is under the cursor. Then:
 *
 *   1. **The charge.** A magic circle writes itself under the caster and a
 *      smaller one stands up in front of the hands; light is drawn in out of
 *      the air into a star between the palms, and streamers start to wind
 *      round the caster.
 *   2. **The shot.** The beam leaves the hands — a white core, a cyan sheath
 *      full of striations racing downrange, a violet glow round both — and
 *      the streamers are drawn out with it, twisting round the shot.
 *   3. **The blast.** Where it lands, a star goes off: a storm burst, a ring,
 *      a fountain of sparks in three colours, embers thrown out and falling.
 *      The body is blown off its feet and the beam stays on it, driving it
 *      along the line while arcs crawl over the beam.
 *   4. **The collapse.** The beam lets go of the caster and is pulled into the
 *      mark from behind; the body under it burns away to light; a last pop.
 *
 * Like every ability here it captures nothing at the cast but a few random
 * numbers and re-solves the rest off `settings.lance` every frame — including
 * where the beam starts, which is the caster's hands as they move through the
 * cast clip.
 */
export class LanceAbility extends Ability {
  constructor(context) {
    super('lance', context);
  }

  /** It picks one body and decides for itself when that body is hit. */
  get handlesOwnHits() {
    return true;
  }

  get cameraWeight() {
    return this.landed ? 0.5 : saturate(1 - this.u * 0.5);
  }

  get impactDuration() {
    const c = settings.lance;
    return Math.max(0.1, c.beamTime + c.collapseTime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.lance.fadeTime);
  }

  /* ------------------------------------------------------------------ */
  /* construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /* ---- the beam: three nested open cylinders on +Y, 0..1 ---- */
    const tube = new CylinderGeometry(1, 1, 1, 28, 72, true);
    tube.translate(0, 0.5, 0);
    this.beamLayers = [
      { key: 'glow', material: createBeamMaterial({ power: 1.8, streaks: 0.2 }), order: 12 },
      { key: 'sheath', material: createBeamMaterial({ power: 2.2, streaks: 0.55 }), order: 13 },
      { key: 'core', material: createBeamMaterial({ power: 2.6, streaks: 0.15 }), order: 14 }
    ].map((layer) => {
      const mesh = new Mesh(tube, layer.material);
      mesh.name = `LanceBeam:${layer.key}`;
      mesh.layers.set(LAYER.VFX);
      mesh.renderOrder = layer.order;
      mesh.frustumCulled = false;
      mesh.visible = false;
      this.group.add(mesh);
      return { ...layer, mesh };
    });

    /* ---- the streamers ---- */
    this.ribbonMaterial = createRibbonMaterial();
    this.ribbons = new Mesh(buildRibbonGeometry(), this.ribbonMaterial);
    this.ribbons.name = 'LanceRibbons';
    this.ribbons.layers.set(LAYER.VFX);
    this.ribbons.renderOrder = 15;
    this.ribbons.frustumCulled = false;
    this.ribbons.visible = false;
    this.group.add(this.ribbons);

    /* ---- the two stars: at the hands, and where it lands ---- */
    const quad = new PlaneGeometry(2, 2);
    const flare = (name) => {
      const mesh = new Mesh(quad, createFlareMaterial());
      mesh.name = name;
      mesh.layers.set(LAYER.VFX);
      mesh.renderOrder = 17;
      mesh.frustumCulled = false;
      mesh.visible = false;
      this.group.add(mesh);
      return mesh;
    };
    this.handFlare = flare('LanceHandFlare');
    this.novaFlare = flare('LanceNova');

    /* ---- the two circles: on the floor, and before the hands ---- */
    const flat = new PlaneGeometry(2, 2);
    flat.rotateX(-Math.PI / 2);
    this.groundSigil = new Mesh(flat, createSigilMaterial());
    this.groundSigil.name = 'LanceSigil';
    this.groundSigil.layers.set(LAYER.VFX);
    this.groundSigil.renderOrder = 5;
    this.groundSigil.frustumCulled = false;
    this.groundSigil.visible = false;
    this.group.add(this.groundSigil);

    this.handSigil = new Mesh(quad, createSigilMaterial());
    this.handSigil.name = 'LanceHandSigil';
    this.handSigil.layers.set(LAYER.VFX);
    this.handSigil.renderOrder = 16;
    this.handSigil.frustumCulled = false;
    this.handSigil.visible = false;
    this.group.add(this.handSigil);

    /* ---- arcs crawling over the beam ---- */
    this.arcs = Array.from({ length: ARCS }, () => {
      const bolt = new LightningBolt(createBoltMaterial());
      this.group.add(bolt.mesh);
      return bolt;
    });
    this._arcNext = 0;

    /* ---- state ---- */
    this.target = new Vector3();
    this.start = new Vector3();
    this.end = new Vector3();
    this.beamDir = new Vector3(0, 0, 1);
    this.beamRight = new Vector3(1, 0, 0);
    this.beamUp = new Vector3(0, 1, 0);
    this.beamLength = 1;
    this.victim = null;
    this.taken = false;
    this.fired = false;
    this.landed = false;
    this.finaled = false;
    this.handLight = null;
    this._targets = [];
    this._resetLook();

    this._gather = new RateEmitter(120);
    this._spray = new RateEmitter(300);
    this._embers = new RateEmitter(100);
    this._trail = new RateEmitter(120);
    this._burn = new RateEmitter(80);
    this._arcRate = new RateEmitter(20);
  }

  createParticles() {
    const P = this.ctx.particles;
    this.sparks = P.get('lanceSpark', {
      capacity: 2600,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.1
    });
    this.embers = P.get('lanceEmber', {
      capacity: 1400,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.1
    });
    this.gather = P.get('lanceGather', {
      capacity: 900,
      shape: ParticleShape.SOFT,
      additive: true,
      softFade: 0.2
    });
    this.motes = P.get('lanceMote', {
      capacity: 1200,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.2
    });
    this.glints = P.get('lanceGlint', { capacity: 120, shape: ParticleShape.GLINT, additive: true });
    this.rings = P.get('lanceRing', { capacity: 40, shape: ParticleShape.RING, additive: true });
  }

  _resetLook() {
    this.head = 0;
    this.tail = 0;
    this.width = 0;
    this.spread = 0;
    this.handK = 0;
    this.novaK = 0;
    this.novaRing = 0;
    this.sigilDraw = 0;
    this.sigilFade = 1;
    this.sigilFlare = 0;
    this.flash = 0;
  }

  /* ------------------------------------------------------------------ */
  /* lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    const c = this.config;
    this.victim = null;
    this.taken = false;
    this.fired = false;
    this.landed = false;
    this.finaled = false;
    this._resetLook();

    this.pointAt(1, this.target);
    const found = this.ctx.dummies?.findTargets?.(
      this.target.x,
      this.target.z,
      Math.max(0.6, c.snapRadius * 0.6),
      this._targets
    );
    if (found?.length) {
      this.victim = found[0];
      this.target.set(this.victim.position.x, 0, this.victim.position.z);
    }

    // Deal the streamers out: half winding one way, half the other, so they
    // cross over each other down the length of the shot.
    const geo = this.ribbons.geometry;
    const attr = geo.attributes;
    for (let i = 0; i < MAX_RIBBONS; i++) {
      const sign = i & 1 ? -1 : 1;
      attr.aPhase.array[i] = (i / MAX_RIBBONS) * TAU + Math.random() * 0.8;
      attr.aRadius.array[i] = 1 + (Math.random() * 2 - 1) * c.ribbonRadiusVariance;
      attr.aTwist.array[i] = sign * (0.7 + Math.random() * 0.6);
      attr.aWidth.array[i] = 0.6 + Math.random() * 0.8;
      attr.aHue.array[i] = Math.random();
      attr.aSpeed.array[i] = sign * (0.7 + Math.random() * 0.6);
    }
    for (const name of ['aPhase', 'aRadius', 'aTwist', 'aWidth', 'aHue', 'aSpeed']) attr[name].needsUpdate = true;

    for (const layer of this.beamLayers) layer.material.uniforms.uSeed.value = Math.random() * 10;
    for (const bolt of this.arcs) bolt.kill();
    for (const emitter of [this._gather, this._spray, this._embers, this._trail, this._burn, this._arcRate]) {
      emitter.reset();
    }

    this.handLight = this.ctx.lights.acquire();
    this._solveBeam(c);
    this.position.copy(this.start);
  }

  onDestroy() {
    this.victim = null;
    this.taken = false;
    this.ctx.lights.release(this.handLight);
    this.handLight = null;
    for (const layer of this.beamLayers) layer.mesh.visible = false;
    for (const bolt of this.arcs) bolt.kill();
    this.ribbons.visible = false;
    this.handFlare.visible = false;
    this.novaFlare.visible = false;
    this.groundSigil.visible = false;
    this.handSigil.visible = false;
  }

  /* ------------------------------------------------------------------ */
  /* the line                                                            */
  /* ------------------------------------------------------------------ */

  /** Where the beam leaves and where it lands, now. Pure — called every frame. */
  _solveBeam(c) {
    // From the hands, as far as the rig will say where they are; blended with a
    // fixed point before the chest so a clip that swings them wide does not
    // drag the beam round with it.
    this.start.copy(this.origin).addScaledVector(this.direction, c.handForward).setY(c.handHeight);
    const hands = this.ctx.character?.handsPoint?.(_p);
    if (hands) this.start.lerp(hands, clamp(c.handFollow, 0, 1));
    this.start.addScaledVector(this.direction, c.muzzle);

    const victim = this.victim;
    if (victim && victim.state !== 'gone' && victim.state !== 'frozen') {
      if (this.taken && victim.bodyPoint(_p)) {
        this.end.copy(_p);
        this.end.y = Math.max(0.3, this.end.y);
      } else if (victim.alive) {
        this.end.set(victim.position.x, c.aimHeight, victim.position.z);
      }
      // Otherwise it stays where it last was.
    } else if (!this.taken) {
      this.end.set(this.target.x, c.aimHeight, this.target.z);
    }

    this.beamDir.subVectors(this.end, this.start);
    this.beamLength = Math.max(0.5, this.beamDir.length());
    this.beamDir.multiplyScalar(1 / this.beamLength);
    this.beamRight.crossVectors(this.beamDir, UP);
    if (this.beamRight.lengthSq() < 1e-6) this.beamRight.set(1, 0, 0);
    this.beamRight.normalize();
    this.beamUp.crossVectors(this.beamRight, this.beamDir).normalize();
  }

  /** The charge holds the front at the hands; then it races down the line. */
  advance(dt) {
    const c = this.config;
    this._solveBeam(c);
    if (this.age < c.chargeTime) {
      this.position.copy(this.start);
      return false;
    }
    if (!this.fired) this._fire(c);

    const previousU = this.u;
    this.front += c.speed * settings.global.speed * dt;
    this.u = saturate(this.front / this.beamLength);
    this.position.copy(this.start).addScaledVector(this.beamDir, this.u * this.beamLength);
    return this.u >= 1 && previousU < 1;
  }

  /* ------------------------------------------------------------------ */
  /* 1 · the charge, 2 · the shot                                        */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    const c = this.config;
    const g = settings.global;
    const time = frame.uTime.value;
    const k = saturate(this.age / Math.max(0.01, c.chargeTime));

    this.sigilDraw = Easing.outCubic(saturate(this.age / Math.max(0.05, c.chargeTime * 1.1)));
    this.sigilFlare = Math.max(0, this.sigilFlare - dt * 3);
    this.spread = Easing.outCubic(k);
    this.flash = Math.max(0, this.flash - dt * 4);

    if (!this.fired) {
      // Light drawn in out of the air to the hands.
      this.handK = 0.25 + 0.75 * Easing.inQuad(k);
      const n = this._gather.tick(dt, c.gatherRate * g.particleCount);
      for (let i = 0; i < n; i++) {
        _d.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
        const r = 1.0 + Math.random() * 1.2;
        const life = 0.25 + Math.random() * 0.15;
        _emit.position.copy(this.start).addScaledVector(_d, r);
        _emit.direction.copy(_d).negate();
        _emit.radius = 0;
        _emit.speed = r / life;
        _emit.speedVariance = 0.05;
        _emit.spread = 0;
        _emit.size = 0.05;
        _emit.sizeVariance = 0.5;
        _emit.life = life;
        _emit.lifeVariance = 0.05;
        _emit.spin = 0;
        _emit.tint = i % 3 === 0 ? getColor(c.colorRibbonA) : null;
        _emit.time = time;
        this.gather.emit(1, _emit);
      }
    } else {
      // The shot is out: its head, racing.
      this.head = this.u;
      this.width = 0.75 + 0.25 * Easing.outCubic(saturate((this.age - c.chargeTime) / 0.1));
      this.handK = 1.1;
      this._trailMotes(dt, c, 0.5);
    }

    this._render(dt, c);
  }

  /** The beam leaves the hands. */
  _fire(c) {
    const g = settings.global;
    const time = frame.uTime.value;
    this.fired = true;
    this.sigilFlare = 1;
    this.flash = 1;

    _emit.position.copy(this.start);
    _emit.direction.copy(this.direction);
    _emit.radius = 0.1;
    _emit.speed = 9;
    _emit.speedVariance = 0.5;
    _emit.spread = 0.7;
    _emit.size = 0.035;
    _emit.sizeVariance = 0.5;
    _emit.life = 0.45;
    _emit.lifeVariance = 0.4;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.sparks.emit(Math.round(60 * g.particleCount), _emit);
    _emit.speed = 0;
    _emit.spread = 0;
    _emit.size = 1.2 * c.handSize;
    _emit.life = 0.16;
    _emit.spin = 2;
    this.glints.emit(1, _emit);

    _p.copy(this.origin).setY(0);
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _p, {
      radius: c.sigilRadius + 1.5,
      life: 0.5,
      intensity: 0.6,
      width: 0.05,
      colorA: getColor(c.colorBeam),
      colorB: getColor(c.colorGlow)
    });

    this.lightBoost = Math.max(this.lightBoost, c.fireLight * g.explosionIntensity);
    this.ctx.shake.add(c.fireShake * g.explosionIntensity * g.cameraShake, 4, 28);
  }

  /* ------------------------------------------------------------------ */
  /* 3 · the blast                                                       */
  /* ------------------------------------------------------------------ */

  onImpact() {
    const c = this.config;
    const g = settings.global;
    const time = frame.uTime.value;
    this.landed = true;
    this.head = 1;
    this.flash = 1.4;
    this.novaRing = 0.001;

    /* ---- the body ---- */
    const victim = this.victim;
    if (victim?.alive) {
      _d.copy(this.beamDir).setY(0);
      if (_d.lengthSq() < 1e-6) _d.copy(this.direction);
      _d.normalize();
      victim.kill(_d.x, _d.z, c.hit);
      this.taken = true;
    } else if (victim?.state === 'dead') {
      this.taken = true;
    } else {
      this.victim = null;
    }

    const P = this.end;
    const back = _a.copy(this.beamDir).negate();

    // A fountain of sparks in three colours, thrown out all round and back up
    // the beam.
    const tints = [getColor(c.colorSparkA), getColor(c.colorSparkB), getColor(c.colorSparkC)];
    const per = Math.round((c.impactSparks * g.particleCount) / 3);
    for (let i = 0; i < 3; i++) {
      _emit.position.copy(P);
      _emit.direction.copy(back).multiplyScalar(0.4);
      _emit.radius = 0.25;
      _emit.speed = 18;
      _emit.speedVariance = 0.6;
      _emit.spread = 1;
      _emit.size = 0.06;
      _emit.sizeVariance = 0.6;
      _emit.life = 0.8;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = tints[i];
      _emit.time = time;
      this.sparks.emit(per, _emit);
    }
    _emit.tint = null;
    _emit.direction.copy(UP);
    _emit.speed = 8;
    _emit.spread = 1;
    _emit.size = 0.06;
    _emit.life = 1.6;
    this.embers.emit(Math.round(c.impactEmbers * g.particleCount), _emit);

    _emit.speed = 0;
    _emit.spread = 0;
    _emit.radius = 0;
    _emit.size = 2.2;
    _emit.sizeVariance = 0.1;
    _emit.life = 0.2;
    _emit.lifeVariance = 0.1;
    _emit.spin = 2;
    this.glints.emit(1, _emit);

    _p.set(P.x, 0, P.z);
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _p, {
      radius: c.burstSize * 2.2,
      life: 0.7,
      intensity: 0.8,
      width: 0.05,
      colorA: getColor(c.colorBeam),
      colorB: getColor(c.colorGlow)
    });
    this.ctx.decals.spawn(DecalType.SCORCH, _p, {
      radius: 1.4,
      life: c.beamTime + c.collapseTime + c.fadeTime + 2,
      intensity: 0.35,
      colorA: getColor(c.colorSheath),
      colorB: getColor(c.colorGlow)
    });

    this.lightBoost = Math.max(this.lightBoost, c.impactLight * g.explosionIntensity);
    this.ctx.shake.add(c.impactShake * g.explosionIntensity * g.cameraShake, 2.8, 22);
    if (c.impactFlash > 0) this.ctx.flash.trigger(getColor(c.colorBeam), c.impactFlash * g.explosionIntensity);
  }

  /* ------------------------------------------------------------------ */
  /* the beam held, 4 · the collapse, and the fade                       */
  /* ------------------------------------------------------------------ */

  /** @param {number} t 0..1 the beam held and collapsing, 1..2 the fade */
  onFade(dt, t) {
    const c = this.config;
    const g = settings.global;
    const held = c.beamTime;
    const total = c.beamTime + c.collapseTime;
    const since = t <= 1 ? this.impactTime : total + this.fadeTime;

    // Somebody stood it back up (T), or something else took it.
    const victim = this.victim;
    if (victim && (victim.state === 'gone' || victim.state === 'frozen' || (this.taken && victim.alive))) {
      this.victim = null;
      this.taken = false;
    }

    this._solveBeam(c);
    this.flash = Math.max(0, this.flash - dt * 3);
    this.sigilFlare = Math.max(0, this.sigilFlare - dt * 3);

    /* ---- the body under the beam ---- */
    if (this.victim && this.taken && since < total) {
      this.victim.hold();
      const drive = since < held ? 1 : 1 - (since - held) / Math.max(0.01, c.collapseTime);
      this.victim.shove(this.beamDir.x * c.push * drive * dt, c.pushLift * drive * dt, this.beamDir.z * c.push * drive * dt);
      if (c.disintegrate) {
        this.victim.corrode(saturate(since / Math.max(0.05, held * 0.5)), c.burn);
        this.victim.consume(smoothstep(held * c.burnStart, total, since));
        this._burnSparks(dt, c);
      }
    }

    if (since < held) {
      /* ---- held: full, pulsing, spraying ---- */
      const pop = 1 + 0.2 * Math.exp(-since * 9);
      const pulse = 1 + c.pulse * Math.sin(this.age * c.pulseSpeed) * Math.sin(this.age * c.pulseSpeed * 0.37 + 1);
      this.head = 1;
      this.tail = 0;
      this.width = pop * pulse;
      this.spread = 1;
      this.handK = 1 + 0.15 * Math.sin(this.age * 31);
      this.novaK = Easing.outBack(saturate(since / 0.18)) * pulse;
      this._spraySparks(dt, c, 1);
      this._trailMotes(dt, c, 1);
      this._crawl(dt, c);
      this.ctx.shake.rumble(c.beamRumble * g.cameraShake, dt);
    } else if (since < total) {
      /* ---- the collapse: pulled into the mark from behind ---- */
      const k = saturate((since - held) / Math.max(0.01, c.collapseTime));
      this.head = 1;
      this.tail = Easing.inCubic(k);
      this.width = 1 - 0.65 * Easing.inQuad(k);
      this.spread = 1 - k * 0.5;
      this.handK = Math.max(0, 1 - k * 3);
      this.novaK = 1 + 0.3 * k;
      this._spraySparks(dt, c, 1 - k);
      this._crawl(dt, c);
    } else {
      /* ---- the fade ---- */
      if (!this.finaled) this._finale(c);
      const f = saturate(this.fadeTime / Math.max(0.05, c.fadeTime));
      this.head = 0;
      this.tail = 1;
      this.width = 0;
      this.spread = 0;
      this.handK = 0;
      this.novaK = Math.max(0, 1.3 * (1 - Easing.outCubic(saturate(f * 3))));
      this.sigilFade = 1 - f;
    }

    // The ring the blast throws out, crossing the star's quad once.
    if (this.novaRing > 0 && this.novaRing < 1) this.novaRing = Math.min(1, this.novaRing + dt * 2.2);

    this.sigilDraw = 1;
    if (since < total) this.sigilFade = 1 - 0.4 * smoothstep(held, total, since);
    this.position.copy(this.end);
    this._render(dt, c);
  }

  /** The last of the beam is swallowed: one more pop. */
  _finale(c) {
    const g = settings.global;
    this.finaled = true;
    this.novaRing = 0.001;
    _emit.position.copy(this.end);
    _emit.direction.copy(UP);
    _emit.radius = 0.2;
    _emit.speed = 10;
    _emit.speedVariance = 0.6;
    _emit.spread = 1;
    _emit.size = 0.045;
    _emit.sizeVariance = 0.6;
    _emit.life = 0.6;
    _emit.lifeVariance = 0.4;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.sparks.emit(Math.round(c.impactSparks * 0.35 * g.particleCount), _emit);
    _emit.speed = 0;
    _emit.spread = 0;
    _emit.size = 1.6;
    _emit.life = 0.18;
    _emit.spin = 2;
    this.glints.emit(1, _emit);
    this.lightBoost = Math.max(this.lightBoost, c.impactLight * 0.5 * g.explosionIntensity);
    this.ctx.shake.add(c.impactShake * 0.4 * g.explosionIntensity * g.cameraShake, 3, 24);
  }

  /* ---- the particles that run while the beam is on ---- */

  /** Sparks sprayed off the mark: back up the beam, and out round it. */
  _spraySparks(dt, c, amount) {
    const g = settings.global;
    const time = frame.uTime.value;
    const n = this._spray.tick(dt, c.sprayRate * amount * g.particleCount);
    const tints = [getColor(c.colorSparkA), getColor(c.colorSparkB), getColor(c.colorSparkC)];
    for (let i = 0; i < n; i++) {
      _emit.position.copy(this.end);
      _emit.direction.copy(this.beamDir).multiplyScalar(-0.6);
      _emit.radius = 0.3;
      _emit.speed = 13;
      _emit.speedVariance = 0.6;
      _emit.spread = 1;
      _emit.size = 0.05;
      _emit.sizeVariance = 0.6;
      _emit.life = 0.55;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = tints[i % 3];
      _emit.time = time;
      this.sparks.emit(1, _emit);
    }
    const e = this._embers.tick(dt, c.emberRate * amount * g.particleCount);
    for (let i = 0; i < e; i++) {
      _emit.position.copy(this.end);
      _emit.direction.copy(UP);
      _emit.radius = 0.4;
      _emit.speed = 6;
      _emit.speedVariance = 0.5;
      _emit.spread = 1;
      _emit.size = 0.05;
      _emit.sizeVariance = 0.5;
      _emit.life = 1.3;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.embers.emit(1, _emit);
    }
  }

  /** Motes peeling off the beam and drifting away from it. */
  _trailMotes(dt, c, amount) {
    const g = settings.global;
    const time = frame.uTime.value;
    const reach = this.head * this.beamLength;
    const n = this._trail.tick(dt, c.trailRate * amount * g.particleCount);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      _d.copy(this.beamRight).multiplyScalar(Math.cos(a)).addScaledVector(this.beamUp, Math.sin(a));
      _emit.position.copy(this.start).addScaledVector(this.beamDir, Math.random() * reach).addScaledVector(_d, c.beamRadius * 0.8);
      _emit.direction.copy(_d).addScaledVector(this.beamDir, 0.8).normalize();
      _emit.radius = 0.05;
      _emit.speed = 1.6;
      _emit.speedVariance = 0.5;
      _emit.spread = 0.3;
      _emit.size = 0.04;
      _emit.sizeVariance = 0.6;
      _emit.life = 0.8;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0;
      _emit.tint = i % 2 ? getColor(c.colorRibbonA) : null;
      _emit.time = time;
      this.motes.emit(1, _emit);
    }
  }

  /** The body going to light. */
  _burnSparks(dt, c) {
    if (!this.victim?.bodyPoint(_b)) return;
    const g = settings.global;
    const n = this._burn.tick(dt, 35 * g.particleCount);
    for (let i = 0; i < n; i++) {
      _emit.position.copy(_b);
      _emit.direction.copy(UP);
      _emit.radius = 0.55;
      _emit.speed = 2.5;
      _emit.speedVariance = 0.5;
      _emit.spread = 0.5;
      _emit.size = 0.045;
      _emit.sizeVariance = 0.5;
      _emit.life = 0.9;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = frame.uTime.value;
      this.motes.emit(1, _emit);
    }
  }

  /** Arcs crawling over the outside of the beam. */
  _crawl(dt, c) {
    const n = this._arcRate.tick(dt, c.arcRate);
    for (let i = 0; i < n; i++) {
      const bolt = this.arcs[this._arcNext];
      this._arcNext = (this._arcNext + 1) % ARCS;
      const from = this.tail + Math.random() * (1 - this.tail) * 0.9;
      const s0 = from * this.beamLength;
      const s1 = Math.min(this.beamLength, s0 + 1 + Math.random() * 2.5);
      const r = c.beamRadius * this.width * 1.3;
      const a0 = Math.random() * TAU;
      const a1 = a0 + (Math.random() - 0.5) * 2.5;
      _a.copy(this.start).addScaledVector(this.beamDir, s0)
        .addScaledVector(this.beamRight, Math.cos(a0) * r).addScaledVector(this.beamUp, Math.sin(a0) * r);
      _b.copy(this.start).addScaledVector(this.beamDir, s1)
        .addScaledVector(this.beamRight, Math.cos(a1) * r).addScaledVector(this.beamUp, Math.sin(a1) * r);
      _d.copy(this.beamRight).multiplyScalar(Math.cos(a0)).addScaledVector(this.beamUp, Math.sin(a0));
      bolt.fire(_a, _b, {
        width: 0.035,
        jag: 0.22,
        arch: 0.12,
        forks: 1,
        life: 0.16,
        leader: 0.03,
        restrikes: 2,
        restrikeRate: 30,
        intensity: c.arcIntensity
      }, _d);
    }
  }

  /* ------------------------------------------------------------------ */
  /* drawing                                                             */
  /* ------------------------------------------------------------------ */

  /** Everything this cast draws, laid out from the state of the frame. */
  _render(dt, c) {
    const g = settings.global;

    /* ---- the beam ---- */
    const beamOn = this.fired && this.width > 0.001 && this.head > this.tail;
    const radii = { glow: c.glowRadius, sheath: c.beamRadius, core: c.coreRadius };
    const gains = { glow: c.glowIntensity, sheath: c.beamIntensity, core: c.coreIntensity };
    const colors = {
      glow: [c.colorSheath, c.colorGlow],
      sheath: [c.colorBeam, c.colorSheath],
      core: [c.colorCore, c.colorBeam]
    };
    for (const layer of this.beamLayers) {
      const mesh = layer.mesh;
      mesh.visible = beamOn;
      if (!beamOn) continue;
      mesh.position.copy(this.start);
      mesh.quaternion.setFromUnitVectors(AXIS_Y, this.beamDir);
      const u = layer.material.uniforms;
      u.uLength.value = this.beamLength;
      u.uRadius.value = radii[layer.key] * this.width;
      u.uStartScale.value = c.startTaper;
      u.uTaper.value = c.taperLength;
      u.uBulge.value = this.landed ? c.impactBulge : 0.2;
      u.uWobble.value = c.wobble * g.noiseStrength;
      u.uHead.value = this.head;
      u.uTail.value = this.tail;
      u.uIntensity.value = gains[layer.key] * (1 + this.flash * 0.25) * g.shaderIntensity;
      u.uStreakFreq.value = c.streakFrequency;
      u.uStreakSpeed.value = c.streakSpeed;
      u.uOpacity.value = g.opacity;
      u.uColorA.value.copy(getColor(colors[layer.key][0]));
      u.uColorB.value.copy(getColor(colors[layer.key][1]));
    }

    /* ---- the streamers ---- */
    const count = clamp(Math.round(c.ribbons), 0, MAX_RIBBONS);
    this.ribbons.visible = count > 0 && this.spread > 0.01 && this.tail < 0.999;
    if (this.ribbons.visible) {
      this.ribbons.geometry.instanceCount = count;
      const u = this.ribbonMaterial.uniforms;
      u.uStart.value.copy(this.start);
      u.uDir.value.copy(this.beamDir);
      u.uRight.value.copy(this.beamRight);
      u.uUp.value.copy(this.beamUp);
      u.uLength.value = this.beamLength;
      u.uBehind.value = c.ribbonBehind;
      u.uRadius.value = c.ribbonRadius * Math.max(0.3, this.width);
      u.uFlare.value = c.ribbonFlare;
      u.uFlareLength.value = c.ribbonFlareLength;
      u.uBulge.value = this.landed ? c.ribbonBulge : 0;
      u.uTwist.value = c.ribbonTwist;
      u.uSpin.value = c.ribbonSpin;
      u.uWidth.value = c.ribbonWidth;
      u.uSpread.value = this.spread;
      u.uHead.value = this.fired ? this.head : 0;
      u.uTail.value = this.tail;
      u.uIntensity.value = c.ribbonIntensity * g.shaderIntensity * (0.4 + 0.6 * this.spread);
      u.uOpacity.value = g.opacity;
      u.uColorA.value.copy(getColor(c.colorRibbonA));
      u.uColorB.value.copy(getColor(c.colorRibbonB));
      u.uColorC.value.copy(getColor(c.colorRibbonC));
    }

    /* ---- the star at the hands ---- */
    this.handFlare.visible = this.handK > 0.01;
    if (this.handFlare.visible) {
      this.handFlare.position.copy(this.start);
      this.handFlare.scale.setScalar(c.handSize * this.handK * (1 + this.flash * 0.15));
      const u = this.handFlare.material.uniforms;
      u.uIntensity.value = c.handIntensity * g.shaderIntensity;
      u.uCore.value = this.fired ? 0.75 : 0.35 + 0.4 * this.handK;
      u.uRays.value = this.fired ? 1.2 : 0.6;
      u.uRing.value = 0;
      u.uColorCore.value.copy(getColor(c.colorCore));
      u.uColorGlow.value.copy(getColor(c.colorBeam));
      u.uColorRing.value.copy(getColor(c.colorRibbonA));
    }

    /* ---- the star where it lands ---- */
    this.novaFlare.visible = this.novaK > 0.01;
    if (this.novaFlare.visible) {
      this.novaFlare.position.copy(this.end);
      this.novaFlare.scale.setScalar(c.novaSize * this.novaK * (1 + this.flash * 0.15));
      const u = this.novaFlare.material.uniforms;
      u.uIntensity.value = c.novaIntensity * g.shaderIntensity;
      u.uCore.value = 0.85;
      u.uRays.value = 1.6;
      u.uRing.value = this.novaRing;
      u.uRingWidth.value = 0.05;
      u.uColorCore.value.copy(getColor(c.colorCore));
      u.uColorGlow.value.copy(getColor(c.colorBeam));
      u.uColorRing.value.copy(getColor(c.colorRibbonC));
    }

    /* ---- the circle on the floor ---- */
    const sigilOn = this.sigilDraw > 0.001 && this.sigilFade > 0.001;
    this.groundSigil.visible = sigilOn;
    if (sigilOn) {
      this.groundSigil.position.set(this.origin.x, 0.02, this.origin.z);
      this.groundSigil.scale.setScalar(c.sigilRadius);
      this._sigilUniforms(this.groundSigil.material.uniforms, c, c.sigilIntensity, 0.006);
    }

    /* ---- the circle before the hands ---- */
    const handSigilK = this.fired ? Math.max(0, this.handK) : this.sigilDraw;
    this.handSigil.visible = sigilOn && handSigilK > 0.01;
    if (this.handSigil.visible) {
      this.handSigil.position.copy(this.start).addScaledVector(this.beamDir, c.handSigilOffset);
      this.handSigil.quaternion.setFromUnitVectors(AXIS_Z, this.beamDir);
      this.handSigil.scale.setScalar(c.handSigilSize * (0.6 + 0.4 * Math.min(1, handSigilK)) * (1 + this.flash * 0.1));
      this._sigilUniforms(this.handSigil.material.uniforms, c, c.handSigilIntensity, 0.016);
      this.handSigil.material.uniforms.uSpin.value = c.sigilSpin * 4;
    }

    /* ---- arcs ---- */
    const eye = this.ctx.camera.position;
    for (const bolt of this.arcs) {
      if (!bolt.alive) continue;
      const u = bolt.material.uniforms;
      u.uColorCore.value.copy(getColor(c.colorCore));
      u.uColorBolt.value.copy(getColor(c.colorBeam));
      u.uColorGlow.value.copy(getColor(c.colorSheath));
      bolt.update(dt, eye);
    }

    /* ---- the light at the hands ---- */
    if (this.handLight) {
      this.ctx.lights.set(
        this.handLight,
        this.start,
        getColor(c.lightColor),
        c.handLight * this.handK * g.lightIntensity,
        c.lightRadius * 0.6 * g.lightRadius,
        dt
      );
    }

    this._dress(c);
  }

  _sigilUniforms(u, c, intensity, line) {
    u.uDraw.value = this.sigilDraw;
    u.uSpin.value = c.sigilSpin;
    u.uFlare.value = this.sigilFlare;
    u.uFade.value = this.sigilFade;
    u.uIntensity.value = intensity * settings.global.shaderIntensity;
    u.uLine.value = line;
    u.uColorA.value.copy(getColor(c.colorSigilGold));
    u.uColorB.value.copy(getColor(c.colorSigil));
  }

  /** The light hums with the beam rather than shimmering like ice. */
  lightShimmer() {
    return 0.85 + 0.15 * Math.sin(this.age * 41.0) * Math.sin(this.age * 13.7);
  }

  /* ---- the look of every particle system, every frame ---- */

  _dress(c) {
    const g = settings.global;
    const white = getColor('#ffffff');
    {
      // Neutral ramp: the colour comes from each spark's tint.
      const u = this.sparks.uniforms;
      this.sparks.setGradient(white, white, getColor('#c8c8d8'), getColor('#303040'));
      u.uGravity.value.set(0, -9, 0);
      u.uDrag.value = 1.6;
      u.uTurbulence.value = 0.1;
      u.uStretch.value = 0.1;
      u.uEndSize.value = 0.25;
      u.uFadeOut.value = 0.5;
      u.uGlow.value = 1.4 * g.glow;
      u.uOpacity.value = 1;
    }
    {
      const u = this.embers.uniforms;
      this.embers.setGradient(white, getColor(c.colorSparkA), getColor(c.colorSparkA), getColor('#3a1208'));
      u.uGravity.value.set(0, -11, 0);
      u.uDrag.value = 0.7;
      u.uTurbulence.value = 0.2;
      u.uStretch.value = 0.05;
      u.uEndSize.value = 0.4;
      u.uFadeOut.value = 0.4;
      u.uGlow.value = 1.3 * g.glow;
      u.uOpacity.value = 1;
    }
    {
      const u = this.gather.uniforms;
      this.gather.setGradient(white, getColor(c.colorBeam), getColor(c.colorSheath), getColor(c.colorGlow));
      u.uGravity.value.set(0, 0, 0);
      u.uDrag.value = 0;
      u.uTurbulence.value = 0;
      u.uEndSize.value = 0.4;
      u.uFadeIn.value = 0.25;
      u.uFadeOut.value = 0.2;
      u.uGlow.value = 2.4 * g.glow;
      u.uOpacity.value = 1;
    }
    {
      const u = this.motes.uniforms;
      this.motes.setGradient(white, getColor(c.colorBeam), getColor(c.colorGlow), getColor(c.colorGlow));
      u.uGravity.value.set(0, 0.6, 0);
      u.uDrag.value = 1.4;
      u.uTurbulence.value = 0.7 * g.turbulence;
      u.uTurbFrequency.value = 1.1;
      u.uEndSize.value = 0.2;
      u.uFadeIn.value = 0.1;
      u.uFadeOut.value = 0.5;
      u.uGlow.value = 1.2 * g.glow;
      u.uOpacity.value = 1;
    }
    {
      const u = this.glints.uniforms;
      this.glints.setGradient(white, getColor(c.colorBeam), getColor(c.colorRibbonA), getColor(c.colorGlow));
      u.uGravity.value.set(0, 0, 0);
      u.uDrag.value = 1;
      u.uTurbulence.value = 0;
      u.uEndSize.value = 0.6;
      u.uSizeIn.value = 0.001;
      u.uFadeIn.value = 0;
      u.uFadeOut.value = 0.4;
      u.uGlow.value = 1.4 * g.glow;
      u.uOpacity.value = 1;
    }
    {
      const u = this.rings.uniforms;
      this.rings.setGradient(white, getColor(c.colorBeam), getColor(c.colorSheath), getColor(c.colorGlow));
      u.uGravity.value.set(0, 0, 0);
      u.uDrag.value = 0;
      u.uTurbulence.value = 0;
      u.uEndSize.value = c.burstSize * 4;
      u.uSizeIn.value = 0.001;
      u.uFadeIn.value = 0;
      u.uFadeOut.value = 0.8;
      u.uGlow.value = 1.2 * g.glow;
      u.uOpacity.value = 1;
    }
  }
}
