import { CylinderGeometry, Group, Matrix4, Mesh, PlaneGeometry, Quaternion, SkinnedMesh, Vector3 } from 'three';
import { Ability } from './Ability.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { DecalType } from '../effects/GroundDecals.js';
import { instanceWolf, WOLF_BITE_AT, WOLF_LANDING_AT, WOLF_TAKEOFF_AT } from '../assets/WolfRig.js';
import {
  createColumnMaterial,
  createRiftMaterial,
  createRiftOccluderMaterial,
  createRiftWarpMaterial,
  createSigilMaterial,
  createWolfDepthMaterial,
  createWolfHaloMaterial,
  createWolfLook,
  createWolfMaterial
} from '../materials/WolfMaterials.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { Easing, saturate, smoothstep } from '../utils/math.js';

const TAU = Math.PI * 2;
/** Afterimages trailing the wolf, at most. The editor picks how many draw. */
const MAX_ECHOES = 4;

const UP = new Vector3(0, 1, 0);
const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _p = new Vector3();
const _v = new Vector3();
const _x = new Vector3();
const _y = new Vector3();
const _z = new Vector3();
const _m = new Matrix4();
const _q = new Quaternion();
const _roll = new Quaternion();
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

/* ==================================================================== */
/* A rift                                                                */
/* ==================================================================== */

/**
 * One tear in the air: the vortex, the depth-only disc that makes it a hole,
 * its refraction, and the sigil on the floor it stands over.
 */
class Rift {
  constructor(group) {
    this.centre = new Vector3();
    this.normal = new Vector3(0, 0, 1);
    this.plane = { normal: this.normal, w: 0 };
    this.seed = 0;
    this.radius = 1;
    this.open = 0;
    this.spin = 0;
    this.flare = 0;
    this.rune = 0;
    this.draw = 0;
    this.fade = 1;
    this.light = null;
    this._state = { quad: 4, radius: 1, open: 0, spin: 0, flare: 0, rune: 0, fade: 1, seed: 0 };
    this._sigilState = { quad: 4, radius: 1.4, draw: 0, pulse: -1, fade: 1, seed: 0, lines: 0.55, ground: null };

    const quad = new PlaneGeometry(1, 1);

    this.occluderMaterial = createRiftOccluderMaterial();
    this.occluder = new Mesh(quad, this.occluderMaterial);
    this.occluder.name = 'WolfRiftOccluder';
    this.occluder.layers.set(LAYER.VFX);
    // Transparent only so it is drawn after the stage, which stays visible behind it.
    this.occluderMaterial.transparent = true;
    this.occluder.renderOrder = 4;
    this.occluder.frustumCulled = false;

    this.material = createRiftMaterial();
    this.disc = new Mesh(quad, this.material);
    this.disc.name = 'WolfRift';
    this.disc.layers.set(LAYER.VFX);
    this.disc.renderOrder = 5;
    this.disc.frustumCulled = false;

    this.warpMaterial = createRiftWarpMaterial();
    this.warp = new Mesh(quad, this.warpMaterial);
    this.warp.layers.set(LAYER.DISTORTION);
    this.warp.frustumCulled = false;

    const flat = new PlaneGeometry(1, 1);
    flat.rotateX(-Math.PI / 2);
    this.sigilMaterial = createSigilMaterial();
    this.sigil = new Mesh(flat, this.sigilMaterial);
    this.sigil.name = 'WolfRiftSigil';
    this.sigil.layers.set(LAYER.VFX);
    this.sigil.renderOrder = 3;
    this.sigil.frustumCulled = false;

    group.add(this.occluder, this.disc, this.warp, this.sigil);
    this.hide();
  }

  hide() {
    this.occluder.visible = false;
    this.disc.visible = false;
    this.warp.visible = false;
    this.sigil.visible = false;
  }

  reset() {
    this.seed = Math.random() * 10;
    this.open = 0;
    this.spin = Math.random() * TAU;
    this.flare = 0;
    this.rune = 0;
    this.draw = 0;
    this.fade = 1;
  }

  /** Stand it at `centre`, its face toward `normal` (flat, unit). */
  place(centre, normal) {
    this.centre.copy(centre);
    this.normal.copy(normal);
    this.plane.w = this.normal.dot(this.centre);
    _x.crossVectors(UP, this.normal).normalize();
    _m.makeBasis(_x, UP, this.normal);
    for (const mesh of [this.occluder, this.disc, this.warp]) {
      mesh.position.copy(centre);
      mesh.quaternion.setFromRotationMatrix(_m);
    }
  }

  update(dt, c) {
    this.flare = Math.max(0, this.flare - this.flare * 5 * dt - 0.2 * dt);
    const live = this.fade > 0.001;
    const quad = this.radius * 2 * 1.85;
    const s = this._state;
    s.quad = quad;
    s.radius = this.radius;
    s.open = this.open;
    s.spin = this.spin;
    s.flare = this.flare;
    s.rune = this.rune;
    s.fade = this.fade;
    s.seed = this.seed;

    const showing = live && (this.open > 0.002 || this.rune > 0.002);
    this.disc.visible = showing;
    this.disc.scale.set(quad, quad, 1);
    this.material.userData.sync(s);

    this.occluder.visible = showing && this.open > 0.05;
    this.occluder.scale.copy(this.disc.scale);
    this.occluderMaterial.userData.sync(s);

    this.warp.visible = this.occluder.visible && c.warp > 0;
    this.warp.scale.copy(this.disc.scale);
    this.warpMaterial.userData.sync(s);

    const sr = c.riftSigilRadius;
    const ss = this._sigilState;
    ss.quad = sr * 2.6;
    ss.radius = sr;
    ss.draw = this.draw;
    ss.fade = this.fade * saturate(this.draw * 3);
    ss.seed = this.seed;
    ss.ground = c.colorNebula;
    this.sigil.visible = live && this.draw > 0.002;
    this.sigil.position.set(this.centre.x, 0.014, this.centre.z);
    this.sigil.scale.set(ss.quad, 1, ss.quad);
    this.sigilMaterial.userData.sync(ss);
  }
}

/* ==================================================================== */
/* A wolf                                                                */
/* ==================================================================== */

/**
 * One animal of light off the rig: its skeleton, its parts in the hologram,
 * the depth prepass and the halo riding the same skeleton. An echo is the
 * same thing without the prepass, the halo or the fur — a ghost of a pose.
 */
class SpectralWolf {
  constructor(rig, parent, { echo = false } = {}) {
    this.root = new Group();
    this.root.name = echo ? 'WolfEcho' : 'WolfRoot';
    this.frame = new Group();
    this.root.add(this.frame);
    parent.add(this.root);
    this.root.visible = false;

    this.look = createWolfLook();
    this.materials = [];
    this.halos = [];
    this.wolf = rig ? instanceWolf(rig) : null;
    if (!this.wolf) return;

    const wolf = this.wolf;
    for (const mesh of wolf.meshes) {
      const part = mesh.userData.wolfPart ?? 'body';
      const map = mesh.material?.map ?? null;
      if (echo && part !== 'body') {
        mesh.visible = false;
        continue;
      }
      const material = createWolfMaterial(this.look, rig.bind, part, map);
      mesh.material = material;
      mesh.layers.set(LAYER.VFX);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.renderOrder = part === 'fur' ? 11 : part === 'eyes' ? 12 : 9;
      this.materials.push(material);

      if (echo || part !== 'body') continue;
      // Riding the same skeleton: the nearest surface first, then the glow round it.
      const depth = new SkinnedMesh(mesh.geometry, createWolfDepthMaterial(this.look, rig.bind));
      depth.bind(mesh.skeleton, mesh.bindMatrix);
      depth.layers.set(LAYER.VFX);
      depth.renderOrder = 7;
      depth.frustumCulled = false;
      depth.position.copy(mesh.position);
      depth.quaternion.copy(mesh.quaternion);
      depth.scale.copy(mesh.scale);

      const haloMaterial = createWolfHaloMaterial(this.look, rig.bind);
      const halo = new SkinnedMesh(mesh.geometry, haloMaterial);
      halo.bind(mesh.skeleton, mesh.bindMatrix);
      halo.layers.set(LAYER.VFX);
      halo.renderOrder = 8;
      halo.frustumCulled = false;
      halo.position.copy(mesh.position);
      halo.quaternion.copy(mesh.quaternion);
      halo.scale.copy(mesh.scale);
      this.halos.push(haloMaterial);

      mesh.parent.add(depth, halo);
    }
    if (wolf.pounce) wolf.pounce.play();
    if (wolf.run) wolf.run.play();
    this.frame.add(wolf.root);
  }

  /** The two rift planes, each `(normal, w)` — or null for no cut. */
  setClip(a, b) {
    const u = this.look;
    if (a) u.uClipA.value.set(a.normal.x, a.normal.y, a.normal.z, a.w);
    else u.uClipA.value.set(0, 0, 0, 0);
    if (b) u.uClipB.value.set(b.normal.x, b.normal.y, b.normal.z, b.w);
    else u.uClipB.value.set(0, 0, 0, 0);
  }

  /**
   * Pose it: the gallop at `phase` (cycles, wrapped), the pounce at `u`
   * (0..1 of it), `w` of the way from the one to the other.
   */
  pose(phase, u, w) {
    const wolf = this.wolf;
    if (!wolf) return;
    const { pounce, run } = wolf;
    const wp = run ? w : 1;
    if (pounce) {
      const duration = pounce.getClip().duration;
      pounce.enabled = true;
      pounce.paused = false;
      pounce.time = Math.min(duration - 1e-4, Math.max(0, u * duration));
      pounce.setEffectiveWeight(wp);
    }
    if (run) {
      const duration = run.getClip().duration;
      run.enabled = true;
      run.paused = false;
      run.time = (phase - Math.floor(phase)) * duration;
      run.setEffectiveWeight(pounce ? 1 - wp : 1);
    }
    wolf.mixer.update(0);
  }

  sync(opacity, flare, worldScale) {
    this.look.uOpacity.value = opacity;
    this.look.uFlare.value = flare;
    for (const material of this.materials) material.userData.sync();
    for (const material of this.halos) material.userData.sync(worldScale);
  }
}

/* ==================================================================== */
/* The ability                                                           */
/* ==================================================================== */

/**
 * THE ASTRAL FANG — a targeted far cast: one body, run down by a wolf of
 * starlight and carried from one rift into another.
 *
 * The Abyssal Maw's principle on dry land: two openings either side of the
 * target and across the line of the cast, an animal that leaves one, takes
 * the body and goes into the other. The rifts stand on the floor, and the
 * wolf *runs*:
 *
 *   1. **The mark.** A gold compass rose writes itself into the stone under
 *      the target, and the first rift tears open beside it — a slit of light
 *      that irises out into a vortex, its rune ring and floor sigil drawing
 *      round it.
 *   2. **The charge.** The wolf gallops out of the rift, materialising through
 *      its plane behind a white-hot seam, paws planting on the stone and
 *      kicking up star dust, echoes of itself streaming behind. The gallop is
 *      played against the ground speed, so the feet do not skate.
 *   3. **The lift and the leap.** The rose throws the body up on a column of
 *      light; the wolf leaves the ground on the frame the gallop reaches its
 *      push-off — the frame the authored pounce starts on — and its arc is
 *      solved so the jaw arrives where the body is on the frame the clip
 *      snaps shut.
 *   4. **The carry.** It lands forefeet first on the frame the pounce hands
 *      back to the gallop, and runs on with the body in its jaws, hips slung
 *      under its head, heels dragging, the starlight crawling over it.
 *   5. **Gone.** Into the far rift. Wolf and body are both cut by its plane
 *      as they cross it; the body is taken on the far side and both rifts
 *      implode behind them, leaving the sigils to fade off the stone.
 *
 * As with the shark, all of it is re-solved from `settings.wolf` every frame,
 * so the editor re-plans a charge that is already under way.
 */
export class WolfAbility extends Ability {
  constructor(context) {
    super('wolf', context);
  }

  get handlesOwnHits() {
    return true;
  }

  get cameraWeight() {
    return this.u < 1 ? saturate(1 - this.u * 0.4) : 0.72;
  }

  get impactDuration() {
    const plan = this.plan;
    const close = plan ? plan.closeB + settings.wolf.closeTime + 0.15 : 0;
    return Math.max(close, settings.wolf.showTime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.wolf.fadeTime);
  }

  /** Metres per rig metre. */
  get scaleK() {
    return this.rig ? settings.wolf.length / Math.max(0.01, this.rig.length) : 1;
  }

  /* ------------------------------------------------------------------ */
  /* construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    const rig = this.ctx.models?.wolf ?? null;
    this.rig = rig;

    this.hero = new SpectralWolf(rig, this.group);
    this.echoes = [];
    for (let i = 0; i < MAX_ECHOES; i++) this.echoes.push(new SpectralWolf(rig, this.group, { echo: true }));

    this.rifts = [new Rift(this.group), new Rift(this.group)];

    /* ---- the rose under the target ---- */
    const flat = new PlaneGeometry(1, 1);
    flat.rotateX(-Math.PI / 2);
    this.sigilMaterial = createSigilMaterial();
    this.sigil = new Mesh(flat, this.sigilMaterial);
    this.sigil.name = 'WolfSigil';
    this.sigil.layers.set(LAYER.VFX);
    this.sigil.renderOrder = 3;
    this.sigil.frustumCulled = false;
    this.sigil.visible = false;
    this._sigilState = { quad: 6, radius: 2.4, draw: 0, pulse: -1, fade: 1, seed: 0, lines: 1, ground: null };

    /* ---- the column it throws the body up on ---- */
    const tube = new CylinderGeometry(1, 1, 1, 48, 1, true);
    tube.translate(0, 0.5, 0);
    this.columnMaterial = createColumnMaterial();
    this.column = new Mesh(tube, this.columnMaterial);
    this.column.name = 'WolfColumn';
    this.column.layers.set(LAYER.VFX);
    this.column.renderOrder = 10;
    this.column.frustumCulled = false;
    this.column.visible = false;

    this.group.add(this.sigil, this.column);

    /* ---- state ---- */
    this.plan = null;
    this._plan = {
      T: new Vector3(),
      s: new Vector3(),
      lat: new Vector3(),
      A: new Vector3(),
      B: new Vector3(),
      nA: new Vector3(),
      nB: new Vector3(),
      bite: new Vector3(),
      span: 5,
      h: 1,
      v: 10,
      g: 10,
      tl: 0.6,
      tb: 0.25,
      xK: 2,
      runUp: 2,
      // seconds into the wolf's own run
      tExitR: 0,
      tTakeR: 0,
      tBiteR: 0,
      tLandR: 0,
      tEntryR: 0,
      tEndR: 0,
      // seconds after the landing of the cast
      start: 0,
      tLift: 0,
      tBite: 0,
      tExit: 0,
      tEntry: 0,
      tEnd: 0,
      openA: 0,
      openB: 0,
      closeA: 0,
      closeB: 0
    };
    this.target = new Vector3();
    this.sweep = 1;
    this.socketUnit = new Vector3(0, 0, 0.45);
    /** How high the body's centre rides over the floor at a gallop, rig metres. */
    this.standUnit = 1;
    this._pawDown = [true, true, true, true];
    this.socket = new Vector3();
    this.wolfPos = new Vector3();
    this.wolfVel = new Vector3();
    this.fieldAge = 0;
    this.victim = null;
    this.held = false;
    this.victimDone = false;
    this.hips0 = new Vector3();
    this.flags = { lift: false, exit: false, takeoff: false, bite: false, land: false, entry: false, closeA: false, closeB: false };
    this._targets = [];
    this._stain = { color: '', rimColor: '', rimEmissive: 0, edgeColor: '', edgeEmissive: 0, edgeWidth: 0.08 };
    this._seamLook = { color: '', glow: 0, width: 0.08 };
    this._eye = new Vector3();

    this._trail = new RateEmitter(140);
    this._sparkle = new RateEmitter(30);
    this._eyes = new RateEmitter(60);
    this._riftDust = new RateEmitter(30);
    this._riftWisps = new RateEmitter(8);
    this._travel = new RateEmitter(60);
    this._paw = new Vector3();
  }

  createParticles() {
    const P = this.ctx.particles;
    this.sparks = P.get('wolfSpark', {
      capacity: 900,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.1
    });
    this.motes = P.get('wolfMote', {
      capacity: 1400,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.2
    });
    this.wisps = P.get('wolfWisp', {
      capacity: 220,
      shape: ParticleShape.SMOKE,
      additive: true,
      curl: true,
      softFade: 0.5
    });
    this.glints = P.get('wolfGlint', { capacity: 260, shape: ParticleShape.GLINT, additive: true });
    this.rings = P.get('wolfRing', { capacity: 24, shape: ParticleShape.RING, additive: true });
  }

  /** A ring of light thrown off a point: the shock of a crossing, a bite, a collapse. */
  _ring(at, size, life) {
    _emit.position.copy(at);
    _emit.direction.set(0, 1, 0);
    _emit.radius = 0;
    _emit.speed = 0;
    _emit.speedVariance = 0;
    _emit.spread = 0;
    _emit.size = size;
    _emit.sizeVariance = 0.05;
    _emit.life = life;
    _emit.lifeVariance = 0.05;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.rings.emit(1, _emit);
  }

  /* ------------------------------------------------------------------ */
  /* lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.fieldAge = 0;
    this.plan = null;
    this.victim = null;
    this.held = false;
    this.victimDone = false;
    for (const key of Object.keys(this.flags)) this.flags[key] = false;
    this.hero.root.visible = false;
    for (const echo of this.echoes) echo.root.visible = false;
    for (const rift of this.rifts) {
      rift.reset();
      rift.hide();
    }
    this.sigil.visible = false;
    this.column.visible = false;
    for (const emitter of [this._trail, this._sparkle, this._eyes, this._riftDust, this._riftWisps, this._travel]) emitter.reset();
  }

  onDestroy() {
    this._letGo();
    for (const rift of this.rifts) {
      this.ctx.lights.release(rift.light);
      rift.light = null;
      rift.hide();
    }
    this.hero.root.visible = false;
    for (const echo of this.echoes) echo.root.visible = false;
    this.sigil.visible = false;
    this.column.visible = false;
    this.plan = null;
  }

  _letGo() {
    const victim = this.victim;
    if (victim) {
      victim.unpin();
      victim.clip(null, null);
      if (this.held) victim.release();
    }
    this.held = false;
    this.victim = null;
  }

  /* ------------------------------------------------------------------ */
  /* the cast's run to the target                                        */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    // A line of star dust skimming the stone to where it is going.
    const n = this._travel.tick(dt, 60 * settings.global.particleCount);
    for (let i = 0; i < n; i++) {
      _emit.position.copy(this.position).setY(0.1);
      _emit.direction.set(0, 1, 0);
      _emit.radius = 0.2;
      _emit.speed = 0.8;
      _emit.speedVariance = 0.5;
      _emit.spread = 0.8;
      _emit.size = 0.05;
      _emit.sizeVariance = 0.5;
      _emit.life = 0.6;
      _emit.lifeVariance = 0.3;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = frame.uTime.value;
      this.motes.emit(1, _emit);
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

    this.sweep = Math.random() < 0.5 ? 1 : -1;
    this._sigilState.seed = Math.random() * 10;

    this._measureSocket();
    this._pawDown.fill(true);
    this._solve(c);

    for (const rift of this.rifts) {
      rift.reset();
      if (!rift.light) rift.light = this.ctx.lights.acquire();
    }
    this.position.copy(this.target).setY(1.2);
  }

  /**
   * Off the clips, with the wolf at the origin facing +Z: how high it rides
   * at a gallop (its lowest paw over a whole stride), and where the jaw
   * holds the prey at the bite.
   */
  _measureSocket() {
    const hero = this.hero;
    const wolf = hero.wolf;
    if (!wolf) return;
    hero.root.position.set(0, 0, 0);
    hero.root.quaternion.identity();
    hero.frame.scale.setScalar(1);
    let low = Infinity;
    if (wolf.run) {
      for (let i = 0; i < 16; i++) {
        hero.pose(i / 16, 0, 0);
        hero.root.updateMatrixWorld(true);
        for (const paw of wolf.paws) low = Math.min(low, paw.getWorldPosition(_a).y);
      }
    }
    this.standUnit = Number.isFinite(low) ? Math.max(0.2, -low) : 1;
    hero.pose(0, WOLF_BITE_AT, 1);
    hero.root.updateMatrixWorld(true);
    this._socketWorld(this.socketUnit);
  }

  _socketWorld(out) {
    const wolf = this.hero.wolf;
    if (wolf?.upperLip && wolf.lowerLip && wolf.head) {
      wolf.upperLip.getWorldPosition(_a);
      wolf.lowerLip.getWorldPosition(_b);
      wolf.head.getWorldPosition(_c);
      return out.addVectors(_a, _b).multiplyScalar(0.5).lerp(_c, saturate(settings.wolf.socketDepth));
    }
    return out.set(0, 0, 0.45).applyMatrix4(this.hero.root.matrixWorld);
  }

  /* ------------------------------------------------------------------ */
  /* the plan                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Solve the charge against the current settings.
   *
   * Along the line rift to rift the wolf runs at one speed the whole way —
   * ground, leap, ground — so the leap is only ever a question of height.
   * The leap is ballistic from the gallop's ride height back down to it, and
   * its one free number, the gravity, is solved so the mouth — offset from
   * the body as the clip has it at the bite, pitched along the arc there —
   * is at `biteHeight` over the target `biteAt` of the way through it. Pitch
   * and gravity depend on each other; four rounds settle it. Where the
   * solve has to give, the bite point is read back off the arc, so the body
   * is always thrown to where the jaw actually is.
   */
  _solve(c) {
    const P = this._plan;
    const k = this.scaleK;
    P.T.copy(this.target);
    P.s.copy(this.side).multiplyScalar(this.sweep).setY(0).normalize();
    P.lat.crossVectors(UP, P.s).normalize();

    const span = Math.max(c.riftRadius + 1, c.riftSpan);
    const rh = Math.max(c.riftRadius * 0.95, c.riftHeight);
    P.span = span;
    P.A.copy(P.T).addScaledVector(P.s, -span).setY(rh);
    P.B.copy(P.T).addScaledVector(P.s, span).setY(rh);
    // Each rift's face turned part way toward where the cast came from, so the
    // camera behind the caster sees into them instead of along their edge.
    P.nA.copy(P.s).addScaledVector(this.direction, -c.riftFacing).setY(0).normalize();
    P.nB.copy(P.s).negate().addScaledVector(this.direction, -c.riftFacing).setY(0).normalize();

    const h = Math.max(0.2, this.standUnit * k + c.footHeight);
    const v = Math.max(2, c.runSpeed);
    const tl = Math.max(0.25, c.leapTime);
    const tb = tl * Math.min(0.6, Math.max(0.15, c.biteAt));
    const sz = this.socketUnit.z * k;
    const sy = this.socketUnit.y * k;
    const damp = c.arcPitch;
    let pitch = 0;
    let g = 10;
    for (let i = 0; i < 4; i++) {
      const cp = Math.cos(pitch);
      const sp = Math.sin(pitch);
      const lift = sz * sp + sy * cp;
      g = Math.max(c.minArc, (2 * (c.biteHeight - lift - h)) / (tb * (tl - tb)));
      pitch = Math.atan2(g * (tl * 0.5 - tb) * damp, v);
    }
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const along = sz * cp - sy * sp;
    // Where it leaves the ground, metres past the near rift's face.
    const xK = Math.max(0.6, span - along - v * tb);

    P.h = h;
    P.v = v;
    P.g = g;
    P.tl = tl;
    P.tb = tb;
    P.xK = xK;
    P.runUp = Math.max(0.5, c.runUp);

    P.tExitR = P.runUp / v;
    P.tTakeR = (P.runUp + xK) / v;
    P.tBiteR = P.tTakeR + tb;
    P.tLandR = P.tTakeR + tl;
    P.tEntryR = (P.runUp + 2 * span) / v;
    P.tEndR = P.tEntryR + Math.max(c.runOut, c.length * 1.2 + 1) / v;

    // Where the jaw really is at the bite, off the arc as solved.
    const yt = h + 0.5 * g * tb * (tl - tb);
    P.bite.copy(P.T).addScaledVector(P.s, xK + v * tb + along - span).setY(yt + sz * sp + sy * cp);

    P.tLift = c.liftDelay;
    P.tBite = P.tLift + Math.max(0.15, c.hangTime);
    P.start = P.tBite - P.tBiteR;
    P.tExit = P.start + P.tExitR;
    P.tEntry = P.start + P.tEntryR;
    P.tEnd = P.start + P.tEndR;
    P.openA = Math.min(c.riftDelay, P.tExit - c.openTime * 0.6);
    P.openB = Math.min(P.tBite - c.farRiftLead, P.tEntry - c.openTime * 0.8);
    // The near one shuts once the tail is through it, the far one once the body is.
    P.closeA = P.tExit + (c.length * 1.1) / v + c.closeDelay;
    P.closeB = P.tEnd + c.closeDelay;
    this.plan = P;
    return P;
  }

  /** The body's centre and velocity `tau` seconds into the wolf's run. */
  _path(tau, outP, outV) {
    const P = this._plan;
    const x = -P.runUp + P.v * tau;
    outP.copy(P.T).addScaledVector(P.s, x - P.span).setY(P.h);
    outV.copy(P.s).multiplyScalar(P.v);
    const tl = tau - P.tTakeR;
    if (tl > 0 && tl < P.tl) {
      outP.y = P.h + 0.5 * P.g * tl * (P.tl - tl);
      outV.y = P.g * (P.tl * 0.5 - tl);
    }
  }

  /** Where in the clip (0..1) the wolf is `tau` into its run: the bite frame on the bite, continuous rate. */
  _clipAt(tau, tauBite, tEnd) {
    const t1 = Math.max(1e-3, tauBite);
    const t2 = Math.max(1e-3, tEnd - tauBite);
    const r1 = WOLF_BITE_AT / t1;
    const r2 = (1 - WOLF_BITE_AT) / t2;
    const mid = (2 * r1 * r2) / (r1 + r2);
    const m0 = Math.min(3 * r1, Math.max(0, 2 * r1 - mid));
    const m2 = Math.min(3 * r2, Math.max(0, 2 * r2 - mid));
    const seg = (x, h, y0, y1, s0, s1) => {
      const x2 = x * x;
      const x3 = x2 * x;
      return (2 * x3 - 3 * x2 + 1) * y0 + (x3 - 2 * x2 + x) * h * s0 + (-2 * x3 + 3 * x2) * y1 + (x3 - x2) * h * s1;
    };
    if (tau <= 0) return 0;
    if (tau >= tEnd) return 1;
    if (tau < tauBite) return seg(tau / t1, t1, 0, WOLF_BITE_AT, m0, mid);
    return seg((tau - tauBite) / t2, t2, WOLF_BITE_AT, 1, mid, m2);
  }

  /* ------------------------------------------------------------------ */
  /* the show                                                            */
  /* ------------------------------------------------------------------ */

  onFade(dt, t) {
    const c = this.config;
    this.fieldAge += dt;
    const P = this._solve(c);
    const age = this.fieldAge;
    const fading = t > 1 ? saturate(t - 1) : 0;

    this._riftFrame(dt, c, age, fading);
    this._sigilFrame(dt, c, age, fading);
    this._wolfFrame(dt, c, age);
    this._victimFrame(dt, c, age);
    this._ambient(dt, c);
    this._dress(c);
    this._lights(dt, c);

    // The camera: the target until the bite, then after the wolf to the far rift.
    const follow = smoothstep(P.tBite, P.tEntry, age);
    this.position.copy(P.T).lerp(P.B, follow).setY(1.3);
  }

  /* ---- the rifts ---- */

  _riftFrame(dt, c, age, fading) {
    const P = this._plan;
    const openTime = Math.max(0.05, c.openTime);
    const closeTime = Math.max(0.05, c.closeTime);
    const centres = [P.A, P.B];
    const normals = [P.nA, P.nB];
    const opens = [P.openA, P.openB];
    const closes = [P.closeA, P.closeB];
    const flags = ['closeA', 'closeB'];

    for (let i = 0; i < 2; i++) {
      const rift = this.rifts[i];
      rift.place(centres[i], normals[i]);
      rift.radius = c.riftRadius;

      const since = age - opens[i];
      const opening = since > 0 ? Easing.outBack(saturate(since / openTime)) : 0;
      const closing = saturate((age - closes[i]) / closeTime);
      // Shut with a breath in first: it swells, then collapses.
      const breath = Math.sin(saturate(closing * 1.6) * Math.PI) * 0.12;
      const shut = Easing.inCubic(saturate((closing - 0.25) / 0.75));
      rift.open = Math.max(0, opening) * (1 + breath) * (1 - shut);
      rift.spin += dt * c.riftSwirl * (1 + 6 * closing * (1 - closing) * 4);
      rift.rune = saturate(since / (openTime * 1.4)) * (1 - smoothstep(0.3, 1, closing));
      rift.draw = saturate((since + 0.1) / (openTime * 1.6));
      rift.fade = 1 - fading;
      if (since > 0 && since - dt <= 0) this._tear(rift, c);
      if (closing >= 1 && !this.flags[flags[i]]) {
        this.flags[flags[i]] = true;
        this._implode(rift, c);
      }
      rift.update(dt, c);
    }
  }

  /** It tears: a flash of the slit, sparks off its length, a crack of air. */
  _tear(rift, c) {
    const g = settings.global;
    const time = frame.uTime.value;
    rift.flare = 1;
    for (let i = 0; i < Math.round(40 * g.particleCount); i++) {
      const y = (Math.random() - 0.5) * 2 * rift.radius * 0.8;
      _emit.position.copy(rift.centre).addScaledVector(UP, y);
      _emit.direction.copy(rift.normal).multiplyScalar(Math.random() < 0.5 ? 1 : -1).addScaledVector(_x.crossVectors(UP, rift.normal), (Math.random() - 0.5) * 2).normalize();
      _emit.radius = 0.05;
      _emit.speed = 5;
      _emit.speedVariance = 0.6;
      _emit.spread = 0.4;
      _emit.size = 0.03;
      _emit.sizeVariance = 0.5;
      _emit.life = 0.45;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.sparks.emit(1, _emit);
    }
    this.ctx.shake.add(c.riftShake * 0.6 * g.explosionIntensity * g.cameraShake, 2.4, 20);
    this.lightBoost = Math.max(this.lightBoost, c.riftLight * 0.8 * g.explosionIntensity);
  }

  /** It shuts: everything round it drawn in, one last flash at the eye. */
  _implode(rift, c) {
    const g = settings.global;
    const time = frame.uTime.value;
    _x.crossVectors(UP, rift.normal).normalize();
    const n = Math.round(36 * g.particleCount);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      const r = rift.radius * (1.3 + Math.random() * 0.4);
      _emit.position.copy(rift.centre).addScaledVector(_x, Math.cos(a) * r).addScaledVector(UP, Math.sin(a) * r);
      _emit.direction.copy(rift.centre).sub(_emit.position).normalize();
      _emit.radius = 0;
      _emit.speed = r / 0.28;
      _emit.speedVariance = 0.1;
      _emit.spread = 0.05;
      _emit.size = 0.03;
      _emit.sizeVariance = 0.4;
      _emit.life = 0.28;
      _emit.lifeVariance = 0.1;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.sparks.emit(1, _emit);
    }
    _emit.position.copy(rift.centre);
    _emit.radius = 0;
    _emit.speed = 0;
    _emit.spread = 0;
    _emit.size = 2.6;
    _emit.sizeVariance = 0.1;
    _emit.life = 0.22;
    _emit.lifeVariance = 0;
    _emit.spin = 2;
    this.glints.emit(1, _emit);
    this._ring(rift.centre, rift.radius * 0.5, 0.25);
    this.ctx.shake.add(c.riftShake * 0.5 * g.explosionIntensity * g.cameraShake, 2.8, 22);
    if (c.closeFlash > 0) this.ctx.flash.trigger(getColor(c.colorRim), c.closeFlash * g.explosionIntensity);
  }

  /* ---- the rose ---- */

  _sigilFrame(dt, c, age, fading) {
    const P = this._plan;
    const s = this._sigilState;
    const R = c.sigilRadius;
    s.quad = R * 2.6;
    s.radius = R;
    s.draw = saturate(age / Math.max(0.05, c.sigilTime));
    s.pulse = age >= P.tLift ? age - P.tLift : -1;
    // It burns out once the body is through.
    const out = smoothstep(P.tEntry, P.closeB + c.closeTime, age);
    s.fade = (1 - fading) * (1 - out * 0.55);
    s.lines = 1;
    s.ground = c.colorRim;
    this.sigil.visible = s.fade > 0.002;
    this.sigil.position.set(P.T.x, 0.016, P.T.z);
    this.sigil.scale.set(s.quad, 1, s.quad);
    this.sigilMaterial.userData.sync(s);

    // The column, from the lift until the jaw has the body.
    const life = (age - P.tLift) / Math.max(0.1, P.tBite - P.tLift + 0.25);
    const on = life > 0 && life < 1;
    this.column.visible = on && c.column > 0;
    if (on) {
      const strength = smoothstep(0, 0.08, life) * (1 - smoothstep(0.6, 1, life)) * c.column;
      this.column.position.set(P.T.x, 0, P.T.z);
      this.column.scale.set(c.columnRadius, Math.max(1, P.bite.y + 1.6), c.columnRadius);
      this.columnMaterial.userData.sync(life, strength);
    }
  }

  /* ---- the wolf ---- */

  _wolfFrame(dt, c, age) {
    const P = this._plan;
    const tau = age - P.start;
    const end = P.tEndR;
    const hero = this.hero;
    const visible = !!hero.wolf && tau > -0.05 && tau < end + 0.1;
    hero.root.visible = visible;

    // The flare: on the way out of the rift and on the bite.
    const sinceExit = tau - P.tExitR;
    const sinceBite = tau - P.tBiteR;
    const flare = Math.max(sinceExit > -0.05 ? Math.exp(-Math.max(0, sinceExit) * 7) * 0.8 : 0, sinceBite > 0 ? Math.exp(-sinceBite * 9) : 0);

    if (visible) {
      this._placeWolf(hero, tau, c, P, true);
      hero.setClip(this.rifts[0].plane, this.rifts[1].plane);
      hero.sync(1, flare * c.flareGlow, this.scaleK);
      hero.root.updateMatrixWorld(true);
      this._socketWorld(this.socket);
    }

    /* ---- the afterimages ---- */
    const count = Math.min(MAX_ECHOES, Math.max(0, Math.round(c.echoes)));
    for (let i = 0; i < MAX_ECHOES; i++) {
      const echo = this.echoes[i];
      const lagTau = tau - (i + 1) * c.echoLag;
      const on = visible && i < count && lagTau > P.tExitR * 0.5 && lagTau < end;
      echo.root.visible = on && !!echo.wolf;
      if (!echo.root.visible) continue;
      this._placeWolf(echo, lagTau, c, P, false);
      echo.setClip(this.rifts[0].plane, this.rifts[1].plane);
      const life = smoothstep(P.tExitR * 0.5, P.tExitR + 0.15, lagTau) * (1 - smoothstep(P.tEntryR - 0.1, end, lagTau));
      echo.sync(c.echoOpacity * life * (1 - i / (count + 1)), 0, this.scaleK);
    }

    /* ---- the beats ---- */
    if (tau >= P.tExitR && !this.flags.exit) {
      this.flags.exit = true;
      this._crossing(this.rifts[0], 1, c);
    }
    if (tau >= P.tTakeR && !this.flags.takeoff) {
      this.flags.takeoff = true;
      this._groundHit(c, 0.6);
    }
    if (tau >= P.tLandR && !this.flags.land) {
      this.flags.land = true;
      this._groundHit(c, 1);
    }
    if (tau >= P.tEntryR && !this.flags.entry) {
      this.flags.entry = true;
      this._crossing(this.rifts[1], -1, c);
    }

    /* ---- feet on the stone, star dust off it, light from its eyes ---- */
    if (visible) {
      const airborne = tau > P.tTakeR && tau < P.tLandR;
      if (!airborne) this._footfalls(c);
      if (tau > P.tExitR - 0.05 && tau < P.tEntryR + 0.15) this._shed(dt, c);
    }
  }

  /** Pose one wolf at `tau`: along the ground and the leap, gallop and pounce blended. */
  _placeWolf(wolf, tau, c, P, hero) {
    this._path(tau, _p, _v);
    if (hero) {
      this.wolfPos.copy(_p);
      this.wolfVel.copy(_v);
    }
    wolf.root.position.copy(_p);

    _z.copy(_v);
    _z.y *= c.arcPitch;
    if (_z.lengthSq() < 1e-6) _z.copy(P.s);
    _z.normalize();
    _x.copy(P.lat);
    _y.crossVectors(_z, _x).normalize();
    _x.crossVectors(_y, _z).normalize();
    _m.makeBasis(_x, _y, _z);
    _q.setFromRotationMatrix(_m);

    // A twist of the whole body with the head-shake, dying away.
    const since = tau - P.tBiteR - 0.03;
    const env = since > 0 ? smoothstep(0, 0.1, since) * (1 - smoothstep(0, Math.max(0.1, c.thrashTime), since)) : 0;
    const roll = ((c.thrashRoll * Math.PI) / 180) * env * Math.sin(since * TAU * c.thrashRate);
    _roll.setFromAxisAngle(_a.set(0, 0, 1), roll * this.sweep);
    wolf.root.quaternion.copy(_q).multiply(_roll);
    wolf.frame.scale.setScalar(this.scaleK);

    // The gallop runs at the ground speed, so the feet plant. It is phased to
    // reach its push-off on the takeoff — the pounce's first frame — and the
    // pounce ends on the gallop's forefeet-down frame, where it picks up again.
    const rate = P.v / Math.max(0.5, c.stride * this.scaleK);
    const blend = Math.max(0.01, c.gaitBlend);
    const tl = tau - P.tTakeR;
    if (tl < 0) {
      wolf.pose(WOLF_TAKEOFF_AT + tl * rate, 0, smoothstep(-blend, 0, tl));
    } else if (tl < P.tl) {
      wolf.pose(WOLF_TAKEOFF_AT, this._clipAt(tl, P.tb, P.tl), 1);
    } else {
      const after = tl - P.tl;
      wolf.pose(WOLF_LANDING_AT + after * rate, 1, 1 - smoothstep(0, blend, after));
    }
  }

  /** Each paw that comes down on the stone kicks up a little star dust. */
  _footfalls(c) {
    const wolf = this.hero.wolf;
    if (!wolf || c.footDust <= 0) return;
    const g = settings.global;
    const time = frame.uTime.value;
    const contact = c.footHeight + 0.12 * this.scaleK;
    for (let i = 0; i < wolf.paws.length; i++) {
      const paw = wolf.paws[i].getWorldPosition(this._paw);
      const down = paw.y < contact;
      if (down && !this._pawDown[i] && this._inFront(paw)) {
        _emit.position.copy(paw).setY(0.05);
        _emit.direction.copy(this.wolfVel).normalize().multiplyScalar(-0.6).addScaledVector(UP, 1).normalize();
        _emit.radius = 0.12;
        _emit.speed = 1.6;
        _emit.speedVariance = 0.6;
        _emit.spread = 0.7;
        _emit.size = 0.05;
        _emit.sizeVariance = 0.5;
        _emit.life = 0.7;
        _emit.lifeVariance = 0.4;
        _emit.spin = 0;
        _emit.tint = null;
        _emit.time = time;
        this.motes.emit(Math.round(10 * c.footDust * g.particleCount), _emit);
        _emit.speed = 0.3;
        _emit.size = 0.35;
        _emit.life = 0.6;
        _emit.spin = 1;
        this.wisps.emit(Math.max(1, Math.round(c.footDust * g.particleCount)), _emit);
        _emit.radius = 0.05;
        _emit.speed = 0.05;
        _emit.spread = 0;
        _emit.size = 0.25;
        _emit.life = 0.2;
        _emit.spin = 2;
        this.glints.emit(1, _emit);
      }
      this._pawDown[i] = down;
    }
  }

  /** Leaving the ground (`scale` small) and coming back down on it. */
  _groundHit(c, scale) {
    const g = settings.global;
    const time = frame.uTime.value;
    _p.copy(this.wolfPos).setY(0.06);
    for (let i = 0; i < Math.round(50 * scale * g.particleCount); i++) {
      const a = Math.random() * TAU;
      _emit.position.copy(_p);
      _emit.direction.set(Math.cos(a), 0.35, Math.sin(a)).normalize();
      _emit.radius = 0.3;
      _emit.speed = 3.5 * scale;
      _emit.speedVariance = 0.5;
      _emit.spread = 0.2;
      _emit.size = 0.06;
      _emit.sizeVariance = 0.5;
      _emit.life = 0.8;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.motes.emit(1, _emit);
    }
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _p, {
      radius: 2.2 * scale,
      life: 0.5,
      intensity: 0.6 * scale,
      width: 0.05,
      colorA: getColor(c.colorHot),
      colorB: getColor(c.colorRim)
    });
    this.ctx.decals.spawn(DecalType.DUSTRING, _p, {
      radius: 1.8 * scale,
      life: 1.0,
      intensity: 0.3,
      growth: 0.5,
      colorA: getColor(c.colorRim),
      colorB: getColor(c.colorNebula)
    });
    this.ctx.shake.add(c.landShake * scale * g.explosionIntensity * g.cameraShake, 2.6, 22);
  }

  /** Bursting through a rift's face. `dir` +1 coming out of it, -1 going in. */
  _crossing(rift, dir, c) {
    const g = settings.global;
    const time = frame.uTime.value;
    rift.flare = 1.4;
    _x.crossVectors(UP, rift.normal).normalize();
    const n = Math.round(c.crossSparks * g.particleCount);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const r = Math.sqrt(Math.random()) * rift.radius * 0.9;
      _emit.position.copy(rift.centre).addScaledVector(_x, Math.cos(a) * r).addScaledVector(UP, Math.sin(a) * r);
      // Out of the face, flung outward, and dragged along by the animal.
      _emit.direction.copy(rift.normal).multiplyScalar(dir > 0 ? 1.2 : 0.6)
        .addScaledVector(_x, Math.cos(a) * 0.8)
        .addScaledVector(UP, Math.sin(a) * 0.8)
        .addScaledVector(this._plan.s, 0.6)
        .normalize();
      _emit.radius = 0.05;
      _emit.speed = 6 + Math.random() * 6;
      _emit.speedVariance = 0.3;
      _emit.spread = 0.25;
      _emit.size = 0.025 + Math.random() * 0.025;
      _emit.sizeVariance = 0.3;
      _emit.life = 0.55;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.sparks.emit(1, _emit);
    }
    for (let i = 0; i < Math.round(60 * g.particleCount); i++) {
      const a = Math.random() * TAU;
      const r = rift.radius * (0.9 + Math.random() * 0.2);
      _emit.position.copy(rift.centre).addScaledVector(_x, Math.cos(a) * r).addScaledVector(UP, Math.sin(a) * r);
      _emit.direction.copy(rift.normal).multiplyScalar(0.5).addScaledVector(_x, Math.cos(a)).addScaledVector(UP, Math.sin(a)).normalize();
      _emit.radius = 0.05;
      _emit.speed = 2.5;
      _emit.speedVariance = 0.5;
      _emit.spread = 0.3;
      _emit.size = 0.06;
      _emit.sizeVariance = 0.5;
      _emit.life = 0.9;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0;
      this.motes.emit(1, _emit);
    }
    _emit.position.copy(rift.centre);
    _emit.radius = 0.2;
    _emit.speed = 0.4;
    _emit.spread = 1;
    _emit.size = 0.5;
    _emit.sizeVariance = 0.5;
    _emit.life = 0.3;
    _emit.lifeVariance = 0.3;
    _emit.spin = 3;
    this.glints.emit(Math.round(10 * g.particleCount), _emit);

    this._ring(rift.centre, rift.radius * 0.6, 0.35);
    _p.copy(rift.centre).setY(0);
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _p, {
      radius: rift.radius * 2.6,
      life: 0.6,
      intensity: 0.7,
      width: 0.05,
      colorA: getColor(c.colorHot),
      colorB: getColor(c.colorRim)
    });
    this.lightBoost = Math.max(this.lightBoost, c.riftLight * 2 * g.explosionIntensity);
    this.ctx.shake.add(c.riftShake * g.explosionIntensity * g.cameraShake, 2.2, 20);
  }

  /** Star dust shed off the body in flight, and the light from its eyes. */
  _shed(dt, c) {
    const g = settings.global;
    const time = frame.uTime.value;
    const k = this.scaleK;
    _z.copy(this.wolfVel).normalize();
    const n = this._trail.tick(dt, c.trailRate * g.particleCount);
    for (let i = 0; i < n; i++) {
      const along = (Math.random() - 0.55) * c.length * 0.9;
      _emit.position.copy(this.wolfPos).addScaledVector(_z, along);
      _emit.direction.copy(this.wolfVel).multiplyScalar(-0.2).addScaledVector(UP, 0.3).normalize();
      _emit.radius = 0.3 * k;
      _emit.speed = 0.6;
      _emit.speedVariance = 0.6;
      _emit.spread = 0.8;
      _emit.size = 0.045;
      _emit.sizeVariance = 0.6;
      _emit.life = 0.9;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      if (this.hero.look && this._inFront(_emit.position)) this.motes.emit(1, _emit);
    }
    const m = this._sparkle.tick(dt, 30 * g.particleCount);
    for (let i = 0; i < m; i++) {
      _emit.position.copy(this.wolfPos).addScaledVector(_z, (Math.random() - 0.5) * c.length * 0.8);
      _emit.direction.set(0, 1, 0);
      _emit.radius = 0.35 * k;
      _emit.speed = 0.1;
      _emit.spread = 1;
      _emit.size = 0.22;
      _emit.sizeVariance = 0.5;
      _emit.life = 0.35;
      _emit.lifeVariance = 0.4;
      _emit.spin = 2;
      if (this._inFront(_emit.position)) this.glints.emit(1, _emit);
    }

    const wolf = this.hero.wolf;
    if (!wolf?.eyeL || !wolf.eyeR) return;
    const e = this._eyes.tick(dt, c.eyeTrail * g.particleCount);
    for (let i = 0; i < e; i++) {
      (i % 2 ? wolf.eyeL : wolf.eyeR).getWorldPosition(this._eye);
      if (!this._inFront(this._eye)) continue;
      _emit.position.copy(this._eye);
      _emit.direction.copy(this.wolfVel).negate().normalize();
      _emit.radius = 0.01;
      _emit.speed = 1.5;
      _emit.speedVariance = 0.3;
      _emit.spread = 0.05;
      _emit.size = 0.035;
      _emit.sizeVariance = 0.2;
      _emit.life = 0.32;
      _emit.lifeVariance = 0.2;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.sparks.emit(1, _emit);
    }
  }

  /** Is a point on this side of both rifts — not somewhere the rifts are hiding? */
  _inFront(p) {
    for (const rift of this.rifts) if (p.dot(rift.normal) < rift.plane.w) return false;
    return true;
  }

  /* ---- the body ---- */

  _victimFrame(dt, c, age) {
    const P = this._plan;
    const victim = this.victim;
    if (!victim || this.victimDone) return;

    /* the lift */
    if (age >= P.tLift && !this.flags.lift) {
      this.flags.lift = true;
      if (!victim.alive) {
        this.victim = null;
        return;
      }
      victim.kill(this.direction.x, this.direction.z, c.lift);
      if (!victim.bodyPoint(this.hips0)) this.hips0.copy(victim.position).setY(1);
      this._liftFx(c);
    }
    if (!this.flags.lift) return;

    if (!this.held && age < P.tBite) {
      // Thrown up the column onto the jaw's path: ballistic under the body's
      // own gravity, solved to arrive at the bite point on the bite frame.
      const H = Math.max(0.05, P.tBite - P.tLift);
      const tk = age - P.tLift;
      const gravity = -settings.dummies.ragdoll.gravity;
      const y0 = this.hips0.y;
      const v0 = (P.bite.y - y0 + 0.5 * gravity * H * H) / H;
      const k = smoothstep(0, 1, tk / H);
      _p.set(
        this.hips0.x + (P.bite.x - this.hips0.x) * k,
        y0 + v0 * tk - 0.5 * gravity * tk * tk,
        this.hips0.z + (P.bite.z - this.hips0.z) * k
      );
      victim.pin('Hips', _p, c.hangGrip);
      return;
    }

    /* the bite */
    if (!this.flags.bite) {
      this.flags.bite = true;
      if (victim.state === 'gone' || victim.state === 'frozen') {
        this.victim = null;
        return;
      }
      victim.unpin('Hips');
      this.held = true;
      this._biteFx(c);
    }

    const snap = saturate((age - P.tBite) / Math.max(0.01, c.biteSnap));
    const joint = c.grabJoint || 'Spine';
    if (!victim.pin(joint, this.socket, 0.2 + 0.8 * snap)) victim.pin('Hips', this.socket, 0.2 + 0.8 * snap);
    victim.hold();

    // Carried, not trailed. The jaw flies a near free-fall arc, so whatever it
    // holds is all but weightless against it and would stream straight back
    // into the wolf's chest; the hips are held on a leash under the head
    // instead, between the forelegs the clip closes round them.
    if (joint !== 'Hips' && c.carryGrip > 0) {
      const k = this.scaleK;
      _y.set(0, 1, 0).applyQuaternion(this.hero.root.quaternion);
      _z.set(0, 0, 1).applyQuaternion(this.hero.root.quaternion);
      _p.copy(this.socket).addScaledVector(_y, -c.carryDrop * k).addScaledVector(_z, -0.12 * k);
      victim.pin('Hips', _p, c.carryGrip * snap);
    }

    // Starlight crawling over it from the bite, and the far rift cutting it.
    const st = this._stain;
    st.color = c.colorPrey;
    st.rimColor = c.colorRim;
    st.rimEmissive = c.preyRim;
    st.edgeColor = c.colorHot;
    st.edgeEmissive = c.preyEdge;
    victim.corrode(saturate((age - P.tBite) / Math.max(0.1, c.stainTime)), st);
    const seam = this._seamLook;
    seam.color = c.colorHot;
    seam.glow = c.preySeam;
    seam.width = c.seamWidth;
    victim.clip(null, this.rifts[1].normal, this.rifts[1].centre, seam);

    // Taken on the far side of it.
    if (victim.bodyPoint(_p)) {
      const through = this.rifts[1].plane.w - _p.dot(this.rifts[1].normal);
      if (through > 0) victim.consume(saturate(through / Math.max(0.1, c.consumeDepth)));
    }

    if (age > P.tEnd + 0.15) {
      victim.consume(1);
      victim.unpin();
      this.victimDone = true;
      this.held = false;
      this.victim = null;
    }
  }

  /** The rose flares and the column goes up. */
  _liftFx(c) {
    const g = settings.global;
    const P = this._plan;
    const time = frame.uTime.value;
    for (let i = 0; i < Math.round(80 * g.particleCount); i++) {
      const a = Math.random() * TAU;
      const r = Math.random() * c.columnRadius;
      _emit.position.set(P.T.x + Math.cos(a) * r, 0.1 + Math.random() * 0.4, P.T.z + Math.sin(a) * r);
      _emit.direction.set(0, 1, 0);
      _emit.radius = 0.05;
      _emit.speed = 4 + Math.random() * 6;
      _emit.speedVariance = 0.3;
      _emit.spread = 0.08;
      _emit.size = 0.05;
      _emit.sizeVariance = 0.5;
      _emit.life = 0.7;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0;
      _emit.tint = getColor(c.colorGold);
      _emit.time = time;
      this.motes.emit(1, _emit);
    }
    _emit.tint = null;
    _p.copy(P.T).setY(0);
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _p, {
      radius: c.sigilRadius * 1.5,
      life: 0.6,
      intensity: 0.8,
      width: 0.04,
      colorA: getColor(c.colorHot),
      colorB: getColor(c.colorGold)
    });
    this.lightBoost = Math.max(this.lightBoost, c.riftLight * g.explosionIntensity);
    this.ctx.shake.add(c.liftShake * g.explosionIntensity * g.cameraShake, 2.4, 22);
  }

  /** The jaw closing: a star of light on the teeth, sparks, the hit of it. */
  _biteFx(c) {
    const g = settings.global;
    const time = frame.uTime.value;
    _emit.position.copy(this.socket);
    _emit.direction.copy(this.wolfVel).normalize();
    _emit.radius = 0.2;
    _emit.speed = 9;
    _emit.speedVariance = 0.5;
    _emit.spread = 1;
    _emit.size = 0.035;
    _emit.sizeVariance = 0.5;
    _emit.life = 0.5;
    _emit.lifeVariance = 0.4;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.sparks.emit(Math.round(c.biteSparks * g.particleCount), _emit);
    _emit.speed = 3;
    _emit.size = 0.07;
    _emit.life = 1.0;
    this.motes.emit(Math.round(c.biteSparks * 0.6 * g.particleCount), _emit);

    _emit.radius = 0;
    _emit.speed = 0;
    _emit.spread = 0;
    _emit.size = 3.2;
    _emit.sizeVariance = 0.1;
    _emit.life = 0.18;
    _emit.lifeVariance = 0;
    _emit.spin = 2;
    this.glints.emit(1, _emit);

    this._ring(this.socket, 0.5, 0.25);
    this._ring(this.socket, 0.9, 0.4);
    _p.copy(this.socket).setY(0);
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _p, {
      radius: 3.4,
      life: 0.55,
      intensity: 0.7,
      width: 0.05,
      colorA: getColor(c.colorHot),
      colorB: getColor(c.colorRim)
    });

    this.lightBoost = Math.max(this.lightBoost, c.biteLight * g.explosionIntensity);
    this.ctx.shake.add(c.biteShake * g.explosionIntensity * g.cameraShake, 3.2, 26);
    if (c.biteFlash > 0) this.ctx.flash.trigger(getColor(c.colorRim), c.biteFlash * g.explosionIntensity);
  }

  /* ---- the air round the rifts ---- */

  _ambient(dt, c) {
    const g = settings.global;
    const time = frame.uTime.value;
    for (const rift of this.rifts) {
      if (rift.open < 0.3) continue;
      _x.crossVectors(UP, rift.normal).normalize();
      // Dust from all round it, drawn in and swallowed.
      const n = this._riftDust.tick(dt, 26 * rift.open * g.particleCount);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * TAU;
        const r = rift.radius * (1.5 + Math.random() * 0.8);
        _emit.position.copy(rift.centre).addScaledVector(_x, Math.cos(a) * r).addScaledVector(UP, Math.sin(a) * r)
          .addScaledVector(rift.normal, 0.2 + Math.random() * 0.6);
        _emit.direction.copy(rift.centre).sub(_emit.position).normalize()
          .addScaledVector(_x, -Math.sin(a) * 0.6).addScaledVector(UP, Math.cos(a) * 0.6).normalize();
        _emit.radius = 0.05;
        _emit.speed = r / 0.9;
        _emit.speedVariance = 0.2;
        _emit.spread = 0.05;
        _emit.size = 0.04;
        _emit.sizeVariance = 0.5;
        _emit.life = 0.8;
        _emit.lifeVariance = 0.2;
        _emit.spin = 0;
        _emit.tint = null;
        _emit.time = time;
        this.motes.emit(1, _emit);
      }
      // Nebula breathing out of the rim.
      const m = this._riftWisps.tick(dt, 7 * rift.open * g.particleCount);
      for (let i = 0; i < m; i++) {
        const a = Math.random() * TAU;
        const r = rift.radius * 1.02;
        _emit.position.copy(rift.centre).addScaledVector(_x, Math.cos(a) * r).addScaledVector(UP, Math.sin(a) * r);
        _emit.direction.set(Math.cos(a), Math.sin(a), 0);
        _emit.direction.copy(_x).multiplyScalar(Math.cos(a)).addScaledVector(UP, Math.sin(a)).addScaledVector(rift.normal, 0.4).normalize();
        _emit.radius = 0.1;
        _emit.speed = 0.5;
        _emit.speedVariance = 0.5;
        _emit.spread = 0.3;
        _emit.size = 0.5;
        _emit.sizeVariance = 0.4;
        _emit.life = 1.1;
        _emit.lifeVariance = 0.3;
        _emit.spin = 1;
        this.wisps.emit(1, _emit);
      }
    }
  }

  _lights(dt, c) {
    for (const rift of this.rifts) {
      if (!rift.light) continue;
      _p.copy(rift.centre).addScaledVector(rift.normal, 0.6);
      this.ctx.lights.set(
        rift.light,
        _p,
        getColor(c.colorRim),
        c.riftLight * Math.min(1, rift.open) * (1 + rift.flare * 2) * rift.fade,
        c.riftLightRadius,
        dt
      );
    }
  }

  /* ---- the look of every particle system, every frame ---- */

  _dress(c) {
    const g = settings.global;
    {
      const u = this.sparks.uniforms;
      this.sparks.setGradient(getColor('#ffffff'), getColor(c.colorHot), getColor(c.colorRim), getColor(c.colorNebula));
      u.uGravity.value.set(0, -3, 0);
      u.uDrag.value = 1.6;
      u.uTurbulence.value = 0.15;
      u.uStretch.value = 0.06;
      u.uEndSize.value = 0.4;
      u.uFadeOut.value = 0.5;
      u.uGlow.value = 1.6 * g.glow;
      u.uOpacity.value = 0.9;
    }
    {
      const u = this.motes.uniforms;
      this.motes.setGradient(getColor(c.colorHot), getColor(c.colorRim), getColor(c.colorNebula), getColor(c.colorNebulaHot));
      u.uGravity.value.set(0, 0.2, 0);
      u.uDrag.value = 1.4;
      u.uTurbulence.value = 0.8 * g.turbulence;
      u.uTurbFrequency.value = 1.2;
      u.uEndSize.value = 0.3;
      u.uFadeIn.value = 0.05;
      u.uFadeOut.value = 0.5;
      u.uGlow.value = 1.5 * g.glow;
      u.uOpacity.value = 0.85;
    }
    {
      const u = this.wisps.uniforms;
      this.wisps.setGradient(getColor(c.colorRim), getColor(c.colorNebula), getColor(c.colorNebula), getColor(c.colorVoid));
      u.uGravity.value.set(0, 0.15, 0);
      u.uDrag.value = 1.8;
      u.uTurbulence.value = 0.5 * g.turbulence;
      u.uTurbFrequency.value = 0.8;
      u.uEndSize.value = 2.2;
      u.uFadeIn.value = 0.15;
      u.uFadeOut.value = 0.5;
      u.uGlow.value = 0.7 * g.glow;
      u.uOpacity.value = 0.18;
    }
    {
      const u = this.rings.uniforms;
      this.rings.setGradient(getColor('#ffffff'), getColor(c.colorHot), getColor(c.colorRim), getColor(c.colorNebula));
      u.uGravity.value.set(0, 0, 0);
      u.uDrag.value = 0;
      u.uTurbulence.value = 0;
      u.uEndSize.value = 4.0;
      u.uSizeIn.value = 0.001;
      u.uFadeIn.value = 0;
      u.uFadeOut.value = 0.85;
      u.uGlow.value = 1.2 * g.glow;
      u.uOpacity.value = 0.55;
    }
    {
      const u = this.glints.uniforms;
      this.glints.setGradient(getColor('#ffffff'), getColor(c.colorHot), getColor(c.colorRim), getColor(c.colorRim));
      u.uGravity.value.set(0, 0, 0);
      u.uDrag.value = 1;
      u.uTurbulence.value = 0;
      u.uEndSize.value = 0.5;
      u.uSizeIn.value = 0.001;
      u.uFadeIn.value = 0;
      u.uFadeOut.value = 0.5;
      u.uGlow.value = 2.4 * g.glow;
      u.uOpacity.value = 1;
    }
  }
}
