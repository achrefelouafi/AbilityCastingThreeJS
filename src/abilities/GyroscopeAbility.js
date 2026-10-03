import { CylinderGeometry, Group, Mesh, PlaneGeometry, Vector3 } from 'three';
import { Ability, AbilityPhase } from './Ability.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { DecalType } from '../effects/GroundDecals.js';
import { BurstMode } from '../effects/BurstSphere.js';
import { LightningBolt } from '../effects/LightningBolt.js';
import { instanceGyroscope } from '../assets/GyroscopeRig.js';
import {
  createBoltMaterial,
  createColumnMaterial,
  createCoreMaterial,
  createSigilMaterial,
  patchGyroscopeBody
} from '../materials/GyroscopeMaterials.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { Easing, saturate } from '../utils/math.js';

/** Where the show is. `Ability#phase` only says active or done; this is the real machine. */
export const GyroAct = Object.freeze({
  SUMMON: 'summon',
  CHARGE: 'charge',
  STORM: 'storm',
  OVERLOAD: 'overload',
  DEPART: 'depart',
  GONE: 'gone'
});

const TAU = Math.PI * 2;
/** Bolts on the stage at once, at most: the nova, a strike per body, and the crawl. */
const BOLTS = 28;
/** Kills booked but not yet landed. */
const MAX_PENDING = 16;

const UP = new Vector3(0, 1, 0);
const _p = new Vector3();
const _q = new Vector3();
const _dir = new Vector3();
const _bow = new Vector3();
const _eye = new Vector3();
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

/**
 * THE STORMHEART GYROSCOPE — a circle that answers with lightning.
 *
 * A far cast. A violet arc crawls along the floor to the circle, and then:
 *
 *   1. **The summoning.** The sigil writes itself round the circle; a shaft of
 *      light falls into it; motes spiral in to a point over the middle; and the
 *      gyroscope *condenses* there — a sphere of violet fire grows out of the
 *      rune and leaves brass behind it — coming down the shaft with its rings
 *      spinning far too fast, and settling as it forms. When the last of it
 *      arrives the floor takes a pulse.
 *   2. **The charge.** The rings find their rhythm, and the rune lights: a star
 *      swells in the middle of them, throws rays, gutters like an arc lamp;
 *      sparks of starlight are born round it and arcs crawl from the core out
 *      to the rings.
 *   3. **The storm.** Every `strikeInterval` it picks the nearest body standing
 *      in the circle and fires a bolt into it from the core — a leader, a
 *      return stroke and re-strikes, forks off the channel — and the bolt can
 *      jump on from that body to the next one near it. The sigil flares with
 *      every strike and the rings kick. With nobody left it strikes the floor
 *      instead, because a storm does not stop for want of a target.
 *   4. **The overload.** The core flares white, and it discharges everything:
 *      a ring of bolts to the edge of the circle, one into every body still in
 *      it, and a shock that runs out across the floor.
 *   5. **The leaving.** The rings spin up until they blur, and it burns back
 *      into the rune it came out of.
 *
 * It answers `handlesOwnHits`: it decides who is struck, and when.
 *
 * Nothing about the model is known here: `GyroscopeRig` hands over a
 * gyroscope with its core at the origin, its height, and the radius of its
 * widest ring, and that is the whole contract.
 */
export class GyroscopeAbility extends Ability {
  constructor(context) {
    super('gyro', context);
  }

  get handlesOwnHits() {
    return true;
  }

  /** The editor's size over the size the rig was normalised to. Live. */
  get scaleK() {
    return this.rig ? this.config.size / Math.max(0.01, this.rig.height) : 1;
  }

  /** Metres from the core to the widest ring, at the current size. */
  get ringRadius() {
    return (this.rig ? this.rig.radius : 0.9) * this.scaleK;
  }

  /* ------------------------------------------------------------------ */
  /* construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    const rig = this.ctx.models?.gyro ?? null;
    this.rig = rig;

    // root: the core, in the world. spinner: the slow turn and the sway.
    // body: the model, in rig metres.
    this.root = new Group();
    this.root.name = 'GyroRoot';
    this.spinner = new Group();
    this.body = new Group();
    this.root.add(this.spinner);
    this.spinner.add(this.body);
    this.group.add(this.root);

    this.gyro = null;
    this.bodyMaterial = null;
    this.bodyMeshes = [];
    if (rig) {
      this.gyro = instanceGyroscope(rig);
      for (const mesh of this.gyro.meshes) {
        // One material per instance, so one gyroscope's reveal never prints
        // out another's. The export is a single material.
        if (!this.bodyMaterial) {
          const material = mesh.material.clone();
          this.bodyMaterial = patchGyroscopeBody(material);
        }
        mesh.material = this.bodyMaterial;
        mesh.layers.set(LAYER.WORLD);
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        this.bodyMeshes.push(mesh);
      }
      this.body.add(this.gyro.root);
    }

    /* ---- the sigil ---- */
    const flat = new PlaneGeometry(1, 1);
    flat.rotateX(-Math.PI / 2);
    this.sigilMaterial = createSigilMaterial();
    this.sigil = new Mesh(flat, this.sigilMaterial);
    this.sigil.layers.set(LAYER.VFX);
    this.sigil.renderOrder = 6;
    this.sigil.frustumCulled = false;
    this.group.add(this.sigil);

    /* ---- the shaft of light ---- */
    const shaft = new CylinderGeometry(1, 1, 1, 48, 1, true);
    shaft.translate(0, 0.5, 0);
    this.columnMaterial = createColumnMaterial();
    this.column = new Mesh(shaft, this.columnMaterial);
    this.column.layers.set(LAYER.VFX);
    this.column.renderOrder = 9;
    this.column.frustumCulled = false;
    this.group.add(this.column);

    /* ---- the core ---- */
    this.coreMaterial = createCoreMaterial();
    this.core = new Mesh(new PlaneGeometry(1, 1), this.coreMaterial);
    this.core.layers.set(LAYER.VFX);
    this.core.renderOrder = 16;
    this.core.frustumCulled = false;
    this.group.add(this.core);

    /* ---- the bolts ---- */
    this.bolts = [];
    for (let i = 0; i < BOLTS; i++) {
      const bolt = new LightningBolt(createBoltMaterial());
      this.bolts.push(bolt);
      this.group.add(bolt.mesh);
    }

    /* ---- state ---- */
    this.centre = new Vector3();
    this.corePos = new Vector3();
    this.act = GyroAct.SUMMON;
    this.show = 0;
    this.appear = 0;
    this.reveal = 0;
    this.charge = 0;
    this.pulse = 0;
    this.kick = 0;
    this.spinRate = 1;
    this.formed = false;
    this.overloaded = false;
    this.strikeTimer = 0;
    this.hitLight = null;
    this.hitLightAt = new Vector3();
    this.hitLightPower = 0;
    this.shadowsOn = false;

    this._targets = [];
    this._chain = [];
    this._pending = [];
    for (let i = 0; i < MAX_PENDING; i++) {
      this._pending.push({ live: false, at: 0, dummy: null, point: new Vector3(), dirX: 0, dirZ: 1, big: false });
    }

    this._motes = new RateEmitter(60);
    this._stars = new RateEmitter(60);
    this._crawl = new RateEmitter(6);
    this._fuseArcs = new RateEmitter(16);
    this._fuseSparks = new RateEmitter(120);
  }

  createParticles() {
    const P = this.ctx.particles;
    this.motes = P.get('gyroMote', {
      capacity: 700,
      shape: ParticleShape.SOFT,
      additive: true,
      swirl: true,
      softFade: 0.1
    });
    this.stars = P.get('gyroStar', { capacity: 500, shape: ParticleShape.GLINT, additive: true });
    this.sparks = P.get('gyroSpark', {
      capacity: 900,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.1
    });
    this.flashes = P.get('gyroFlash', { capacity: 128, shape: ParticleShape.GLINT, additive: true });
    this.smoke = P.get('gyroSmoke', {
      capacity: 240,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 0.5
    });
  }

  /* ------------------------------------------------------------------ */
  /* the plan                                                            */
  /* ------------------------------------------------------------------ */

  /** Act boundaries in show seconds, re-read every frame so the editor is live. */
  _plan(c) {
    const p = this._planned ?? (this._planned = {});
    p.summon1 = Math.max(0.2, c.summonTime);
    p.charge1 = p.summon1 + Math.max(0.1, c.chargeTime);
    p.storm1 = p.charge1 + Math.max(0.2, c.stormTime);
    p.overload1 = p.storm1 + Math.max(0.2, c.overloadTime);
    p.depart1 = p.overload1 + Math.max(0.2, c.departTime);
    return p;
  }

  _actAt(t, p) {
    if (t < p.summon1) return GyroAct.SUMMON;
    if (t < p.charge1) return GyroAct.CHARGE;
    if (t < p.storm1) return GyroAct.STORM;
    if (t < p.overload1) return GyroAct.OVERLOAD;
    if (t < p.depart1) return GyroAct.DEPART;
    return GyroAct.GONE;
  }

  /* ------------------------------------------------------------------ */
  /* lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.pointAt(1, this.centre);
    this.act = GyroAct.SUMMON;
    this.show = 0;
    this.appear = 0;
    this.reveal = 0;
    this.charge = 0;
    this.pulse = 0;
    this.kick = 0;
    this.formed = false;
    this.overloaded = false;
    this.strikeTimer = 0;
    this.hitLightPower = 0;
    this.spinRate = this.config.spinSummon;
    for (const slot of this._pending) {
      slot.live = false;
      slot.dummy = null;
    }
    for (const bolt of this.bolts) bolt.kill();
    this._motes.reset();
    this._stars.reset();
    this._crawl.reset();
    this._fuseArcs.reset();
    this._fuseSparks.reset();

    this.hitLight = this.ctx.lights.acquire();
    this._castShadows(false);

    this.root.visible = false;
    this.sigil.visible = false;
    this.column.visible = false;
    this.core.visible = false;

    if (this.gyro?.spin) {
      this.gyro.spin.reset().play();
      this.gyro.mixer.setTime(Math.random() * 8);
    }
  }

  onDestroy() {
    this.ctx.lights.release(this.hitLight);
    this.hitLight = null;
    for (const bolt of this.bolts) bolt.kill();
    for (const slot of this._pending) {
      slot.live = false;
      slot.dummy = null;
    }
    this.root.visible = false;
    this.sigil.visible = false;
    this.column.visible = false;
    this.core.visible = false;
    this._castShadows(false);
  }

  _castShadows(on) {
    if (this.shadowsOn === on) return;
    this.shadowsOn = on;
    for (const mesh of this.bodyMeshes) mesh.castShadow = on;
  }

  /* ------------------------------------------------------------------ */
  /* the frame                                                           */
  /* ------------------------------------------------------------------ */

  update(dt) {
    if (!this.isActive) return;
    this.age += dt;
    const c = this.config;

    if (this.phase === AbilityPhase.TRAVEL) {
      const reached = this.advance(dt);
      this._fuse(dt, c);
      this._updateLight(dt, 0.35);
      if (reached) {
        this.phase = AbilityPhase.IMPACT;
        this._arrive(c);
      }
      this._bolts(dt);
      this._dress(c);
      return;
    }

    const plan = this._plan(c);
    this.show += dt;
    const act = this._actAt(this.show, plan);
    if (act !== this.act) this._enter(act, c);
    if (this.act === GyroAct.GONE) {
      this.phase = AbilityPhase.DONE;
      return;
    }

    this._perform(dt, c, plan);
    this._animate(dt, c);
    if (this.act === GyroAct.STORM) this._storm(dt, c);
    this._land(c);
    this._emitters(dt, c);
    this._bolts(dt);
    this._dress(c);
    this._updateLight(dt, this.appear * (0.35 + 0.65 * Math.min(1.5, this.charge)));
    this._hitLightFrame(dt, c);
  }

  /** One-shot work on the frame an act begins. */
  _enter(act, c) {
    this.act = act;
    if (act === GyroAct.OVERLOAD) this._overload(c);
    if (act === GyroAct.DEPART) {
      this._castShadows(false);
      this.ctx.shake.add(0.12 * settings.global.cameraShake, 2.5, 20);
    }
  }

  /* ---- the fuse: an arc crawling along the floor to the circle ---- */

  _fuse(dt, c) {
    const g = settings.global;
    const time = frame.uTime.value;
    this.position.y = 0.1;

    const sparks = this._fuseSparks.tick(dt, c.fuseSparks * g.particleCount);
    for (let i = 0; i < sparks; i++) {
      const back = Math.random() * c.speed * g.speed * dt;
      _emit.position.copy(this.position).addScaledVector(this.direction, -back);
      _emit.direction.set((Math.random() - 0.5) * 0.6, 1, (Math.random() - 0.5) * 0.6);
      _emit.radius = 0.05;
      _emit.speed = 2.6;
      _emit.speedVariance = 0.6;
      _emit.spread = 0.7;
      _emit.size = 0.035;
      _emit.sizeVariance = 0.5;
      _emit.life = 0.32;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.anchor = null;
      _emit.time = time;
      this.sparks.emit(1, _emit);
    }

    // Short arcs licking back along the trail it has just laid.
    const arcs = this._fuseArcs.tick(dt, c.fuseArcs);
    for (let i = 0; i < arcs; i++) {
      _p.copy(this.position).setY(0.12);
      _q.copy(this.position)
        .addScaledVector(this.direction, -(0.7 + Math.random() * 1.4))
        .addScaledVector(this.side, (Math.random() - 0.5) * 1.1)
        .setY(0.04);
      this._bolt(_p, _q, { width: c.boltWidth * 0.45, jag: 0.28, arch: 0.1, forks: 1, life: 0.2, leader: 0.02, restrikes: 1, intensity: c.boltIntensity * 0.7 });
    }
    _emit.position.copy(this.position);
    _emit.direction.set(0, 1, 0);
    _emit.radius = 0;
    _emit.speed = 0;
    _emit.spread = 0;
    _emit.size = 0.55;
    _emit.sizeVariance = 0.3;
    _emit.life = 0.06;
    _emit.lifeVariance = 0.2;
    _emit.spin = 4;
    _emit.time = time;
    if (Math.random() < 0.5) this.flashes.emit(1, _emit);
  }

  /** The arc reaches the circle: the sigil starts writing, the sky answers. */
  _arrive(c) {
    const g = settings.global;
    this.pointAt(1, this.centre);
    this.show = 0;
    this.act = GyroAct.SUMMON;
    this.root.visible = !!this.gyro;
    this.sigil.visible = true;
    this.column.visible = true;
    this.core.visible = true;

    this.ctx.decals.spawn(DecalType.SHOCKWAVE, this.centre, {
      radius: c.zoneRadius,
      life: 0.7,
      intensity: 0.8,
      width: 0.05,
      colorA: getColor(c.colorSigil),
      colorB: getColor(c.colorGlow)
    });
    _emit.position.copy(this.centre).setY(0.2);
    _emit.direction.set(0, 1, 0);
    _emit.radius = 0;
    _emit.speed = 0;
    _emit.spread = 0;
    _emit.size = 2.4;
    _emit.sizeVariance = 0.1;
    _emit.life = 0.16;
    _emit.lifeVariance = 0.1;
    _emit.spin = 2;
    _emit.anchor = null;
    _emit.time = frame.uTime.value;
    this.flashes.emit(1, _emit);
    this.lightBoost = 20 * g.explosionIntensity;
    this.ctx.shake.add(0.15 * g.cameraShake, 3, 22);
    this._perform(0, c, this._plan(c));
    this._animate(0, c);
  }

  /* ---- the show, read off the clock ---- */

  _perform(dt, c, p) {
    const t = this.show;
    const g = settings.global;

    // How much of it is here, 0..1, and the reveal sphere's radius.
    const sp = saturate(t / p.summon1);
    const dp = saturate((t - p.overload1) / Math.max(0.01, p.depart1 - p.overload1));
    const form = Easing.outCubic(saturate((sp - 0.22) / 0.78));
    const full = this.ringRadius * 1.25 + 0.3;

    if (this.act === GyroAct.DEPART) {
      this.appear = 1 - Easing.inQuad(dp);
      this.reveal = full * (1 - Easing.inCubic(dp));
    } else {
      this.appear = Easing.outQuad(saturate(sp * 1.6));
      this.reveal = full * form;
    }

    // The moment it is whole: a pulse through the floor, a ring of sparks.
    if (!this.formed && sp >= 1) {
      this.formed = true;
      this._castShadows(true);
      this._formedPulse(c);
    }

    // Charge: a breath while it forms, then up through the charge, held in the
    // storm, white in the overload, and gone as it leaves.
    let charge = 0;
    switch (this.act) {
      case GyroAct.SUMMON:
        charge = 0.15 * form;
        break;
      case GyroAct.CHARGE:
        charge = 0.15 + 0.85 * Easing.inOutQuad(saturate((t - p.summon1) / (p.charge1 - p.summon1)));
        break;
      case GyroAct.STORM:
        charge = 1;
        break;
      case GyroAct.OVERLOAD: {
        const op = saturate((t - p.storm1) / (p.overload1 - p.storm1));
        charge = 1 + 0.8 * Math.exp(-op * 5);
        break;
      }
      case GyroAct.DEPART:
        charge = 1 - Easing.outQuad(dp);
        break;
      default:
        break;
    }
    this.charge = charge;

    // The rings: far too fast as it condenses, settling into the rhythm, faster
    // in the storm, and a blur as it leaves.
    let spin = c.spinRate;
    if (this.act === GyroAct.SUMMON) spin = c.spinSummon + (c.spinRate - c.spinSummon) * Easing.outCubic(sp);
    else if (this.act === GyroAct.CHARGE) spin = c.spinRate + (c.spinStorm - c.spinRate) * (charge - 0.15) / 0.85;
    else if (this.act === GyroAct.STORM) spin = c.spinStorm;
    else if (this.act === GyroAct.OVERLOAD) spin = c.spinStorm * 2;
    else if (this.act === GyroAct.DEPART) spin = c.spinStorm + (c.spinDepart - c.spinStorm) * Easing.inQuad(dp);
    this.spinRate = spin + this.kick * c.strikeKick;

    this.pulse = Math.max(0, this.pulse - dt * 2.4);
    this.kick = Math.max(0, this.kick - dt * 3);

    // The shaft: falls in at the start of the summoning, gone once it is formed.
    this.columnIntensity =
      Easing.outQuad(saturate(sp / 0.25)) * (1 - Easing.inQuad(saturate((sp - 0.7) / 0.3))) * c.columnIntensity;
    // And returns, faint, to take it home.
    if (this.act === GyroAct.DEPART) this.columnIntensity = Math.sin(dp * Math.PI) * 0.45 * c.columnIntensity;

    // The sigil writes itself round in the first half of the summoning.
    this.sigilReveal = Easing.inOutCubic(saturate(sp / 0.55));
    this.sigilFade = this.act === GyroAct.DEPART ? 1 - Easing.inQuad(dp) : 1;

    // A rumble while it is charging up, rising with it.
    if (this.act === GyroAct.CHARGE) this.ctx.shake.rumble(c.chargeRumble * charge * g.cameraShake, dt);
  }

  /** Place the body: come down the shaft, hover, bob, turn. */
  _animate(dt, c) {
    const p = this._plan(c);
    const sp = saturate(this.show / p.summon1);
    const dp = saturate((this.show - p.overload1) / Math.max(0.01, p.depart1 - p.overload1));
    const t = this.age;

    let y = c.hoverHeight + c.arriveDrop * (1 - Easing.outCubic(sp));
    if (this.act === GyroAct.DEPART) y += c.departRise * Easing.inQuad(dp);
    const bob = Math.sin(t * c.bobRate * TAU) * c.bobAmplitude * this.appear;

    this.root.position.set(this.centre.x, y + bob, this.centre.z);
    this.corePos.copy(this.root.position);
    this.position.copy(this.corePos);

    // A pop as it forms: it overshoots its size and settles.
    const pop = this.act === GyroAct.SUMMON ? 0.55 + 0.45 * Easing.outBack(saturate((sp - 0.15) / 0.85)) : 1;
    const strike = 1 + this.kick * 0.04;
    this.body.scale.setScalar(this.scaleK * pop * strike);
    this.spinner.rotation.set(
      Math.sin(t * 0.7) * c.sway,
      t * c.yawSpeed,
      Math.sin(t * 0.53 + 1.3) * c.sway
    );

    if (this.gyro) {
      this.gyro.mixer.update(dt * this.spinRate * settings.global.animationSpeed);
    }
    this.root.updateMatrixWorld(true);
  }

  /* ---- the storm ---- */

  _storm(dt, c) {
    const dummies = this.ctx.dummies;
    const found = dummies?.findTargets?.(this.centre.x, this.centre.z, c.zoneRadius, this._targets) ?? this._targets;

    this.strikeTimer += dt;
    const interval = Math.max(0.05, c.strikeInterval);
    if (this.strikeTimer < interval) return;

    // The nearest body nobody has a bolt on the way to yet.
    let mark = null;
    for (const dummy of found) {
      if (!this._booked(dummy)) {
        mark = dummy;
        break;
      }
    }

    if (mark) {
      this.strikeTimer = 0;
      this._strike(this.corePos, mark, c, true);

      // And on: the bolt jumps from that body to the next one near it.
      let from = mark;
      const jumps = Math.max(0, Math.round(c.chainJumps));
      for (let j = 0; j < jumps; j++) {
        const next = this._nearestFree(from, c.chainRange);
        if (!next) break;
        this._aim(from, _p);
        this._strike(_p, next, c, false, (j + 1) * c.chainDelay);
        from = next;
      }
    } else {
      // Nobody left: it strikes the floor of its own circle anyway.
      if (this.strikeTimer >= 1 / Math.max(0.1, c.idleStrikeRate)) {
        this.strikeTimer = 0;
        const a = Math.random() * TAU;
        const r = Math.sqrt(0.15 + Math.random() * 0.85) * c.zoneRadius * 0.9;
        _q.set(this.centre.x + Math.cos(a) * r, 0.02, this.centre.z + Math.sin(a) * r);
        this._groundStrike(this.corePos, _q, c, 0.75);
      }
    }
  }

  /** Whether a bolt is already on its way to this body. */
  _booked(dummy) {
    for (const slot of this._pending) if (slot.live && slot.dummy === dummy) return true;
    return false;
  }

  /** The nearest standing, unbooked body within `range` of `from`, inside the circle's reach. */
  _nearestFree(from, range) {
    const found = this.ctx.dummies?.findTargets?.(from.position.x, from.position.z, range, this._chain) ?? this._chain;
    for (const dummy of found) {
      if (dummy === from || this._booked(dummy)) continue;
      return dummy;
    }
    return null;
  }

  /** Where a bolt lands on a body: partway up it, at the chest. */
  _aim(dummy, out) {
    return out.set(dummy.position.x, settings.dummies.height * saturate(this.config.aimHeight), dummy.position.z);
  }

  /**
   * A bolt into a body, and the kill booked for when the leader arrives.
   * `delay` holds a chained bolt back until the one before it has landed.
   */
  _strike(from, dummy, c, primary, delay = 0) {
    const slot = this._pending.find((s) => !s.live);
    if (!slot) return;
    this._aim(dummy, slot.point);
    slot.live = true;
    slot.dummy = dummy;
    slot.big = primary;
    slot.at = this.age + delay + c.boltLeader;
    slot.from = slot.from ?? new Vector3();
    slot.from.copy(from);
    slot.fired = false;
    slot.fireAt = this.age + delay;
    _dir.set(dummy.position.x - this.centre.x, 0, dummy.position.z - this.centre.z);
    const flat = _dir.length();
    slot.dirX = flat > 1e-3 ? _dir.x / flat : this.direction.x;
    slot.dirZ = flat > 1e-3 ? _dir.z / flat : this.direction.z;
    if (delay <= 0) this._fireSlot(slot, c);
  }

  /** Draw the bolt(s) for a booked strike. */
  _fireSlot(slot, c) {
    slot.fired = true;
    const k = slot.big ? 1 : 0.7;
    _bow.subVectors(slot.point, slot.from).setY(0).normalize().multiplyScalar(-0.2).add(UP).normalize();
    this._bolt(slot.from, slot.point, {
      width: c.boltWidth * k,
      jag: c.boltJag,
      arch: c.boltArch,
      forks: c.boltForks,
      life: c.boltLife,
      leader: c.boltLeader,
      restrikes: c.boltRestrikes,
      intensity: c.boltIntensity * k
    }, _bow);
    // A thinner sympathetic channel beside the main one, from a point on the
    // rings, so a strike from the core reads as a discharge, not a wire.
    if (slot.big) {
      randomUnit(_q).multiplyScalar(this.ringRadius * 0.7).add(slot.from);
      this._bolt(_q, slot.point, {
        width: c.boltWidth * 0.4,
        jag: c.boltJag * 1.4,
        arch: c.boltArch * 1.6,
        forks: 1,
        life: c.boltLife * 0.8,
        leader: c.boltLeader * 1.4,
        restrikes: 2,
        intensity: c.boltIntensity * 0.5
      }, _bow);
      this.kick = 1;
      this.pulse = 1;
      this.lightBoost = Math.max(this.lightBoost, c.strikeLight * 0.5 * settings.global.explosionIntensity);
    }
  }

  /** Booked kills: fire the delayed bolts, land the ones whose leader has arrived. */
  _land(c) {
    const g = settings.global;
    for (const slot of this._pending) {
      if (!slot.live) continue;
      if (!slot.fired && this.age >= slot.fireAt) this._fireSlot(slot, c);
      if (this.age < slot.at) continue;
      slot.live = false;

      const dummy = slot.dummy;
      slot.dummy = null;
      this._impact(slot.point, c, slot.big ? 1 : 0.75);
      if (!dummy || !dummy.alive) continue;
      if (!dummy.kill(slot.dirX, slot.dirZ, c.hit)) continue;

      _p.set(dummy.position.x, 0, dummy.position.z);
      this.ctx.decals.spawn(DecalType.ARC, _p, {
        radius: 1.6,
        life: 2.6,
        intensity: 1.0,
        colorA: getColor(c.colorBolt),
        colorB: getColor(c.colorGlow)
      });
      this.ctx.decals.spawn(DecalType.SCORCH, _p, {
        radius: 0.7,
        life: 3.2,
        intensity: 0.5,
        colorA: getColor(c.colorGlow)
      });
      this.ctx.bursts.spawn(BurstMode.STORM, slot.point, {
        radius: 0.2,
        endRadius: 1.5,
        life: 0.4,
        intensity: 1.4 * g.explosionIntensity,
        opacity: 0.8,
        colorA: getColor(c.colorBolt),
        colorB: getColor(c.colorGlow),
        colorC: getColor(c.colorArc)
      });
    }
  }

  /** Light where a bolt lands: sparks, a flash, a breath of ozone smoke. */
  _impact(point, c, k) {
    const g = settings.global;
    const time = frame.uTime.value;

    _emit.position.copy(point);
    _emit.direction.set(0, 1, 0);
    _emit.radius = 0.1;
    _emit.speed = 6.5;
    _emit.speedVariance = 0.6;
    _emit.spread = 1;
    _emit.size = 0.05;
    _emit.sizeVariance = 0.5;
    _emit.life = 0.45;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.anchor = null;
    _emit.time = time;
    this.sparks.emit(Math.round(c.impactSparks * k * g.particleCount), _emit);

    _emit.speed = 0;
    _emit.spread = 0;
    _emit.radius = 0;
    _emit.size = 1.6 * k;
    _emit.life = 0.12;
    _emit.spin = 5;
    this.flashes.emit(1, _emit);

    _emit.radius = 0.4;
    _emit.speed = 1.2;
    _emit.size = 0.4;
    _emit.life = 0.5;
    _emit.lifeVariance = 0.6;
    _emit.spin = 3;
    this.stars.emit(Math.round(8 * k * g.particleCount), _emit);

    _emit.radius = 0.2;
    _emit.speed = 0.6;
    _emit.spread = 0.9;
    _emit.size = 0.45;
    _emit.life = 1.2;
    _emit.spin = 1;
    this.smoke.emit(Math.round(3 * k), _emit);

    this.hitLightAt.copy(point);
    this.hitLightPower = Math.max(this.hitLightPower, c.strikeLight * k * g.explosionIntensity);
    this.ctx.shake.add(c.strikeShake * k * g.explosionIntensity * g.cameraShake, 4.5, 28);
    if (c.strikeFlash > 0) this.ctx.flash.trigger(getColor(c.colorBolt), c.strikeFlash * k * g.explosionIntensity);
  }

  /** A bolt into the floor, with nobody at the end of it. */
  _groundStrike(from, to, c, k) {
    _bow.subVectors(to, from).setY(0).normalize().multiplyScalar(-0.2).add(UP).normalize();
    this._bolt(from, to, {
      width: c.boltWidth * k,
      jag: c.boltJag,
      arch: c.boltArch,
      forks: c.boltForks,
      life: c.boltLife,
      leader: c.boltLeader,
      restrikes: c.boltRestrikes,
      intensity: c.boltIntensity * k
    }, _bow);
    // The leader lands a beat later; near enough for a floor strike to call it now.
    this._impact(to, c, k * 0.8);
    this.ctx.decals.spawn(DecalType.ARC, to, {
      radius: 1.2 * k + 0.4,
      life: 2.0,
      intensity: 0.8,
      colorA: getColor(c.colorBolt),
      colorB: getColor(c.colorGlow)
    });
    this.pulse = Math.max(this.pulse, 0.6);
    this.kick = Math.max(this.kick, 0.5);
  }

  /** It is whole: the floor takes a pulse and a ring of sparks is thrown off it. */
  _formedPulse(c) {
    const g = settings.global;
    const time = frame.uTime.value;
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, this.centre, {
      radius: c.zoneRadius * 0.9,
      life: 0.8,
      intensity: 1.0,
      width: 0.08,
      colorA: getColor(c.colorSigil),
      colorB: getColor(c.colorArc)
    });
    this.ctx.decals.spawn(DecalType.DUSTRING, this.centre, {
      radius: c.zoneRadius * 0.7,
      life: 1.4,
      intensity: 0.4,
      growth: 0.5,
      colorA: getColor('#8a8496'),
      colorB: getColor('#45414f')
    });
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * TAU;
      _emit.position.copy(this.corePos);
      _emit.direction.set(Math.cos(a), (Math.random() - 0.5) * 0.3, Math.sin(a));
      _emit.radius = this.ringRadius * 0.5;
      _emit.speed = 7;
      _emit.speedVariance = 0.4;
      _emit.spread = 0.15;
      _emit.size = 0.05;
      _emit.sizeVariance = 0.4;
      _emit.life = 0.5;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0;
      _emit.anchor = null;
      _emit.time = time;
      this.sparks.emit(Math.max(1, Math.round(2 * g.particleCount)), _emit);
    }
    _emit.position.copy(this.corePos);
    _emit.radius = 0;
    _emit.speed = 0;
    _emit.spread = 0;
    _emit.size = 3.2;
    _emit.life = 0.2;
    _emit.spin = 2;
    this.flashes.emit(1, _emit);
    this.pulse = 1;
    this.lightBoost = 30 * g.explosionIntensity;
    this.ctx.shake.add(c.formShake * g.cameraShake, 3, 20);
    if (c.formFlash > 0) this.ctx.flash.trigger(getColor(c.colorSigil), c.formFlash * g.explosionIntensity);
  }

  /** Everything at once: a bolt into every body left, a ring to the edge, and the shock. */
  _overload(c) {
    if (this.overloaded) return;
    this.overloaded = true;
    const g = settings.global;
    const R = c.zoneRadius;

    const found = this.ctx.dummies?.findTargets?.(this.centre.x, this.centre.z, R, this._targets) ?? this._targets;
    for (const dummy of found) {
      if (!this._booked(dummy)) this._strike(this.corePos, dummy, c, false);
    }

    const n = Math.max(0, Math.round(c.novaBolts));
    const offset = Math.random() * TAU;
    for (let i = 0; i < n; i++) {
      const a = offset + (i / n) * TAU + (Math.random() - 0.5) * 0.3;
      const r = R * (0.85 + Math.random() * 0.15);
      _q.set(this.centre.x + Math.cos(a) * r, 0.02, this.centre.z + Math.sin(a) * r);
      _bow.set(Math.cos(a), 0, Math.sin(a)).multiplyScalar(-0.2).add(UP).normalize();
      this._bolt(this.corePos, _q, {
        width: c.boltWidth * 0.8,
        jag: c.boltJag,
        arch: c.boltArch * 1.4,
        forks: c.boltForks,
        life: c.boltLife * 1.6,
        leader: c.boltLeader * 1.5,
        restrikes: c.boltRestrikes + 2,
        intensity: c.boltIntensity * 0.85
      }, _bow);
      this.ctx.decals.spawn(DecalType.ARC, _q, {
        radius: 1.1,
        life: 2.2,
        intensity: 0.8,
        colorA: getColor(c.colorBolt),
        colorB: getColor(c.colorGlow)
      });
    }

    this.ctx.decals.spawn(DecalType.SHOCKWAVE, this.centre, {
      radius: R * 1.15,
      life: 0.9,
      intensity: 1.3,
      width: 0.1,
      colorA: getColor(c.colorBolt),
      colorB: getColor(c.colorGlow)
    });
    this.ctx.bursts.spawn(BurstMode.STORM, this.corePos, {
      radius: 0.4,
      endRadius: R * 0.8,
      life: 0.7,
      intensity: 1.6 * g.explosionIntensity,
      opacity: 0.7,
      colorA: getColor(c.colorBolt),
      colorB: getColor(c.colorGlow),
      colorC: getColor(c.colorArc)
    });

    const time = frame.uTime.value;
    _emit.position.copy(this.corePos);
    _emit.direction.set(0, 1, 0);
    _emit.radius = this.ringRadius * 0.4;
    _emit.speed = 9;
    _emit.speedVariance = 0.5;
    _emit.spread = 1;
    _emit.size = 0.06;
    _emit.sizeVariance = 0.5;
    _emit.life = 0.8;
    _emit.lifeVariance = 0.4;
    _emit.spin = 0;
    _emit.anchor = null;
    _emit.time = time;
    this.sparks.emit(Math.round(160 * g.particleCount), _emit);
    _emit.speed = 3;
    _emit.size = 0.35;
    _emit.life = 0.7;
    _emit.spin = 4;
    this.stars.emit(Math.round(40 * g.particleCount), _emit);
    _emit.radius = 0;
    _emit.speed = 0;
    _emit.spread = 0;
    _emit.size = 5.5;
    _emit.life = 0.25;
    this.flashes.emit(1, _emit);

    this.pulse = 1;
    this.kick = 1.5;
    this.lightBoost = c.novaLight * g.explosionIntensity;
    this.hitLightAt.copy(this.centre).setY(0.6);
    this.hitLightPower = c.novaLight * 0.6 * g.explosionIntensity;
    this.ctx.shake.add(c.novaShake * g.explosionIntensity * g.cameraShake, 2.2, 24);
    if (c.novaFlash > 0) this.ctx.flash.trigger(getColor(c.colorBolt), c.novaFlash * g.explosionIntensity);
  }

  /* ---- bolts ---- */

  /** A free bolt — or, failing that, the one nearest its end — fired. */
  _bolt(from, to, opts, bow) {
    let pick = null;
    let oldest = -1;
    for (const bolt of this.bolts) {
      if (!bolt.alive) {
        pick = bolt;
        break;
      }
      const left = bolt.age / Math.max(0.01, bolt.opts.life);
      if (left > oldest) {
        oldest = left;
        pick = bolt;
      }
    }
    pick.fire(from, to, opts, bow);
    return pick;
  }

  _bolts(dt) {
    _eye.setFromMatrixPosition(this.ctx.camera.matrixWorld);
    for (const bolt of this.bolts) bolt.update(dt, _eye);
  }

  /* ---- particles ---- */

  _emitters(dt, c) {
    const g = settings.global;
    const time = frame.uTime.value;
    const p = this._plan(c);
    const sp = saturate(this.show / p.summon1);
    const rr = this.ringRadius;

    /* motes spiralling in to the core while it is called and charged */
    let moteRate = 0;
    if (this.act === GyroAct.SUMMON) moteRate = c.moteRate * (1 - sp * 0.4);
    else if (this.act === GyroAct.CHARGE) moteRate = c.moteRate * 0.6;
    else if (this.act === GyroAct.STORM) moteRate = c.moteRate * 0.15;
    const motes = this._motes.tick(dt, moteRate * g.particleCount);
    for (let i = 0; i < motes; i++) {
      randomUnit(_dir);
      _dir.y = _dir.y * 0.6;
      const r = rr * (1.6 + Math.random() * 2.2);
      _emit.position.copy(this.corePos).addScaledVector(_dir, r);
      _emit.anchor = this.corePos;
      _emit.direction.set(0, 1, 0);
      _emit.radius = 0;
      _emit.speed = 0;
      _emit.speedVariance = 0;
      _emit.spread = 0;
      _emit.size = c.moteSize;
      _emit.sizeVariance = 0.5;
      _emit.life = 1.0;
      _emit.lifeVariance = 0.3;
      _emit.spin = 0;
      _emit.time = time;
      this.motes.emit(1, _emit);
    }
    _emit.anchor = null;

    /* stars born round the core */
    const starRate = this.act === GyroAct.SUMMON ? 0 : c.starRate * Math.min(1.5, this.charge) * this.appear;
    const stars = this._stars.tick(dt, starRate * g.particleCount);
    for (let i = 0; i < stars; i++) {
      randomUnit(_dir);
      const r = rr * (0.25 + Math.random() * c.starReach);
      _emit.position.copy(this.corePos).addScaledVector(_dir, r);
      _emit.direction.copy(_dir);
      _emit.radius = 0;
      _emit.speed = 0.35;
      _emit.speedVariance = 0.6;
      _emit.spread = 0.6;
      _emit.size = c.starSize;
      _emit.sizeVariance = 0.6;
      _emit.life = 0.55;
      _emit.lifeVariance = 0.5;
      _emit.spin = 3;
      _emit.time = time;
      this.stars.emit(1, _emit);
    }

    /* arcs crawling from the core out to the rings */
    const crawling = this.act === GyroAct.CHARGE || this.act === GyroAct.STORM || this.act === GyroAct.OVERLOAD;
    const crawlRate = crawling ? c.crawlRate * Math.min(1.5, this.charge) : 0;
    const arcs = this._crawl.tick(dt, crawlRate);
    for (let i = 0; i < arcs; i++) {
      randomUnit(_dir);
      _q.copy(this.corePos).addScaledVector(_dir, rr * (0.75 + Math.random() * 0.35));
      _bow.copy(_dir).cross(UP).normalize();
      if (_bow.lengthSq() < 0.5) _bow.set(1, 0, 0);
      this._bolt(this.corePos, _q, {
        width: c.boltWidth * 0.32,
        jag: 0.3,
        arch: 0.18,
        forks: 1,
        life: 0.16,
        leader: 0.025,
        restrikes: 1,
        intensity: c.boltIntensity * 0.55
      }, _bow);
    }

    /* leaving: it sheds itself as sparks of light rising off the brass */
    if (this.act === GyroAct.DEPART && Math.random() < 0.8) {
      randomUnit(_dir);
      _emit.position.copy(this.corePos).addScaledVector(_dir, this.reveal);
      _emit.direction.set(_dir.x * 0.3, 1, _dir.z * 0.3);
      _emit.radius = 0.05;
      _emit.speed = 1.6;
      _emit.speedVariance = 0.5;
      _emit.spread = 0.3;
      _emit.size = c.starSize * 1.3;
      _emit.sizeVariance = 0.5;
      _emit.life = 0.9;
      _emit.lifeVariance = 0.3;
      _emit.spin = 3;
      _emit.time = time;
      this.stars.emit(Math.round(3 * g.particleCount), _emit);
    }
  }

  /* ---- light ---- */

  _hitLightFrame(dt, c) {
    if (!this.hitLight) return;
    this.lightColor.copy(getColor(c.colorBolt));
    this.ctx.lights.set(this.hitLight, this.hitLightAt, this.lightColor, this.hitLightPower, c.strikeLightRadius, dt);
    this.hitLightPower = Math.max(0, this.hitLightPower - this.hitLightPower * 9 * dt - dt);
  }

  /** An arc lamp: it gutters, hard and fast. */
  lightShimmer() {
    const k = this.config?.lightGutter ?? 0.3;
    return 1 - k * 0.5 + k * 0.5 * Math.sin(this.age * 41.0) * Math.sin(this.age * 17.3 + 1.1);
  }

  /* ---- every uniform, every frame ---- */

  _dress(c) {
    const g = settings.global;
    const opacity = g.opacity;
    const camera = this.ctx.camera;

    /* the body */
    if (this.bodyMaterial) {
      const u = this.bodyMaterial.userData.gyroUniforms;
      u.uGyroCore.value.copy(this.corePos);
      u.uRevealR.value = this.reveal;
      u.uRevealWidth.value = Math.max(0.01, c.revealWidth);
      u.uRevealColor.value.copy(getColor(c.revealColor));
      u.uRevealGlow.value = c.revealGlow * g.glow;
      u.uRimColor.value.copy(getColor(c.rimColor));
      u.uRimStrength.value = c.rimStrength * g.fresnel;
      u.uRimPower.value = c.rimPower;
      u.uEmissiveBoost.value = 1 + c.gemGlow * this.charge + this.pulse * c.gemGlow;
      u.uCharge.value = this.pulse * 0.6 + Math.max(0, this.charge - 1);
    }

    /* the sigil */
    {
      const u = this.sigilMaterial.uniforms;
      const quad = (c.zoneRadius + 1) * 2;
      u.uQuadSize.value = quad;
      u.uRadius.value = c.zoneRadius;
      u.uReveal.value = this.sigilReveal ?? 0;
      u.uCharge.value = Math.min(1.6, this.charge);
      u.uPulse.value = this.pulse;
      u.uSpin.value = c.sigilSpin * (1 + this.charge);
      u.uFill.value = c.sigilFill;
      u.uIntensity.value = c.sigilIntensity * (this.sigilFade ?? 1) * g.shaderIntensity;
      u.uOpacity.value = opacity;
      u.uColorA.value.copy(getColor(c.colorSigil));
      u.uColorB.value.copy(getColor(c.colorSigilGold));
      u.uColorArc.value.copy(getColor(c.colorArc));
      this.sigil.position.set(this.centre.x, 0.035, this.centre.z);
      this.sigil.scale.setScalar(quad);
    }

    /* the shaft */
    {
      const u = this.columnMaterial.uniforms;
      const k = this.columnIntensity ?? 0;
      u.uIntensity.value = k * g.shaderIntensity;
      u.uOpacity.value = opacity;
      u.uColor.value.copy(getColor(c.colorGlow));
      u.uColorCore.value.copy(getColor(c.colorBolt));
      this.column.visible = this.phase !== AbilityPhase.TRAVEL && k > 0.002;
      const r = c.columnRadius;
      this.column.position.set(this.centre.x, 0, this.centre.z);
      this.column.scale.set(r, c.hoverHeight + c.arriveDrop + 8, r);
    }

    /* the core */
    {
      const u = this.coreMaterial.uniforms;
      u.uIntensity.value = c.coreIntensity * this.appear * g.glow;
      u.uCharge.value = Math.min(1, this.charge);
      u.uRays.value = Math.max(1, Math.round(c.coreRays));
      u.uFlicker.value = c.coreFlicker;
      u.uOpacity.value = opacity;
      u.uColorCore.value.copy(getColor(c.colorCore));
      u.uColorGlow.value.copy(getColor(c.colorGlow));
      u.uColorArc.value.copy(getColor(c.colorArc));
      const size = c.coreSize * (0.35 + 0.65 * this.charge) * (1 + this.pulse * 0.5) * Math.max(0.2, this.appear);
      this.core.position.copy(this.corePos);
      this.core.quaternion.copy(camera.quaternion);
      this.core.scale.setScalar(size);
      this.core.visible = this.phase !== AbilityPhase.TRAVEL && this.appear > 0.01;
    }

    /* the bolts */
    for (const bolt of this.bolts) {
      if (!bolt.alive) continue;
      const u = bolt.material.uniforms;
      u.uCoreWidth.value = c.boltCore;
      u.uOpacity.value = opacity;
      u.uColorCore.value.copy(getColor(c.colorCore));
      u.uColorBolt.value.copy(getColor(c.colorBolt));
      u.uColorGlow.value.copy(getColor(c.colorGlow));
    }

    /* the particle systems — shared, so re-dressed every frame */
    {
      const u = this.motes.uniforms;
      this.motes.setGradient(getColor(c.colorArc), getColor(c.colorBolt), getColor(c.colorGlow), getColor(c.colorGlow));
      u.uGravity.value.set(0, 0, 0);
      u.uDrag.value = 1;
      u.uTurbulence.value = 0.05;
      u.uSwirl.value = c.moteSwirl;
      u.uSwirlExpand.value = -0.97;
      u.uEndSize.value = 0.35;
      u.uSizeIn.value = 0.15;
      u.uFadeIn.value = 0.2;
      u.uFadeOut.value = 0.2;
      u.uGlow.value = 2.2 * g.glow;
      u.uOpacity.value = opacity;
    }
    {
      const u = this.stars.uniforms;
      this.stars.setGradient(getColor('#ffffff'), getColor(c.colorStar), getColor(c.colorArc), getColor(c.colorGlow));
      u.uGravity.value.set(0, 0, 0);
      u.uDrag.value = 2;
      u.uTurbulence.value = 0.2;
      u.uEndSize.value = 0.2;
      u.uSizeIn.value = 0.1;
      u.uFadeIn.value = 0.05;
      u.uFadeOut.value = 0.5;
      u.uGlow.value = 2.6 * g.glow;
      u.uOpacity.value = opacity;
    }
    {
      const u = this.sparks.uniforms;
      this.sparks.setGradient(getColor('#ffffff'), getColor(c.colorBolt), getColor(c.colorArc), getColor(c.colorGlow));
      u.uGravity.value.set(0, -11, 0);
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
      this.flashes.setGradient(getColor('#ffffff'), getColor(c.colorBolt), getColor(c.colorGlow), getColor(c.colorGlow));
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
      const u = this.smoke.uniforms;
      this.smoke.setGradient(getColor('#6d6680'), getColor('#4c4759'), getColor('#34303d'), getColor('#221f28'));
      u.uGravity.value.set(0, 0.7, 0);
      u.uDrag.value = 2;
      u.uTurbulence.value = 0.4;
      u.uTurbFrequency.value = 1.2;
      u.uEndSize.value = 2.6;
      u.uFadeIn.value = 0.1;
      u.uFadeOut.value = 0.4;
      u.uGlow.value = 0.3;
      u.uOpacity.value = 0.3 * opacity;
    }
  }

  dispose() {
    super.dispose();
    this.bodyMaterial?.dispose();
    this.sigilMaterial.dispose();
    this.columnMaterial.dispose();
    this.coreMaterial.dispose();
    for (const bolt of this.bolts) bolt.dispose();
  }
}

