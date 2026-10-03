import { InstancedMesh, DynamicDrawUsage, Matrix4, Mesh, PlaneGeometry, Quaternion, Vector3 } from 'three';
import { Ability } from './Ability.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { DecalType } from '../effects/GroundDecals.js';
import { buildAmethystRig } from '../assets/AmethystRig.js';
import { createCircleMaterial, createCrystalMaterial, MAX_SOCKETS } from '../materials/AmethystMaterials.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { Easing, clamp, saturate, smoothstep } from '../utils/math.js';

const TAU = Math.PI * 2;
/** Broken pieces one cast can have on the floor. */
const MAX_SHARDS = 220;

const UP = new Vector3(0, 1, 0);
const _a = new Vector3();
const _b = new Vector3();
const _d = new Vector3();
const _p = new Vector3();
const _q = new Quaternion();
const _qa = new Quaternion();
const _qs = new Quaternion();
const _s = new Vector3();
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

/** One stone: its mesh, where it stands on the circle, and what it has done. */
class Stone {
  constructor(group, geometry) {
    this.material = createCrystalMaterial();
    this.mesh = new Mesh(geometry, this.material);
    this.mesh.name = 'AmethystStone';
    this.mesh.layers.set(LAYER.WORLD);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    group.add(this.mesh);

    this.variant = 0;
    this.seed = 0;
    this.size = 1;
    this.hover = 2;
    this.spin = 0;
    this.order = 0;
    // the timeline, re-solved every frame
    this.openAt = 0;
    this.riseAt = 0;
    this.launchAt = 0;
    // what has happened to it
    this.risen = false;
    this.launched = false;
    this.hit = false;
    this.launchedAt = 0;
    // where it is
    this.socket = new Vector3();
    this.position = new Vector3();
    this.quaternion = new Quaternion();
    this.from = new Vector3();
    this.dir = new Vector3(0, 1, 0);
    this.flare = 0;
    this.spent = 0;
    this.open = 0;
    this.charge = 0;
    this.flash = 0;
  }

  reset() {
    this.risen = false;
    this.launched = false;
    this.hit = false;
    this.flare = 0;
    this.spent = 0;
    this.open = 0;
    this.charge = 0;
    this.flash = 0;
    this.mesh.visible = false;
  }
}

/**
 * AMETHYST VERDICT — a targeted far cast: one body, crushed by stone.
 *
 * The circle locks onto whoever is under the cursor. When the cast lands:
 *
 *   1. **The circle.** A rite writes itself round the body: rune bands, a
 *      star strung between the points on its edge, and a socket circle
 *      inscribing itself at every point — five to eight of them — with a
 *      reticle closing on the body in the middle.
 *   2. **The stones.** An amethyst point comes up out of every socket, through
 *      the floor, in a crack of stone and violet dust, overshoots, and hangs
 *      there turning — the light coming up inside it as it charges.
 *   3. **The aim.** Every stone turns its point on the body and draws back,
 *      trembling; chevrons run down the spokes of the circle toward it.
 *   4. **The verdict.** They come in one after another, in no order the body
 *      could read, each one drilling as it flies. The first takes it off its
 *      feet; each after it drives it the other way; every stone shatters on
 *      it into real pieces that fall and lie on the floor.
 *   5. **The finale.** When the last has broken, the circle goes off: a burst
 *      of crystal out of the body, a pulse run out to the edge, and the body
 *      thrown up off the floor.
 *
 * Like every ability here it captures nothing at the cast but a handful of
 * random numbers — which stone stands in which socket, how high each hangs,
 * the order they come in — and re-solves the rest off `settings.amethyst`
 * every frame.
 */
export class AmethystAbility extends Ability {
  constructor(context) {
    super('amethyst', context);
  }

  /** It picks one body and decides for itself when it is hit. */
  get handlesOwnHits() {
    return true;
  }

  get cameraWeight() {
    return this.u < 1 ? saturate(1 - this.u * 0.4) : 0.65;
  }

  get impactDuration() {
    return Math.max(0.1, this.endAt);
  }

  /** Long enough for the last of the pieces to melt into the floor. */
  get fadeDuration() {
    const c = settings.amethyst;
    return Math.max(0.05, c.fadeTime, c.shardLife * 1.3 - c.afterTime + 0.1);
  }

  get instanceCount() {
    return this.shardMesh.count;
  }

  /* ------------------------------------------------------------------ */
  /* construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    const rig = this.ctx.models?.amethyst ?? buildAmethystRig(null);
    this.variants = rig.variants;

    /* ---- the stones ---- */
    this.stones = Array.from({ length: MAX_SOCKETS }, () => new Stone(this.group, this.variants[0].geometry));

    /* ---- the pieces they break into ---- */
    const shardGeometry = (this.variants[1] ?? this.variants[0]).geometry;
    this.shardMaterial = createCrystalMaterial({ shard: true });
    this.shardMesh = new InstancedMesh(shardGeometry, this.shardMaterial, MAX_SHARDS);
    this.shardMesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.shardMesh.name = 'AmethystShards';
    this.shardMesh.layers.set(LAYER.WORLD);
    this.shardMesh.castShadow = true;
    this.shardMesh.receiveShadow = true;
    this.shardMesh.frustumCulled = false;
    this.shardMesh.count = 0;
    this.group.add(this.shardMesh);
    this.shards = Array.from({ length: MAX_SHARDS }, () => ({
      position: new Vector3(),
      velocity: new Vector3(),
      quaternion: new Quaternion(),
      axis: new Vector3(1, 0, 0),
      spin: 0,
      size: 0.2,
      age: 0,
      life: 1,
      resting: false
    }));
    this.shardCount = 0;
    this.shardNext = 0;

    /* ---- the circle on the floor ---- */
    const flat = new PlaneGeometry(1, 1);
    flat.rotateX(-Math.PI / 2);
    this.circleMaterial = createCircleMaterial();
    this.circle = new Mesh(flat, this.circleMaterial);
    this.circle.name = 'AmethystCircle';
    this.circle.layers.set(LAYER.VFX);
    this.circle.renderOrder = 5;
    this.circle.frustumCulled = false;
    this.circle.visible = false;
    this.group.add(this.circle);
    this._circleState = {
      quad: 10,
      radius: 3,
      socketRadius: 0.5,
      count: 6,
      yaw: 0,
      draw: 0,
      converge: 0,
      lock: 0,
      pulse: 0,
      flare: 0,
      fade: 1,
      sockets: this.stones
    };

    /* ---- state ---- */
    this.target = new Vector3();
    this.aim = new Vector3();
    this.victim = null;
    this.taken = false;
    this.fieldAge = 0;
    this.yaw = 0;
    this.count = 6;
    this.aimAt = 0;
    this.launchStart = 0;
    this.finaleAt = Infinity;
    this.endAt = 0;
    this.finaled = false;
    this._targets = [];

    this._travel = new RateEmitter(60);
    this._motes = new RateEmitter(40);
    this._charge = new RateEmitter(40);
    this._lock = new RateEmitter(18);
  }

  createParticles() {
    const P = this.ctx.particles;
    this.sparks = P.get('amethystSpark', {
      capacity: 900,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.1
    });
    this.chips = P.get('amethystChip', {
      capacity: 900,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.05
    });
    this.motes = P.get('amethystMote', {
      capacity: 700,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.2
    });
    this.dust = P.get('amethystDust', {
      capacity: 260,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 0.6
    });
    this.glints = P.get('amethystGlint', { capacity: 120, shape: ParticleShape.GLINT, additive: true });
  }

  /* ------------------------------------------------------------------ */
  /* lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.fieldAge = 0;
    this.victim = null;
    this.taken = false;
    this.finaled = false;
    this.finaleAt = Infinity;
    this.endAt = 0;
    for (const stone of this.stones) stone.reset();
    this._clearShards();
    this.circle.visible = false;
    for (const emitter of [this._travel, this._motes, this._charge, this._lock]) emitter.reset();
  }

  onDestroy() {
    this.victim = null;
    this.taken = false;
    for (const stone of this.stones) stone.reset();
    this._clearShards();
    this.circle.visible = false;
  }

  _clearShards() {
    this.shardCount = 0;
    this.shardNext = 0;
    for (const shard of this.shards) shard.life = 0;
    this.shardMesh.count = 0;
  }

  /* ------------------------------------------------------------------ */
  /* the cast's run to the target                                        */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    // A line of violet grit skating over the stone to where it is going.
    const n = this._travel.tick(dt, 60 * settings.global.particleCount);
    for (let i = 0; i < n; i++) {
      _emit.position.copy(this.position).setY(0.06);
      _emit.direction.copy(this.direction).negate().setY(0.7).normalize();
      _emit.radius = 0.12;
      _emit.speed = 2.6;
      _emit.speedVariance = 0.5;
      _emit.spread = 0.6;
      _emit.size = 0.035;
      _emit.sizeVariance = 0.5;
      _emit.life = 0.4;
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

    // The first socket stands behind the body, as seen from the caster.
    this.yaw = Math.atan2(-this.direction.z, this.direction.x) + Math.PI + (Math.random() - 0.5) * 0.4;

    // Deal the stones out, and shuffle the order they come in.
    const order = this.stones.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    this.stones.forEach((stone, i) => {
      stone.reset();
      stone.variant = Math.floor(Math.random() * this.variants.length);
      stone.mesh.geometry = this.variants[stone.variant].geometry;
      stone.seed = Math.random() * 10;
      stone.size = 1 + (Math.random() * 2 - 1) * c.stoneSizeVariance;
      stone.hover = Math.random() * 2 - 1;
      stone.spin = Math.random() * TAU;
      stone.order = order[i];
      stone.material.userData.uniforms.uSeed.value = stone.seed;
    });

    this.circle.visible = true;
    this._plan(c);
    this.position.set(this.target.x, 1.5, this.target.z);
  }

  /* ------------------------------------------------------------------ */
  /* the plan                                                            */
  /* ------------------------------------------------------------------ */

  /** Where every socket is, and when every beat lands. Pure — called every frame. */
  _plan(c) {
    const N = clamp(Math.round(c.stones), 3, MAX_SOCKETS);
    this.count = N;
    const R = c.zoneRadius;

    for (let i = 0; i < MAX_SOCKETS; i++) {
      const stone = this.stones[i];
      // The circle shader's frame: its +y is the world's −z.
      const a = this.yaw + (i / N) * TAU;
      stone.socket.set(this.target.x + Math.cos(a) * R, 0, this.target.z - Math.sin(a) * R);
      stone.openAt = c.drawTime * 0.4 + i * c.socketStagger;
      stone.riseAt = c.drawTime + i * c.riseStagger;
    }

    const allRisen = c.drawTime + (N - 1) * c.riseStagger + c.riseTime;
    this.aimAt = allRisen + c.hoverTime;
    this.launchStart = this.aimAt + c.aimTime;

    // The order they come in, compacted to the stones actually standing.
    let rank = 0;
    let lastHit = 0;
    for (let k = 0; k < MAX_SOCKETS; k++) {
      for (let i = 0; i < N; i++) {
        const stone = this.stones[i];
        if (stone.order !== k) continue;
        if (!stone.launched) stone.launchAt = this.launchStart + rank * c.launchStagger;
        rank++;
        const hitAt = stone.launched ? stone.launchedAt + c.flightTime : stone.launchAt + c.flightTime;
        lastHit = Math.max(lastHit, hitAt);
      }
    }
    if (!this.finaled) this.finaleAt = lastHit + c.finaleDelay;
    this.endAt = this.finaleAt + c.afterTime;
  }

  /** Where the stones are going, now: the body's middle, wherever it has got to. */
  _aimPoint(c, out) {
    const victim = this.victim;
    if (victim) {
      if (this.taken && victim.bodyPoint(out)) {
        out.y = Math.max(0.35, out.y);
        return out;
      }
      if (victim.alive) return out.set(victim.position.x, c.aimHeight, victim.position.z);
    }
    return out.set(this.target.x, c.aimHeight * 0.6, this.target.z);
  }

  /* ------------------------------------------------------------------ */
  /* the rite                                                            */
  /* ------------------------------------------------------------------ */

  /** @param {number} t 0..1 the rite, 1..2 the circle and the dust going */
  onFade(dt, t) {
    const c = this.config;
    this.fieldAge += dt;
    const age = this.fieldAge;
    const fading = t > 1 ? saturate(t - 1) : 0;

    // Somebody stood it back up (T), or something else took it.
    const victim = this.victim;
    if (victim && (victim.state === 'gone' || victim.state === 'frozen' || (this.taken && victim.alive))) {
      this.victim = null;
      this.taken = false;
    }
    if (this.victim && this.taken && age < this.endAt) this.victim.hold();

    this._plan(c);
    this._aimPoint(c, this.aim);

    for (let i = 0; i < this.count; i++) this._stoneFrame(this.stones[i], dt, c, age);
    for (let i = this.count; i < MAX_SOCKETS; i++) this.stones[i].mesh.visible = false;

    if (!this.finaled && age >= this.finaleAt) this._finale(c);

    this._shardFrame(dt);
    this._ambient(dt, c, age);
    this._circleFrame(dt, c, age, fading);
    this._dress(c);

    this.position.set(this.target.x, 1.5, this.target.z);
  }

  /* ---- one stone ---- */

  _stoneFrame(stone, dt, c, age) {
    const mesh = stone.mesh;
    stone.flare = Math.max(0, stone.flare - dt * 3);
    stone.flash = Math.max(0, stone.flash - dt * 5);
    stone.open = Easing.outCubic(saturate((age - stone.openAt) / Math.max(0.02, c.socketOpen)));
    stone.spent = stone.hit ? Math.min(1, stone.spent + dt * 2) : 0;

    if (stone.hit || age < stone.riseAt) {
      mesh.visible = false;
      return;
    }

    if (!stone.risen) {
      stone.risen = true;
      this._riseFx(stone, c);
    }

    const size = c.stoneSize * stone.size;
    const hoverY = c.hoverHeight + stone.hover * c.hoverVariance;
    const spinAngle = stone.spin + age * c.hoverSpin * (stone.order & 1 ? -1 : 1);

    /* ---- up out of the floor, overshooting, settling ---- */
    const rise = saturate((age - stone.riseAt) / Math.max(0.05, c.riseTime));
    const settle = Easing.outBack(rise);
    const over = c.riseOvershoot * Math.sin(Math.PI * saturate(rise * 1.2)) * (1 - rise);
    const bob = c.hoverBob * Math.sin(age * 2.1 + stone.seed * 3) * rise;
    _p.copy(stone.socket);
    _p.y = -size * 0.6 + (hoverY + size * 0.6) * settle + over + bob;

    // Upright, turning about its own axis — faster while it is still coming up.
    _qs.setFromAxisAngle(UP, spinAngle + (1 - rise) * 2.5);

    /* ---- the aim: turn the point on the body and draw back ---- */
    const aimK = Easing.inOutCubic(saturate((age - this.aimAt) / Math.max(0.05, c.aimTime)));
    _d.subVectors(this.aim, _p).normalize();
    if (aimK > 0) {
      _qa.setFromUnitVectors(UP, _d).multiply(_qs);
      stone.quaternion.copy(_qs).slerp(_qa, aimK);
      _p.addScaledVector(_d, -c.windup * aimK);
      if (aimK >= 1) {
        const k = c.tremble;
        _p.x += (Math.random() - 0.5) * k * 2;
        _p.y += (Math.random() - 0.5) * k * 2;
        _p.z += (Math.random() - 0.5) * k * 2;
      }
    } else {
      stone.quaternion.copy(_qs);
    }

    /* ---- the charge ---- */
    const hovered = saturate((age - stone.riseAt - c.riseTime) / Math.max(0.05, c.hoverTime + c.aimTime));
    stone.charge = c.chargeGlow * (0.15 * rise + 0.85 * smoothstep(0, 1, hovered));

    /* ---- the flight ---- */
    if (!stone.launched && age >= stone.launchAt) {
      stone.launched = true;
      stone.launchedAt = age;
      stone.from.copy(_p);
      stone.flash = 1;
      this._launchFx(stone, c);
    }
    if (stone.launched) {
      const x = saturate((age - stone.launchedAt) / Math.max(0.03, c.flightTime));
      const e = x * x * (1.6 - 0.6 * x);
      // Stopping short of the middle, on the side it came from.
      _a.subVectors(this.aim, stone.from).normalize();
      _b.copy(this.aim).addScaledVector(_a, -c.stopShort);
      _p.lerpVectors(stone.from, _b, e);
      stone.dir.copy(_a);
      _qs.setFromAxisAngle(UP, spinAngle + (age - stone.launchedAt) * c.flightSpin);
      _qa.setFromUnitVectors(UP, _a);
      stone.quaternion.copy(_qa).multiply(_qs);
      stone.charge = c.chargeGlow * 1.2;
      this._trail(stone, dt, _p);
      if (x >= 1) {
        stone.position.copy(_p);
        this._smash(stone, c);
        mesh.visible = false;
        return;
      }
    }

    stone.position.copy(_p);
    mesh.position.copy(_p);
    mesh.quaternion.copy(stone.quaternion);
    mesh.scale.setScalar(size);
    mesh.updateMatrix();
    mesh.visible = true;

    const u = stone.material.userData.uniforms;
    stone.material.userData.sync();
    u.uCharge.value = stone.charge;
    u.uFlash.value = stone.flash;
  }

  /* ---- the beats' effects ---- */

  /** Up through the floor: a crack, a ring of dust, chips thrown up. */
  _riseFx(stone, c) {
    const g = settings.global;
    const time = frame.uTime.value;
    stone.flare = 1;
    this.ctx.decals.spawn(DecalType.CRACK, stone.socket, {
      radius: c.socketRadius * 1.6,
      life: 2.6 + c.afterTime,
      intensity: 0.7,
      colorA: getColor(c.colorGlow),
      colorB: getColor(c.colorDeep)
    });
    this.ctx.decals.spawn(DecalType.DUSTRING, stone.socket, {
      radius: c.socketRadius * 2.4,
      life: 0.9,
      intensity: 0.6,
      colorA: getColor(c.colorDust),
      colorB: getColor(c.colorDeep)
    });

    _emit.position.copy(stone.socket).setY(0.05);
    _emit.direction.copy(UP);
    _emit.radius = c.socketRadius * 0.6;
    _emit.speed = 4.5;
    _emit.speedVariance = 0.5;
    _emit.spread = 0.55;
    _emit.size = 0.05;
    _emit.sizeVariance = 0.6;
    _emit.life = 1.0;
    _emit.lifeVariance = 0.4;
    _emit.spin = 8;
    _emit.tint = null;
    _emit.time = time;
    this.chips.emit(Math.round(14 * g.particleCount), _emit);
    _emit.speed = 1.0;
    _emit.spread = 0.9;
    _emit.size = 0.45;
    _emit.life = 1.1;
    _emit.spin = 1;
    this.dust.emit(Math.round(4 * g.particleCount), _emit);
    _emit.speed = 5;
    _emit.size = 0.03;
    _emit.life = 0.45;
    _emit.spin = 0;
    this.sparks.emit(Math.round(14 * g.particleCount), _emit);

    this.lightBoost = Math.max(this.lightBoost, 4 * g.explosionIntensity);
    this.ctx.shake.add(0.05 * g.explosionIntensity * g.cameraShake, 4, 26);
  }

  _launchFx(stone, c) {
    const g = settings.global;
    stone.flare = 1;
    this._circleState.flare = Math.max(this._circleState.flare, 0.4);
    _emit.position.copy(stone.from);
    _emit.direction.copy(stone.from).sub(this.aim).normalize();
    _emit.radius = 0.1;
    _emit.speed = 0;
    _emit.spread = 0;
    _emit.size = 0.9 * c.stoneSize;
    _emit.sizeVariance = 0.2;
    _emit.life = 0.14;
    _emit.lifeVariance = 0.2;
    _emit.spin = 3;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.glints.emit(1, _emit);
    this.ctx.shake.add(0.03 * g.explosionIntensity * g.cameraShake, 5, 30);
  }

  /** Motes and sparks streaming off a stone in flight. */
  _trail(stone, dt, at) {
    const n = this._charge.tick(dt, 140 * settings.global.particleCount);
    for (let i = 0; i < n; i++) {
      _emit.position.copy(at);
      _emit.direction.copy(stone.dir).negate();
      _emit.radius = 0.15;
      _emit.speed = 2;
      _emit.speedVariance = 0.6;
      _emit.spread = 0.4;
      _emit.size = 0.05;
      _emit.sizeVariance = 0.5;
      _emit.life = 0.35;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = frame.uTime.value;
      if (i & 1) this.motes.emit(1, _emit);
      else this.sparks.emit(1, _emit);
    }
  }

  /** A stone breaks on the body. */
  _smash(stone, c) {
    const g = settings.global;
    const time = frame.uTime.value;
    stone.hit = true;
    const P = stone.position;
    const dir = stone.dir;

    /* ---- the body ---- */
    const victim = this.victim;
    if (victim) {
      if (!this.taken) {
        if (victim.alive) {
          _d.copy(dir).setY(0);
          if (_d.lengthSq() < 1e-6) _d.set(1, 0, 0);
          _d.normalize();
          victim.kill(_d.x, _d.z, c.hit);
          this.taken = true;
        } else if (victim.state === 'dead') {
          this.taken = true;
        } else {
          this.victim = null;
        }
      } else {
        victim.shove?.(dir.x * c.shove, c.shoveLift, dir.z * c.shove);
      }
    }

    /* ---- the pieces ---- */
    _d.copy(dir).negate();
    this._spawnShards(P, _d, Math.round(c.shards), c.shardSpeed, 0.9, c.shardSize * stone.size, c);

    _emit.position.copy(P);
    _emit.direction.copy(dir).negate().addScaledVector(UP, 0.4).normalize();
    _emit.radius = 0.12;
    _emit.speed = 6;
    _emit.speedVariance = 0.6;
    _emit.spread = 1;
    _emit.size = 0.05;
    _emit.sizeVariance = 0.6;
    _emit.life = 1.2;
    _emit.lifeVariance = 0.4;
    _emit.spin = 10;
    _emit.tint = null;
    _emit.time = time;
    this.chips.emit(Math.round(c.chipCount * g.particleCount), _emit);
    _emit.speed = 9;
    _emit.size = 0.035;
    _emit.life = 0.45;
    _emit.spin = 0;
    this.sparks.emit(Math.round(c.sparkCount * g.particleCount), _emit);
    _emit.speed = 1.4;
    _emit.spread = 0.9;
    _emit.size = 0.55;
    _emit.sizeVariance = 0.4;
    _emit.life = 1.3;
    _emit.spin = 1.2;
    this.dust.emit(Math.round(c.dustCount * g.particleCount), _emit);
    _emit.speed = 0;
    _emit.spread = 0;
    _emit.size = 1.4;
    _emit.life = 0.13;
    _emit.spin = 3;
    this.glints.emit(1, _emit);

    this._circleState.flare = Math.max(this._circleState.flare, 1);
    this.lightBoost = Math.max(this.lightBoost, c.impactLight * g.explosionIntensity);
    this.ctx.shake.add(c.impactShake * g.explosionIntensity * g.cameraShake, 3, 24);
  }

  /** The last stone has broken: the circle goes off. */
  _finale(c) {
    const g = settings.global;
    const time = frame.uTime.value;
    this.finaled = true;
    this.finaleAt = this.fieldAge;

    if (this.victim && this.taken) this.victim.shove?.(0, c.finaleLift, 0);

    const P = this.aim;
    this._spawnShards(P, UP, Math.round(c.finaleShards), c.shardSpeed * 1.2, 1.6, c.shardSize * 0.8, c);

    _emit.position.copy(P);
    _emit.direction.copy(UP);
    _emit.radius = 0.3;
    _emit.speed = 8;
    _emit.speedVariance = 0.6;
    _emit.spread = 1;
    _emit.size = 0.05;
    _emit.sizeVariance = 0.6;
    _emit.life = 1.4;
    _emit.lifeVariance = 0.4;
    _emit.spin = 10;
    _emit.tint = null;
    _emit.time = time;
    this.chips.emit(Math.round(c.chipCount * 1.5 * g.particleCount), _emit);
    _emit.speed = 12;
    _emit.size = 0.04;
    _emit.life = 0.6;
    _emit.spin = 0;
    this.sparks.emit(Math.round(c.sparkCount * 2 * g.particleCount), _emit);
    _emit.speed = 2.2;
    _emit.size = 0.8;
    _emit.life = 1.6;
    _emit.spin = 1.2;
    this.dust.emit(Math.round(c.dustCount * 2 * g.particleCount), _emit);
    _emit.speed = 0;
    _emit.spread = 0;
    _emit.size = 3.2;
    _emit.life = 0.18;
    _emit.spin = 2;
    this.glints.emit(1, _emit);

    _p.set(this.target.x, 0, this.target.z);
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _p, {
      radius: c.zoneRadius + 1.2,
      life: 0.6,
      intensity: 0.7,
      width: 0.05,
      colorA: getColor(c.colorCharge),
      colorB: getColor(c.colorDeep)
    });
    this.ctx.decals.spawn(DecalType.CRACK, _p, {
      radius: 2.2,
      life: c.afterTime + c.fadeTime + 1.5,
      intensity: 0.9,
      colorA: getColor(c.colorGlow),
      colorB: getColor(c.colorDeep)
    });

    this._circleState.flare = 1.6;
    this.lightBoost = Math.max(this.lightBoost, c.finaleLight * g.explosionIntensity);
    this.ctx.shake.add(c.finaleShake * g.explosionIntensity * g.cameraShake, 2.5, 20);
    if (c.finaleFlash > 0) this.ctx.flash.trigger(getColor(c.colorGlow), c.finaleFlash * g.explosionIntensity);
  }

  /* ---- the pieces ---- */

  _spawnShards(at, dir, count, speed, cone, size, c) {
    for (let i = 0; i < count; i++) {
      const shard = this.shards[this.shardNext];
      this.shardNext = (this.shardNext + 1) % MAX_SHARDS;
      this.shardCount = Math.min(MAX_SHARDS, this.shardCount + 1);
      _a.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      shard.position.copy(at).addScaledVector(_a, 0.15);
      shard.velocity.copy(dir).addScaledVector(_a, cone).normalize().multiplyScalar(speed * (0.4 + Math.random() * 0.8));
      shard.velocity.y += 1.5 + Math.random() * 2;
      shard.quaternion.setFromAxisAngle(_a, Math.random() * TAU);
      shard.axis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      shard.spin = 6 + Math.random() * 14;
      shard.size = size * (0.35 + Math.random() * 0.9);
      shard.age = 0;
      shard.life = c.shardLife * (0.7 + Math.random() * 0.6);
      shard.resting = false;
    }
  }

  _shardFrame(dt) {
    let n = 0;
    for (let i = 0; i < MAX_SHARDS; i++) {
      const shard = this.shards[i];
      if (shard.age >= shard.life) continue;
      shard.age += dt;
      if (shard.age >= shard.life) continue;

      const half = shard.size * 0.3;
      if (!shard.resting) {
        shard.velocity.y -= 16 * dt;
        shard.velocity.multiplyScalar(1 - 0.4 * dt);
        shard.position.addScaledVector(shard.velocity, dt);
        if (shard.position.y < half) {
          shard.position.y = half;
          if (Math.abs(shard.velocity.y) < 1.2) {
            shard.resting = true;
          } else {
            shard.velocity.y = -shard.velocity.y * 0.32;
            shard.velocity.x *= 0.55;
            shard.velocity.z *= 0.55;
            shard.spin *= 0.5;
          }
        }
        _q.setFromAxisAngle(shard.axis, shard.spin * dt);
        shard.quaternion.premultiply(_q);
      }

      // They lie there a moment, then sink into the floor and are gone.
      const left = shard.life - shard.age;
      const melt = saturate(left / 0.6);
      _p.copy(shard.position);
      if (shard.resting) _p.y -= (1 - melt) * shard.size * 0.6;
      _s.setScalar(shard.size * (0.4 + 0.6 * melt) * Math.min(1, shard.age * 20));
      _m.compose(_p, shard.quaternion, _s);
      this.shardMesh.setMatrixAt(n++, _m);
    }
    this.shardMesh.count = n;
    this.shardMesh.visible = n > 0;
    this.shardMesh.instanceMatrix.needsUpdate = true;
    if (n) {
      this.shardMaterial.userData.sync();
      const u = this.shardMaterial.userData.uniforms;
      u.uCharge.value = 0.35;
      u.uFlash.value = 0;
    }
  }

  /* ---- the air round it ---- */

  _ambient(dt, c, age) {
    const g = settings.global;
    const time = frame.uTime.value;

    // Motes drawn up out of every open socket, and in toward its stone.
    const motes = this._motes.tick(dt, 22 * this.count * g.particleCount);
    for (let i = 0; i < motes; i++) {
      const stone = this.stones[i % this.count];
      if (stone.open < 0.3 || stone.launched) continue;
      const a = Math.random() * TAU;
      const r = c.socketRadius * (0.5 + Math.random() * 0.6);
      _emit.position.copy(stone.socket).set(stone.socket.x + Math.cos(a) * r, 0.05, stone.socket.z + Math.sin(a) * r);
      _emit.direction.copy(UP);
      _emit.radius = 0.02;
      _emit.speed = 1.2 + (stone.risen ? 1.2 : 0);
      _emit.speedVariance = 0.5;
      _emit.spread = 0.25;
      _emit.size = 0.035;
      _emit.sizeVariance = 0.5;
      _emit.life = 1.0;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.motes.emit(1, _emit);
    }

    // The body under the lock, before anything has hit it: a faint shimmer.
    if (!this.taken && age > 0.2 && age < this.launchStart) {
      const lock = this._lock.tick(dt, 18 * g.particleCount);
      for (let i = 0; i < lock; i++) {
        const a = Math.random() * TAU;
        _emit.position.set(this.target.x + Math.cos(a) * 0.7, 0.05, this.target.z + Math.sin(a) * 0.7);
        _emit.direction.copy(UP);
        _emit.radius = 0.05;
        _emit.speed = 1.6;
        _emit.speedVariance = 0.4;
        _emit.spread = 0.1;
        _emit.size = 0.03;
        _emit.sizeVariance = 0.4;
        _emit.life = 0.9;
        _emit.lifeVariance = 0.3;
        _emit.spin = 0;
        _emit.tint = null;
        _emit.time = time;
        this.sparks.emit(1, _emit);
      }
    }
  }

  /* ---- the circle ---- */

  _circleFrame(dt, c, age, fading) {
    const s = this._circleState;
    const R = Math.max(0.5, c.zoneRadius);
    s.radius = R;
    s.socketRadius = c.socketRadius;
    s.quad = (R + c.socketRadius * 1.6 + 0.4) * 2;
    s.count = this.count;
    s.yaw = this.yaw;
    s.draw = Easing.outCubic(saturate(age / Math.max(0.05, c.drawTime)));
    s.flare = Math.max(0, s.flare - dt * 2.5);
    let left = 0;
    for (let i = 0; i < this.count; i++) if (!this.stones[i].hit) left++;
    s.converge = smoothstep(this.aimAt, this.launchStart, age) * (left > 0 ? 1 : 0);
    s.lock = smoothstep(0, 0.4, age) * (1 - smoothstep(this.finaleAt, this.finaleAt + 0.35, age));
    s.pulse = this.finaled ? saturate((age - this.finaleAt) / 0.7) : 0;
    if (s.pulse >= 1) s.pulse = 0;
    // The rite burns down after the finale, and out in the fade.
    const after = this.finaled ? 1 - 0.55 * smoothstep(this.finaleAt, this.endAt, age) : 1;
    s.fade = after * (1 - fading);
    this.circle.position.set(this.target.x, 0.014, this.target.z);
    this.circle.scale.set(s.quad, 1, s.quad);
    this.circleMaterial.userData.sync(s);
    this.circle.visible = s.fade > 0.001;
  }

  /** The rite's light hangs over the circle, not inside a stone. */
  lightShimmer() {
    return 0.85 + 0.15 * Math.sin(this.age * 17.0) * Math.sin(this.age * 5.3);
  }

  /* ---- the look of every particle system, every frame ---- */

  _dress(c) {
    const g = settings.global;
    {
      const u = this.sparks.uniforms;
      this.sparks.setGradient(getColor('#ffffff'), getColor(c.colorSpark), getColor(c.colorGlow), getColor(c.colorDeep));
      u.uGravity.value.set(0, -7, 0);
      u.uDrag.value = 1.5;
      u.uTurbulence.value = 0.15;
      u.uStretch.value = 0.06;
      u.uEndSize.value = 0.3;
      u.uFadeOut.value = 0.5;
      u.uGlow.value = 2.2 * g.glow;
      u.uOpacity.value = 1;
    }
    {
      const u = this.chips.uniforms;
      this.chips.setGradient(getColor(c.colorPale), getColor(c.colorStone), getColor(c.colorStone), getColor(c.colorDeep));
      u.uGravity.value.set(0, -16, 0);
      u.uDrag.value = 0.4;
      u.uTurbulence.value = 0;
      u.uEndSize.value = 0.8;
      u.uFadeOut.value = 0.25;
      u.uGlow.value = 0.9;
      u.uOpacity.value = 1;
    }
    {
      const u = this.motes.uniforms;
      this.motes.setGradient(getColor('#ffffff'), getColor(c.colorSocket), getColor(c.colorGlow), getColor(c.colorDeep));
      u.uGravity.value.set(0, 0.5, 0);
      u.uDrag.value = 1.6;
      u.uTurbulence.value = 0.6 * g.turbulence;
      u.uTurbFrequency.value = 1.2;
      u.uEndSize.value = 0.2;
      u.uFadeIn.value = 0.1;
      u.uFadeOut.value = 0.5;
      u.uGlow.value = 2.0 * g.glow;
      u.uOpacity.value = 1;
    }
    {
      const u = this.dust.uniforms;
      this.dust.setGradient(getColor(c.colorDust), getColor(c.colorDust), getColor(c.colorDeep), getColor(c.colorDeep));
      u.uGravity.value.set(0, 0.3, 0);
      u.uDrag.value = 2.2;
      u.uTurbulence.value = 0.5 * g.turbulence;
      u.uTurbFrequency.value = 0.9;
      u.uEndSize.value = 2.4;
      u.uFadeIn.value = 0.08;
      u.uFadeOut.value = 0.5;
      u.uGlow.value = 0.3;
      u.uOpacity.value = 0.5;
    }
    {
      const u = this.glints.uniforms;
      this.glints.setGradient(getColor('#ffffff'), getColor(c.colorSocket), getColor(c.colorGlow), getColor(c.colorGlow));
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
