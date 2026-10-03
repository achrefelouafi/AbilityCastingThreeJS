import {
  CircleGeometry,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  PlaneGeometry,
  Quaternion,
  Vector3,
  Vector4
} from 'three';
import { Ability } from './Ability.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { DecalType } from '../effects/GroundDecals.js';
import { BurstMode } from '../effects/BurstSphere.js';
import { instanceShark, SHARK_BITE_AT } from '../assets/SharkRig.js';
import {
  createCrownMaterial,
  createPortalMaterial,
  createPortalRefractionMaterial,
  createSharkRockMaterial,
  createWellMaterial,
  patchSharkMaterial
} from '../materials/SharkMaterials.js';
import { floorHoles } from '../world/FloorHoles.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { Easing, saturate, smoothstep } from '../utils/math.js';

const TAU = Math.PI * 2;
/** Chunks of rock one cast can have in the air. */
const MAX_CHIPS = 32;
/** Never let a portal's floor quad be smaller than its stain and rune. */
const QUAD_MARGIN = 2.2;

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
const _s = new Vector3();
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

/**
 * Cubic Hermite between two points with their velocities, over `h` seconds.
 * `x` is 0..1 through it. Writes the position and its rate of change, m/s.
 */
function hermite(p0, v0, p1, v1, h, x, outP, outV) {
  const x2 = x * x;
  const x3 = x2 * x;
  const h00 = 2 * x3 - 3 * x2 + 1;
  const h10 = x3 - 2 * x2 + x;
  const h01 = -2 * x3 + 3 * x2;
  const h11 = x3 - x2;
  outP.set(0, 0, 0).addScaledVector(p0, h00).addScaledVector(v0, h10 * h).addScaledVector(p1, h01).addScaledVector(v1, h11 * h);
  const d00 = 6 * x2 - 6 * x;
  const d10 = 3 * x2 - 4 * x + 1;
  const d01 = -6 * x2 + 6 * x;
  const d11 = 3 * x2 - 2 * x;
  outV.set(0, 0, 0)
    .addScaledVector(p0, d00 / h)
    .addScaledVector(v0, d10)
    .addScaledVector(p1, d01 / h)
    .addScaledVector(v1, d11);
}

/**
 * One opening in the floor: the water and everything drawn on the stone
 * round it, the refraction, the well under it, the crown it throws, and the
 * hole it cuts in the ground shader.
 */
class Portal {
  constructor(group) {
    this.centre = new Vector3();
    this.seed = 0;
    this.hole = -1;
    this.light = null;

    this.radius = 0;
    this.open = 0;
    this.spin = 0;
    this.churn = 0;
    this.dry = 0;
    this.rune = 0;
    this.splash = new Vector4(0, 0, 10, 0);
    this.crownAge = -1;
    this.crownScale = 1;
    this.crownSeed = 0;
    this._state = {
      quad: 8,
      radius: 0,
      full: 1,
      open: 0,
      spin: 0,
      churn: 0,
      splash: this.splash,
      dry: 0,
      fade: 1,
      seed: 0,
      rune: 1
    };

    const flat = new PlaneGeometry(1, 1);
    flat.rotateX(-Math.PI / 2);

    this.surfaceMaterial = createPortalMaterial();
    this.surface = new Mesh(flat, this.surfaceMaterial);
    this.surface.name = 'SharkPortal';
    this.surface.layers.set(LAYER.VFX);
    // Over the floor decals (5), under the crown and the particles.
    this.surface.renderOrder = 6;
    this.surface.frustumCulled = false;

    this.warpMaterial = createPortalRefractionMaterial();
    this.warp = new Mesh(flat, this.warpMaterial);
    this.warp.layers.set(LAYER.DISTORTION);
    this.warp.frustumCulled = false;

    // The well: an open tube from the floor down, and the disc closing it.
    // Unit radius and depth; scaled to the hole every frame.
    this.wellMaterial = createWellMaterial();
    const tube = new CylinderGeometry(1, 1, 1, 48, 1, true);
    tube.translate(0, -0.5, 0);
    const cap = new CircleGeometry(1, 48);
    cap.rotateX(-Math.PI / 2);
    cap.translate(0, -1, 0);
    this.well = new Group();
    this.well.name = 'SharkWell';
    for (const geometry of [tube, cap]) {
      const mesh = new Mesh(geometry, this.wellMaterial);
      mesh.layers.set(LAYER.VFX);
      mesh.frustumCulled = false;
      this.well.add(mesh);
    }

    this.crownMaterial = createCrownMaterial();
    const crown = new CylinderGeometry(1, 1, 1, 72, 14, true);
    crown.translate(0, 0.5, 0);
    this.crown = new Mesh(crown, this.crownMaterial);
    this.crown.layers.set(LAYER.VFX);
    this.crown.renderOrder = 9;
    this.crown.frustumCulled = false;

    group.add(this.surface, this.warp, this.well, this.crown);
    this.hide();
  }

  hide() {
    this.surface.visible = false;
    this.warp.visible = false;
    this.well.visible = false;
    this.crown.visible = false;
  }

  reset() {
    this.seed = Math.random() * 10;
    this.radius = 0;
    this.open = 0;
    this.spin = Math.random() * TAU;
    this.churn = 0;
    this.dry = 0;
    this.rune = 0;
    this.splash.set(0, 0, 10, 0);
    this.crownAge = -1;
  }

  /** The breach: white water, a ring off the crossing, and the crown. */
  breach(at, scale) {
    this.churn = 1;
    this.splash.set(at.x - this.centre.x, at.z - this.centre.z, 0, 1);
    this.crownAge = 0;
    this.crownScale = scale;
    this.crownSeed = Math.random() * 10;
  }

  /**
   * @param {number} dt
   * @param {object} c settings.shark
   * @param {number} fade 0..1 of the whole surface
   */
  update(dt, c, fade) {
    const full = Math.max(0.1, c.portalRadius);
    this.churn = Math.max(0, this.churn - this.churn * c.churnDecay * dt - 0.05 * dt);
    this.splash.z += dt;
    if (this.crownAge >= 0) this.crownAge += dt / Math.max(0.05, c.crownTime);

    const visible = fade > 0.001;
    const quad = full * Math.max(c.wetReach, c.runeRadius + 0.2, c.crackReach) * 2 + QUAD_MARGIN;

    this.surface.visible = visible;
    this.surface.position.set(this.centre.x, 0.012, this.centre.z);
    this.surface.scale.set(quad, 1, quad);
    const s = this._state;
    s.quad = quad;
    s.radius = this.radius;
    s.full = full;
    s.open = this.open;
    s.spin = this.spin;
    s.churn = this.churn;
    s.dry = this.dry;
    s.fade = fade;
    s.seed = this.seed;
    s.rune = this.rune;
    this.surfaceMaterial.userData.sync(s);

    const wet = this.radius > 0.01;
    this.warp.visible = visible && wet;
    this.warp.position.copy(this.surface.position);
    this.warp.scale.copy(this.surface.scale);
    this.warpMaterial.userData.sync(s);

    this.well.visible = wet;
    this.well.position.set(this.centre.x, 0, this.centre.z);
    this.well.scale.set(this.radius, Math.max(1, c.wellDepth), this.radius);
    this.wellMaterial.userData.sync({ x: this.centre.x, z: this.centre.z, radius: this.radius, seed: this.seed });

    // The floor itself: open exactly as far as the water is.
    floorHoles.set(this.hole, this.centre.x, this.centre.z, wet ? this.radius : 0);

    const crownLive = this.crownAge >= 0 && this.crownAge < 1;
    this.crown.visible = crownLive;
    if (crownLive) {
      this.crown.position.set(this.centre.x, 0, this.centre.z);
      this.crownMaterial.userData.sync({
        age: this.crownAge,
        radius: full * c.crownRadius * Math.sqrt(this.crownScale),
        height: c.crownHeight * this.crownScale,
        seed: this.crownSeed
      });
    }
  }
}

/**
 * THE ABYSSAL MAW — a targeted far cast: one body, taken.
 *
 * The circle snaps onto whoever is under the cursor. When the cast lands,
 * five beats, and they are timed against each other so they read as one
 * ambush rather than three effects:
 *
 *   1. **The portals tear open.** Two holes of deep water, either side of the
 *      target and across the line of the cast, so the leap crosses the frame.
 *      They are real openings — the floor shader is cut (`FloorHoles`) and a
 *      well of water stands under each — with a torn lip, a wet stain, cracks
 *      and the rune the summons is drawn with on the stone round them.
 *   2. **The rock.** A spike of the floor's own stone bursts up under the
 *      target and kicks it into the air, cracking the floor, throwing chips
 *      and raising a ring of dust.
 *   3. **The breach.** The shark has been rising up its well since before the
 *      rock went off; it breaks the surface of the near portal in a crown of
 *      water and spray as the body leaves the ground.
 *   4. **The bite.** Its arc is *solved* so the jaw arrives where the body is
 *      at the top of the kick, on the frame the authored clip snaps shut. The
 *      body is not attached to the shark — it is held: one joint pinned in
 *      the jaw (`Ragdoll#pin`) and the rest of it hanging, swinging and
 *      flailing under gravity while the shark shakes its head and rolls.
 *   5. **Gone.** Over the top of the arc and down into the far portal in a
 *      bigger crown; the body is taken by the deep as it goes under, and both
 *      portals spiral shut behind it, leaving the stone wet.
 *
 * The arc is the part worth reading. The horizontal run is constant-speed
 * portal to portal; the vertical is ballistic, and the one free number — its
 * gravity — is solved so that the mouth, *pitched as the clip has it at the
 * bite*, is at `biteHeight` over the target when it passes it. The shark
 * leaves the water early enough to make that frame, and the rock fires early
 * enough for the body to be at the top of its kick when it does. Every one of
 * those is re-solved each frame from `settings.shark`, so the editor re-plans
 * a leap that is already in the air.
 */
export class SharkAbility extends Ability {
  constructor(context) {
    super('shark', context);
  }

  /** It picks one body and decides for itself when it is hit. */
  get handlesOwnHits() {
    return true;
  }

  get cameraWeight() {
    return this.u < 1 ? saturate(1 - this.u * 0.4) : 0.72;
  }

  get impactDuration() {
    const plan = this.plan;
    const close = plan ? plan.closeB + settings.shark.closeTime + 0.15 : 0;
    return Math.max(close, settings.shark.showTime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.shark.fadeTime);
  }

  get instanceCount() {
    let n = 0;
    for (const chip of this._chips) if (chip.live) n++;
    return n;
  }

  /** Metres per rig metre: the editor's length over the length the rig was built at. */
  get scaleK() {
    return this.rig ? settings.shark.length / Math.max(0.01, this.rig.length) : 1;
  }

  /* ------------------------------------------------------------------ */
  /* construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    const rig = this.ctx.models?.shark ?? null;
    this.rig = rig;

    /* ---- the shark ---- */
    // root: where it is and which way it faces. frame: the rig, scaled.
    this.root = new Group();
    this.root.name = 'SharkRoot';
    this.frame = new Group();
    this.frame.name = 'SharkFrame';
    this.root.add(this.frame);
    this.group.add(this.root);
    this.root.visible = false;

    this.shark = null;
    this.sharkMaterials = [];
    if (rig) {
      const shark = instanceShark(rig);
      this.shark = shark;
      for (const mesh of shark.meshes) {
        // Its own copy, so its wetness and fog are its own.
        const material = patchSharkMaterial(mesh.material.clone());
        mesh.material = material;
        mesh.layers.set(LAYER.WORLD);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.sharkMaterials.push(material);
      }
      if (shark.breach) shark.breach.play();
      this.frame.add(shark.root);
    }

    /* ---- the portals ---- */
    this.portals = [new Portal(this.group), new Portal(this.group)];

    /* ---- the rock ---- */
    this.rockMaterial = createSharkRockMaterial(this.ctx.environment);
    this.rock = null;
    if (rig?.rockGeometry) {
      this.rock = new Mesh(rig.rockGeometry, this.rockMaterial);
      this.rock.name = 'SharkRock';
      this.rock.layers.set(LAYER.WORLD);
      this.rock.castShadow = true;
      this.rock.receiveShadow = true;
      this.rock.frustumCulled = false;
      this.rock.visible = false;
      this.group.add(this.rock);
    }
    this.chipMesh = null;
    this._chips = [];
    for (let i = 0; i < MAX_CHIPS; i++) {
      this._chips.push({
        live: false,
        pos: new Vector3(),
        vel: new Vector3(),
        quat: new Quaternion(),
        axis: new Vector3(0, 1, 0),
        spin: 0,
        size: 0.1,
        age: 0
      });
    }
    if (rig?.chipGeometry) {
      this.chipMesh = new InstancedMesh(rig.chipGeometry, this.rockMaterial, MAX_CHIPS);
      this.chipMesh.name = 'SharkRockChips';
      this.chipMesh.layers.set(LAYER.WORLD);
      this.chipMesh.castShadow = true;
      this.chipMesh.frustumCulled = false;
      this.chipMesh.count = 0;
      this.group.add(this.chipMesh);
    }

    /* ---- state ---- */
    this.plan = null;
    this._plan = {
      T: new Vector3(),
      s: new Vector3(),
      lat: new Vector3(),
      A: new Vector3(),
      B: new Vector3(),
      bite: new Vector3(),
      V1: new Vector3(),
      V0: new Vector3(),
      P0: new Vector3(),
      V2: new Vector3(),
      V3: new Vector3(),
      P3: new Vector3(),
      g: 20,
      te: 0.2,
      tf: 1,
      td: 0.5,
      tb: 0.3,
      sharkStart: 0,
      tKick: 0,
      tBite: 0,
      tSurface: 0,
      tEntry: 0,
      tEnd: 0,
      closeA: 0,
      closeB: 0
    };
    this.target = new Vector3();
    this.sweep = 1;
    this.socketUnit = new Vector3(0, -0.05, 0.42);
    this.socket = new Vector3();
    this.sharkPos = new Vector3();
    this.sharkVel = new Vector3();
    this.fieldAge = 0;
    this.rockYaw = 0;
    this.victim = null;
    this.held = false;
    this.victimDone = false;
    this.hips0 = new Vector3();
    this.flags = { pop: false, kick: false, surface: false, bite: false, entry: false, crumble: false };
    this._targets = [];

    this._drips = new RateEmitter(80);
    this._mist = new RateEmitter(6);
    this._glints = new RateEmitter(10);
    this._travel = new RateEmitter(90);
    this._bodyDrips = new RateEmitter(30);
  }

  createParticles() {
    const P = this.ctx.particles;
    this.spray = P.get('sharkSpray', {
      capacity: 1400,
      shape: ParticleShape.DROPLET,
      additive: false,
      stretch: true,
      softFade: 0.1
    });
    this.streaks = P.get('sharkStreak', {
      capacity: 600,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.1
    });
    this.mist = P.get('sharkMist', {
      capacity: 260,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 0.6
    });
    this.dust = P.get('sharkDust', {
      capacity: 200,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 0.6
    });
    this.grit = P.get('sharkGrit', {
      capacity: 400,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.05
    });
    this.glints = P.get('sharkGlint', { capacity: 160, shape: ParticleShape.GLINT, additive: true });
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
    this.root.visible = false;
    for (const portal of this.portals) {
      portal.reset();
      portal.hide();
    }
    if (this.rock) this.rock.visible = false;
    for (const chip of this._chips) chip.live = false;
    this._syncChips();
    this._drips.reset();
    this._mist.reset();
    this._glints.reset();
    this._travel.reset();
    this._bodyDrips.reset();
  }

  onDestroy() {
    this._letGo();
    for (const portal of this.portals) {
      floorHoles.release(portal.hole);
      portal.hole = -1;
      this.ctx.lights.release(portal.light);
      portal.light = null;
      portal.hide();
    }
    this.root.visible = false;
    if (this.rock) this.rock.visible = false;
    for (const chip of this._chips) chip.live = false;
    this._syncChips();
    this.plan = null;
  }

  /** Whatever the jaw had hold of falls from wherever it has got to. */
  _letGo() {
    const victim = this.victim;
    if (victim && this.held) {
      victim.unpin();
      victim.release();
    } else if (victim) {
      victim.unpin();
    }
    this.held = false;
    this.victim = null;
  }

  /* ------------------------------------------------------------------ */
  /* the cast's run to the target                                        */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    const c = this.config;
    // A line of water skipping over the stone to where it is going.
    const n = this._travel.tick(dt, 90 * settings.global.particleCount);
    for (let i = 0; i < n; i++) {
      _emit.position.copy(this.position).setY(0.08);
      _emit.direction.set(0, 1, 0);
      _emit.radius = 0.15;
      _emit.speed = 2.2;
      _emit.speedVariance = 0.5;
      _emit.spread = 0.6;
      _emit.size = 0.05;
      _emit.sizeVariance = 0.5;
      _emit.life = 0.45;
      _emit.lifeVariance = 0.3;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = frame.uTime.value;
      this.spray.emit(1, _emit);
    }
    this._dress(c);
  }

  /* ------------------------------------------------------------------ */
  /* the landing                                                         */
  /* ------------------------------------------------------------------ */

  onImpact() {
    const c = this.config;
    this.fieldAge = 0;

    // Who it is for: the body the circle locked onto, which is the nearest
    // one standing on the point.
    this.pointAt(1, this.target);
    this.victim = null;
    const found = this.ctx.dummies?.findTargets?.(this.target.x, this.target.z, Math.max(0.6, c.snapRadius * 0.6), this._targets);
    if (found?.length) {
      this.victim = found[0];
      this.target.set(this.victim.position.x, 0, this.victim.position.z);
    }

    // Across the frame, one way or the other.
    this.sweep = Math.random() < 0.5 ? 1 : -1;
    this.rockYaw = Math.random() * TAU;

    this._measureSocket();
    this._solve(c);

    for (const portal of this.portals) {
      portal.reset();
      if (portal.hole < 0) portal.hole = floorHoles.acquire();
      if (!portal.light) portal.light = this.ctx.lights.acquire();
    }
    this.position.copy(this.target).setY(1.2);
  }

  /**
   * Where the jaw holds the prey, in the shark's own frame, at the bite.
   *
   * Read off the clip rather than guessed: the clip is posed at its bite
   * frame with the shark at the origin facing +Z, and the socket is measured
   * off the teeth. The arc is solved around this, so the jaw is where the
   * plan says on the frame it closes.
   */
  _measureSocket() {
    const shark = this.shark;
    if (!shark?.breach) return;
    const action = shark.breach;
    action.time = action.getClip().duration * SHARK_BITE_AT;
    shark.mixer.update(0);
    this.root.position.set(0, 0, 0);
    this.root.quaternion.identity();
    this.frame.scale.setScalar(1);
    this.root.updateMatrixWorld(true);
    this._socketWorld(this.socketUnit);
  }

  /** The point the jaw holds, in the world, off this frame's pose. */
  _socketWorld(out) {
    const shark = this.shark;
    const depth = saturate(settings.shark.socketDepth);
    if (shark?.upperTeeth && shark.lowerTeeth && shark.head) {
      _a.copy(shark.upperCentre);
      shark.upperTeeth.localToWorld(_a);
      _b.copy(shark.lowerCentre);
      shark.lowerTeeth.localToWorld(_b);
      out.addVectors(_a, _b).multiplyScalar(0.5);
      shark.head.getWorldPosition(_c);
      return out.lerp(_c, depth);
    }
    // No teeth to measure: a point a little behind the nose.
    return out.set(0, 0, 0.4).applyMatrix4(this.root.matrixWorld);
  }

  /* ------------------------------------------------------------------ */
  /* the plan                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Solve the leap against the current settings.
   *
   * Constant horizontal speed portal to portal; ballistic vertically, with
   * the gravity solved so the mouth — offset from the body's centre as the
   * clip has it at the bite, *pitched* along the arc at that point — passes
   * `biteHeight` over the target. The pitch depends on the gravity and the
   * gravity on the pitch, so it is iterated; four rounds is exact to the
   * millimetre at any setting the editor allows.
   */
  _solve(c) {
    const P = this._plan;
    const k = this.scaleK;
    P.T.copy(this.target);
    P.s.copy(this.side).multiplyScalar(this.sweep).setY(0).normalize();
    P.lat.crossVectors(UP, P.s).normalize();

    const span = Math.max(c.portalRadius + 0.5, c.portalSpan);
    P.A.copy(P.T).addScaledVector(P.s, -span);
    P.B.copy(P.T).addScaledVector(P.s, span);
    P.bite.copy(P.T).setY(c.biteHeight);

    const tf = Math.max(0.2, c.flightTime);
    const vh = (2 * span) / tf;
    const sz = this.socketUnit.z * k;
    const sy = this.socketUnit.y * k;
    let pitch = 0;
    let tb = tf * 0.25;
    let g = 20;
    for (let i = 0; i < 4; i++) {
      const cp = Math.cos(pitch);
      const sp = Math.sin(pitch);
      const along = sz * cp - sy * sp;
      const lift = sz * sp + sy * cp;
      // When the mouth is over the target, and how high the body's centre
      // has to be then for the mouth to be at the bite.
      tb = Math.min(tf * 0.48, Math.max(tf * 0.05, (span - along) / vh));
      const yb = Math.max(0.3, c.biteHeight - lift);
      g = (2 * yb) / (tb * (tf - tb));
      pitch = Math.atan2(g * (tf * 0.5 - tb), vh);
    }

    P.g = g;
    P.tf = tf;
    P.tb = tb;
    P.te = Math.max(0.05, c.emergeTime);
    P.td = Math.max(0.05, c.diveTime);
    P.V1.copy(P.s).multiplyScalar(vh).addScaledVector(UP, 0.5 * g * tf);
    P.P0.copy(P.A).addScaledVector(UP, -Math.max(0.5, c.emergeDepth));
    P.V0.copy(P.s).multiplyScalar(vh * 0.15).addScaledVector(UP, Math.max(0.5, c.emergeDepth) / P.te);
    P.V2.copy(P.s).multiplyScalar(vh).addScaledVector(UP, -0.5 * g * tf);
    P.P3.copy(P.B).addScaledVector(P.s, c.diveDrift).addScaledVector(UP, -Math.max(0.5, c.diveDepth));
    P.V3.copy(UP).multiplyScalar((-Math.max(0.5, c.diveDepth) / P.td) * 0.8);

    P.tKick = c.rockDelay + c.rockRise * 0.7;
    P.tBite = P.tKick + Math.max(0.1, c.hangTime);
    P.sharkStart = P.tBite - P.te - tb;
    P.tSurface = P.sharkStart + P.te;
    P.tEntry = P.tSurface + tf;
    P.tEnd = P.tEntry + P.td;
    P.closeA = Math.max(P.tSurface + c.closeDelay, c.openTime);
    P.closeB = P.tEnd + c.closeDelay * 0.5;
    this.plan = P;
    return P;
  }

  /**
   * The body's centre and velocity at `tau` seconds into the shark's run:
   * up its well, through the air, down the far one.
   */
  _path(tau, outP, outV) {
    const P = this._plan;
    if (tau < 0) {
      // Before its run: already coming up the well at the speed it starts with.
      outP.copy(P.P0).addScaledVector(P.V0, tau);
      outV.copy(P.V0);
      return;
    }
    if (tau < P.te) {
      hermite(P.P0, P.V0, P.A, P.V1, P.te, Math.max(0, tau) / P.te, outP, outV);
      return;
    }
    const tf = tau - P.te;
    if (tf < P.tf) {
      outP.copy(P.A).addScaledVector(P.V1, tf).addScaledVector(UP, -0.5 * P.g * tf * tf);
      outV.copy(P.V1).addScaledVector(UP, -P.g * tf);
      return;
    }
    const td = tau - P.te - P.tf;
    if (td < P.td) {
      hermite(P.B, P.V2, P.P3, P.V3, P.td, td / P.td, outP, outV);
      return;
    }
    // Past the bottom of the dive: on down into the dark at the speed it got there with.
    outP.copy(P.P3).addScaledVector(P.V3, td - P.td);
    outV.copy(P.V3);
  }

  /**
   * Where in the clip (0..1) the shark is `tau` seconds into its run.
   *
   * It has to pass the bite frame exactly on the bite, but the run before the
   * bite is far shorter than the run after it, so two straight ramps would
   * play the clip twice as fast up to the bite and then drop to under half
   * speed on that frame — a visible lurch. Two cubic segments sharing their
   * slope at the bite keep the playback rate continuous; the slopes follow
   * Fritsch–Carlson, so the clip never runs backwards.
   */
  _clipAt(tau, tauBite, tEnd) {
    const t1 = Math.max(1e-3, tauBite);
    const t2 = Math.max(1e-3, tEnd - tauBite);
    const r1 = SHARK_BITE_AT / t1;
    const r2 = (1 - SHARK_BITE_AT) / t2;
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
    if (tau < tauBite) return seg(tau / t1, t1, 0, SHARK_BITE_AT, m0, mid);
    return seg((tau - tauBite) / t2, t2, SHARK_BITE_AT, 1, mid, m2);
  }

  /* ------------------------------------------------------------------ */
  /* the show                                                            */
  /* ------------------------------------------------------------------ */

  /** @param {number} t 0..1 the show, 1..2 the stains drying */
  onFade(dt, t) {
    const c = this.config;
    this.fieldAge += dt;
    const P = this._solve(c);
    const age = this.fieldAge;
    const fading = t > 1 ? saturate(t - 1) : 0;

    this._portalFrame(dt, c, age, fading);
    this._rockFrame(dt, c, age);
    this._sharkFrame(dt, c, age);
    this._victimFrame(dt, c, age);
    this._flyChips(dt);
    this._ambient(dt, c, age);
    this._dress(c);
    this._portalLights(dt, c);

    // The camera: the target until the bite, then after the shark to the far portal.
    const follow = smoothstep(P.tBite, P.tEntry, age);
    this.position.copy(P.T).lerp(P.B, follow).setY(1.2 - follow * 0.4);
  }

  /* ---- the portals ---- */

  _portalFrame(dt, c, age, fading) {
    const P = this._plan;
    const full = Math.max(0.1, c.portalRadius);
    const openTime = Math.max(0.02, c.openTime);
    const closeTime = Math.max(0.05, c.closeTime);
    const centres = [P.A, P.B];
    const closes = [P.closeA, P.closeB];

    for (let i = 0; i < 2; i++) {
      const portal = this.portals[i];
      portal.centre.copy(centres[i]);

      // Torn open with an overshoot; spiralled shut.
      const opening = Easing.outBack(saturate((age - i * 0.06) / openTime));
      const closing = saturate((age - closes[i]) / closeTime);
      const shut = Easing.inCubic(closing);
      portal.open = Math.max(0, opening) * (1 - shut);
      portal.radius = full * portal.open;
      portal.spin += dt * c.swirl * (1 + c.closeSwirl * closing * (1 - closing) * 4);
      portal.rune = saturate(age / openTime) * (1 - smoothstep(0.2, 1, closing) * 0.6) * (1 - fading);
      portal.dry = Math.max(fading, closing >= 1 ? 0.15 : 0);

      // The surface closing over itself throws one last ring.
      if (closing > 0 && closing < 0.05 && portal.splash.z > 0.5) portal.splash.set(0, 0, 0, 0.5);

      portal.update(dt, c, 1 - fading * fading);
    }
  }

  _portalLights(dt, c) {
    const g = settings.global;
    for (const portal of this.portals) {
      if (!portal.light) continue;
      _p.copy(portal.centre).setY(0.35);
      const flare = 1 + portal.churn * 3;
      this.ctx.lights.set(
        portal.light,
        _p,
        getColor(c.colorGlow),
        c.portalLight * portal.open * flare * g.lightIntensity,
        c.portalLightRadius * g.lightRadius,
        dt
      );
    }
  }

  /* ---- the rock ---- */

  _rockFrame(dt, c, age) {
    const P = this._plan;
    const rock = this.rock;
    const rockAge = age - c.rockDelay;

    if (rockAge >= 0 && !this.flags.pop) {
      this.flags.pop = true;
      this._pop(c);
    }
    const crumbleAt = Math.max(0.05, c.rockRise) + c.rockHold;
    if (rockAge >= crumbleAt && !this.flags.crumble) {
      this.flags.crumble = true;
      this._crumble(c);
    }

    if (!rock) return;
    if (rockAge < 0 || rockAge > crumbleAt + c.rockSink) {
      rock.visible = false;
      return;
    }
    rock.visible = true;

    const k = this.rig ? c.rockHeight / this.rig.rockHeight : 1;
    const rise = Easing.outBack(saturate(rockAge / Math.max(0.02, c.rockRise)));
    const sink = Easing.inCubic(saturate((rockAge - crumbleAt) / Math.max(0.05, c.rockSink)));
    // Up out of the floor; a shudder while it stands; down again tilting.
    const shudder = Math.sin(rockAge * 70) * 0.012 * (1 - saturate(rockAge * 2));
    rock.position.set(P.T.x + shudder, -c.rockHeight * (1 - rise) - c.rockHeight * 1.05 * sink, P.T.z);
    rock.rotation.set(sink * 0.25, this.rockYaw, sink * 0.18);
    rock.scale.set(k * c.rockWidth * (0.7 + 0.3 * rise), k, k * c.rockWidth * (0.7 + 0.3 * rise));
    this.rockMaterial.userData.sync({ dust: saturate(rockAge / 1.2) });
  }

  /** The floor breaks and the spike comes up. */
  _pop(c) {
    const g = settings.global;
    const P = this._plan;
    const time = frame.uTime.value;

    this.ctx.decals.spawn(DecalType.CRACK, P.T, {
      radius: 2.2,
      life: 3.5,
      intensity: 0.45,
      colorA: getColor(c.colorShallow),
      colorB: getColor('#070809')
    });
    this.ctx.decals.spawn(DecalType.DUSTRING, P.T, {
      radius: 2.6,
      life: 1.6,
      intensity: 0.4,
      growth: 0.6,
      colorA: getColor(c.colorDust),
      colorB: getColor('#2a2622')
    });
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, P.T, {
      radius: 3.2,
      life: 0.5,
      intensity: 0.6,
      width: 0.05,
      colorA: getColor(c.colorDustCoat),
      colorB: getColor(c.colorDust)
    });

    /* chunks of floor thrown off it */
    const chips = Math.round(c.rockChips * Math.min(1.5, g.particleCount));
    for (let i = 0; i < chips; i++) {
      const a = Math.random() * TAU;
      const r = 0.2 + Math.random() * 0.5;
      _p.set(P.T.x + Math.cos(a) * r, 0.1 + Math.random() * 0.6, P.T.z + Math.sin(a) * r);
      _v.set(Math.cos(a) * (2.5 + Math.random() * 4.5), 4 + Math.random() * 7, Math.sin(a) * (2.5 + Math.random() * 4.5));
      this._throwChip(_p, _v, 0.08 + Math.pow(Math.random(), 2) * 0.2);
    }

    /* grit and dust */
    _emit.position.copy(P.T).setY(0.15);
    _emit.direction.set(0, 1, 0);
    _emit.radius = 0.5;
    _emit.speed = 7;
    _emit.speedVariance = 0.6;
    _emit.spread = 0.75;
    _emit.size = 0.07;
    _emit.sizeVariance = 0.6;
    _emit.life = 1.1;
    _emit.lifeVariance = 0.4;
    _emit.spin = 9;
    _emit.tint = null;
    _emit.time = time;
    this.grit.emit(Math.round(c.rockGrit * g.particleCount), _emit);

    for (let i = 0; i < Math.round(c.rockDust * g.particleCount); i++) {
      const a = Math.random() * TAU;
      _emit.position.set(P.T.x + Math.cos(a) * 0.5, 0.25, P.T.z + Math.sin(a) * 0.5);
      _emit.direction.set(Math.cos(a), 0.35, Math.sin(a));
      _emit.radius = 0.2;
      _emit.speed = 3.2;
      _emit.speedVariance = 0.5;
      _emit.spread = 0.35;
      _emit.size = 0.9;
      _emit.sizeVariance = 0.4;
      _emit.life = 1.7;
      _emit.lifeVariance = 0.35;
      _emit.spin = 1.2;
      this.dust.emit(1, _emit);
    }

    this.lightBoost = Math.max(this.lightBoost, 12 * g.explosionIntensity);
    this.ctx.shake.add(c.rockShake * g.explosionIntensity * g.cameraShake, 2.6, 24);
  }

  /** It goes back where it came from, shedding as it goes. */
  _crumble(c) {
    const g = settings.global;
    const P = this._plan;
    for (let i = 0; i < Math.round(c.rockDust * 0.6 * g.particleCount); i++) {
      const a = Math.random() * TAU;
      _emit.position.set(P.T.x + Math.cos(a) * 0.4, 0.3 + Math.random() * 0.8, P.T.z + Math.sin(a) * 0.4);
      _emit.direction.set(Math.cos(a), 0.15, Math.sin(a));
      _emit.radius = 0.2;
      _emit.speed = 1.2;
      _emit.speedVariance = 0.5;
      _emit.spread = 0.5;
      _emit.size = 0.7;
      _emit.sizeVariance = 0.4;
      _emit.life = 1.6;
      _emit.lifeVariance = 0.3;
      _emit.spin = 1;
      _emit.tint = null;
      _emit.time = frame.uTime.value;
      this.dust.emit(1, _emit);
    }
    for (let i = 0; i < 8; i++) {
      const a = Math.random() * TAU;
      _p.set(P.T.x + Math.cos(a) * 0.3, 0.4 + Math.random() * 0.9, P.T.z + Math.sin(a) * 0.3);
      _v.set(Math.cos(a) * 1.5, 1 + Math.random() * 2, Math.sin(a) * 1.5);
      this._throwChip(_p, _v, 0.06 + Math.random() * 0.1);
    }
  }

  _throwChip(position, velocity, size) {
    const chip = this._chips.find((ch) => !ch.live);
    if (!chip) return;
    chip.live = true;
    chip.pos.copy(position);
    chip.vel.copy(velocity);
    chip.quat.setFromAxisAngle(_a.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(), Math.random() * TAU);
    chip.axis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    chip.spin = 6 + Math.random() * 12;
    chip.size = size;
    chip.age = 0;
  }

  /** Ballistic, bouncing on the stone — and falling straight through an open portal. */
  _flyChips(dt) {
    const gravity = settings.dummies.ragdoll.gravity;
    for (const chip of this._chips) {
      if (!chip.live) continue;
      chip.age += dt;
      chip.vel.y += gravity * dt;
      chip.pos.addScaledVector(chip.vel, dt);
      chip.quat.multiply(_q.setFromAxisAngle(chip.axis, chip.spin * dt));

      let overWater = false;
      for (const portal of this.portals) {
        const dx = chip.pos.x - portal.centre.x;
        const dz = chip.pos.z - portal.centre.z;
        if (dx * dx + dz * dz < portal.radius * portal.radius) overWater = true;
      }
      const floor = chip.size * 0.35;
      if (!overWater && chip.pos.y < floor && chip.age < 2.4) {
        chip.pos.y = floor;
        if (chip.vel.y < 0) chip.vel.y *= -0.28;
        chip.vel.x *= 0.62;
        chip.vel.z *= 0.62;
        chip.spin *= 0.6;
      }
      // Settled ones sink back into the floor they came out of.
      if (chip.age > 2.4) chip.pos.y -= dt * 0.25;
      if (chip.pos.y < -2.5 || chip.age > 4) chip.live = false;
    }
    this._syncChips();
  }

  _syncChips() {
    const mesh = this.chipMesh;
    if (!mesh) return;
    let n = 0;
    for (const chip of this._chips) {
      if (!chip.live) continue;
      _s.setScalar(chip.size);
      _m.compose(chip.pos, chip.quat, _s);
      mesh.setMatrixAt(n++, _m);
    }
    mesh.count = n;
    mesh.visible = n > 0;
    mesh.instanceMatrix.needsUpdate = true;
  }

  /* ---- the shark ---- */

  _sharkFrame(dt, c, age) {
    const P = this._plan;
    const tau = age - P.sharkStart;
    const tEnd = P.te + P.tf + P.td;
    // Visible a little before its run and after its dive, so it rises out of
    // and sinks into the well's murk rather than popping in and out in the
    // open hole; the floor hides it everywhere else.
    const preRoll = 0.35;
    const postRoll = Math.max(0.3, P.closeB + Math.max(0.05, c.closeTime) - P.sharkStart - tEnd);
    if (tau < -preRoll || tau > tEnd + postRoll) {
      this.root.visible = false;
      return;
    }
    this.root.visible = !!this.shark;

    this._path(tau, this.sharkPos, this.sharkVel);
    this.root.position.copy(this.sharkPos);

    // Nose along the arc. The arc lies in the vertical plane through both
    // portals, so the lateral axis is fixed and the frame never degenerates,
    // not even going straight up its well.
    _z.copy(this.sharkVel);
    if (_z.lengthSq() < 1e-6) _z.copy(P.s);
    _z.normalize();
    _x.copy(P.lat);
    _y.crossVectors(_z, _x).normalize();
    _x.crossVectors(_y, _z).normalize();
    _m.makeBasis(_x, _y, _z);
    _q.setFromRotationMatrix(_m);
    // The death roll, once it has the body.
    const tauBite = P.te + P.tb;
    // A full roll is optional (it turns it belly-up); the default is a thrash —
    // a few side-to-side rolls of the body that ease in and die away, never
    // tipping it past `thrashRoll` degrees.
    const sinceBite = tau - tauBite - 0.03;
    const turn = c.deathRoll * TAU * Easing.inOutCubic(saturate(sinceBite / Math.max(0.05, c.rollTime)));
    const thrashLife = Math.max(0.1, c.thrashTime);
    const thrashEnv = sinceBite > 0 ? smoothstep(0, 0.12, sinceBite) * (1 - smoothstep(0, thrashLife, sinceBite)) : 0;
    const thrash = (c.thrashRoll * Math.PI) / 180 * thrashEnv * Math.sin(sinceBite * TAU * c.thrashRate);
    const roll = turn + thrash;
    _roll.setFromAxisAngle(_a.set(0, 0, 1), roll * this.sweep);
    this.root.quaternion.copy(_q).multiply(_roll);
    this.frame.scale.setScalar(this.scaleK);

    // The clip, played against the arc: its bite frame on the bite.
    const shark = this.shark;
    if (shark?.breach) {
      const action = shark.breach;
      const duration = action.getClip().duration;
      const u = this._clipAt(tau, tauBite, tEnd);
      action.enabled = true;
      action.paused = false;
      action.time = Math.min(duration - 1e-4, Math.max(0, u * duration));
      shark.mixer.update(0);
    }

    this.root.updateMatrixWorld(true);
    this._socketWorld(this.socket);

    for (const material of this.sharkMaterials) material.userData.sync({ wet: 1 });

    /* ---- the two surfaces it goes through ---- */
    if (tau >= P.te && !this.flags.surface) {
      this.flags.surface = true;
      this._splash(this.portals[0], 1, c);
    }
    if (tau >= P.te + P.tf && !this.flags.entry) {
      this.flags.entry = true;
      this._splash(this.portals[1], c.entryScale, c);
    }

    /* ---- water off it while it is in the air ---- */
    if (this.sharkPos.y > -0.5 && tau < P.te + P.tf + 0.2 && shark) {
      const g = settings.global;
      const n = this._drips.tick(dt, c.dripRate * g.particleCount);
      const time = frame.uTime.value;
      for (let i = 0; i < n; i++) {
        // Anywhere along the body, nose to tail.
        const along = (Math.random() - 0.5) * c.length * 0.85;
        _emit.position.copy(this.sharkPos).addScaledVector(_z, along).addScaledVector(_y, (Math.random() - 0.3) * 0.35);
        if (_emit.position.y < 0.05) continue;
        _emit.direction.copy(this.sharkVel).multiplyScalar(0.35).addScaledVector(UP, -1).normalize();
        _emit.radius = 0.25;
        _emit.speed = this.sharkVel.length() * 0.35;
        _emit.speedVariance = 0.5;
        _emit.spread = 0.3;
        _emit.size = 0.026;
        _emit.sizeVariance = 0.6;
        _emit.life = 0.7;
        _emit.lifeVariance = 0.4;
        _emit.spin = 0;
        _emit.tint = null;
        _emit.time = time;
        this.spray.emit(1, _emit);
      }
    }
  }

  /** A crossing of the surface: the crown, the spray, the mist, the hit of it. */
  _splash(portal, scale, c) {
    const g = settings.global;
    const time = frame.uTime.value;
    const at = portal.centre;
    portal.breach(this.sharkPos, scale);

    const R = Math.max(0.2, portal.radius || c.portalRadius);
    const count = Math.round(c.sprayCount * scale * g.particleCount);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU;
      const r = Math.sqrt(Math.random()) * R * 0.75;
      _emit.position.set(at.x + Math.cos(a) * r, 0.05, at.z + Math.sin(a) * r);
      // Up, out from the middle, and dragged along by the animal.
      _emit.direction.set(Math.cos(a) * 0.55, 1.6, Math.sin(a) * 0.55).addScaledVector(this._plan.s, 0.35).normalize();
      _emit.radius = 0.1;
      _emit.speed = c.spraySpeed * (0.45 + Math.random() * 0.75) * Math.sqrt(scale);
      _emit.speedVariance = 0.3;
      _emit.spread = 0.3;
      _emit.size = 0.025 + Math.random() * 0.04;
      _emit.sizeVariance = 0.4;
      _emit.life = 1.1;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.spray.emit(1, _emit);
    }
    _emit.position.copy(at).setY(0.1);
    _emit.direction.set(0, 1, 0);
    _emit.radius = R * 0.5;
    _emit.speed = c.spraySpeed * 1.3 * Math.sqrt(scale);
    _emit.speedVariance = 0.4;
    _emit.spread = 0.45;
    _emit.size = 0.035;
    _emit.sizeVariance = 0.4;
    _emit.life = 0.55;
    _emit.lifeVariance = 0.4;
    this.streaks.emit(Math.round(count * 0.4), _emit);

    for (let i = 0; i < Math.round(c.mistCount * scale * g.particleCount); i++) {
      const a = Math.random() * TAU;
      _emit.position.set(at.x + Math.cos(a) * R * 0.6, 0.3 + Math.random() * 1.2 * scale, at.z + Math.sin(a) * R * 0.6);
      _emit.direction.set(Math.cos(a) * 0.6, 1, Math.sin(a) * 0.6).normalize();
      _emit.radius = 0.3;
      _emit.speed = 1.6;
      _emit.speedVariance = 0.5;
      _emit.spread = 0.4;
      _emit.size = 0.6 * scale;
      _emit.sizeVariance = 0.4;
      _emit.life = 1.0;
      _emit.lifeVariance = 0.35;
      _emit.spin = 1.2;
      this.mist.emit(1, _emit);
    }
    _emit.position.copy(at).setY(0.6);
    _emit.radius = R * 0.6;
    _emit.speed = 0.5;
    _emit.size = 0.35;
    _emit.life = 0.35;
    _emit.spin = 4;
    this.glints.emit(Math.round(14 * scale), _emit);

    _p.copy(at).setY(0.15);
    this.ctx.bursts.spawn(BurstMode.WATER, _p, {
      radius: R * 0.4,
      endRadius: R * 1.5 * scale,
      life: 0.55,
      intensity: 0.7 * g.explosionIntensity,
      opacity: 0.35,
      squash: 0.45,
      colorA: getColor(c.colorFoam),
      colorB: getColor(c.colorShallow),
      colorC: getColor(c.colorDeep)
    });
    this.ctx.decals.spawn(DecalType.FOAM, at, {
      radius: R * 1.45 * scale,
      life: 2.2,
      intensity: 0.3,
      growth: 0.4,
      colorA: getColor(c.colorFoam),
      colorB: getColor(c.colorShallow)
    });
    this.ctx.decals.spawn(DecalType.RIPPLE, at, {
      radius: R * 2.4 * scale,
      life: 1.2,
      intensity: 0.3,
      colorA: getColor(c.colorFoam),
      colorB: getColor(c.colorShallow)
    });

    this.lightBoost = Math.max(this.lightBoost, c.splashLight * scale * g.explosionIntensity);
    this.ctx.shake.add(c.splashShake * scale * g.explosionIntensity * g.cameraShake, 2.2, 18);
    if (c.splashFlash > 0) this.ctx.flash.trigger(getColor(c.colorFoam), c.splashFlash * scale * g.explosionIntensity);
  }

  /* ---- the body ---- */

  _victimFrame(dt, c, age) {
    const P = this._plan;
    const victim = this.victim;
    if (!victim || this.victimDone) return;

    /* the kick */
    if (age >= P.tKick && !this.flags.kick) {
      this.flags.kick = true;
      if (!victim.alive) {
        // Something else got there first. The jaw closes on nothing.
        this.victim = null;
        return;
      }
      victim.kill(this.direction.x, this.direction.z, c.kick);
      if (!victim.bodyPoint(this.hips0)) this.hips0.copy(victim.position).setY(1);
    }
    if (!this.flags.kick) return;

    const hold = this.held;
    if (!hold && age < P.tBite) {
      // The kick's flight, steered onto the bite. Ballistic under the
      // body's own gravity, solved to reach the jaw's point on the jaw's
      // frame; held by the hips on a leash, so the limbs still flail.
      const H = Math.max(0.05, P.tBite - P.tKick);
      const tk = age - P.tKick;
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
      // Under the floor from here: the far well is where it is going.
      victim.sink(c.diveDepth + c.wellDepth);
      this._biteFx(c);
    }

    // Snapped into the jaw over a few frames, then held hard.
    const snap = saturate((age - P.tBite) / Math.max(0.01, c.biteSnap));
    const joint = c.grabJoint || 'Spine';
    if (!victim.pin(joint, this.socket, 0.2 + 0.8 * snap)) victim.pin('Hips', this.socket, 0.2 + 0.8 * snap);

    // The deep takes it as it goes under.
    if (victim.bodyPoint(_p)) {
      const under = -_p.y;
      if (under > 0) victim.consume(saturate(under / Math.max(0.1, c.dissolveDepth)));
      // Water streaming off it while it is still in the air.
      if (_p.y > 0.2) {
        const n = this._bodyDrips.tick(dt, c.dripRate * 0.5 * settings.global.particleCount);
        _emit.position.copy(_p);
        _emit.direction.set(0, -1, 0);
        _emit.radius = 0.35;
        _emit.speed = 1;
        _emit.speedVariance = 0.5;
        _emit.spread = 0.4;
        _emit.size = 0.024;
        _emit.sizeVariance = 0.5;
        _emit.life = 0.6;
        _emit.lifeVariance = 0.4;
        _emit.spin = 0;
        _emit.tint = null;
        _emit.time = frame.uTime.value;
        this.spray.emit(n, _emit);
      }
    }

    if (age > P.tEnd + 0.25) {
      victim.consume(1);
      victim.unpin();
      this.victimDone = true;
      this.held = false;
      this.victim = null;
    }
  }

  /** The jaw closing: spray off the teeth, a flash, the hit of it. */
  _biteFx(c) {
    const g = settings.global;
    const time = frame.uTime.value;
    _emit.position.copy(this.socket);
    _emit.direction.copy(this.sharkVel).normalize();
    _emit.radius = 0.3;
    _emit.speed = 6;
    _emit.speedVariance = 0.5;
    _emit.spread = 0.9;
    _emit.size = 0.03;
    _emit.sizeVariance = 0.5;
    _emit.life = 0.8;
    _emit.lifeVariance = 0.4;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.spray.emit(Math.round(c.biteSpray * g.particleCount), _emit);
    _emit.speed = 9;
    _emit.size = 0.03;
    _emit.life = 0.4;
    this.streaks.emit(Math.round(c.biteSpray * 0.4 * g.particleCount), _emit);

    _emit.radius = 0;
    _emit.speed = 0;
    _emit.spread = 0;
    _emit.size = 1.8;
    _emit.sizeVariance = 0.2;
    _emit.life = 0.12;
    _emit.spin = 3;
    this.glints.emit(1, _emit);

    _emit.radius = 0.3;
    _emit.direction.set(0, 1, 0);
    _emit.speed = 0.8;
    _emit.spread = 0.8;
    _emit.size = 0.8;
    _emit.life = 1.1;
    _emit.spin = 1;
    this.mist.emit(Math.round(6 * g.particleCount), _emit);

    this.lightBoost = Math.max(this.lightBoost, c.biteLight * g.explosionIntensity);
    this.ctx.shake.add(c.biteShake * g.explosionIntensity * g.cameraShake, 3.2, 26);
    if (c.biteFlash > 0) this.ctx.flash.trigger(getColor(c.colorFoam), c.biteFlash * g.explosionIntensity);
  }

  /* ---- the air round it ---- */

  _ambient(dt, c, age) {
    const g = settings.global;
    const time = frame.uTime.value;
    for (const portal of this.portals) {
      if (portal.radius < 0.2) continue;
      // Vapour coming off the water, and the sun glinting on it.
      const n = this._mist.tick(dt, 3 * g.particleCount);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * TAU;
        const r = Math.sqrt(Math.random()) * portal.radius;
        _emit.position.set(portal.centre.x + Math.cos(a) * r, 0.1, portal.centre.z + Math.sin(a) * r);
        _emit.direction.set(0, 1, 0);
        _emit.radius = 0.1;
        _emit.speed = 0.35;
        _emit.speedVariance = 0.5;
        _emit.spread = 0.3;
        _emit.size = 0.45;
        _emit.sizeVariance = 0.4;
        _emit.life = 1.6;
        _emit.lifeVariance = 0.3;
        _emit.spin = 0.6;
        _emit.tint = null;
        _emit.time = time;
        this.mist.emit(1, _emit);
      }
      const m = this._glints.tick(dt, 6 * portal.open * g.particleCount);
      for (let i = 0; i < m; i++) {
        const a = Math.random() * TAU;
        const r = Math.sqrt(Math.random()) * portal.radius * 0.9;
        _emit.position.set(portal.centre.x + Math.cos(a) * r, 0.04, portal.centre.z + Math.sin(a) * r);
        _emit.direction.set(0, 1, 0);
        _emit.radius = 0;
        _emit.speed = 0.05;
        _emit.spread = 0;
        _emit.size = 0.18;
        _emit.sizeVariance = 0.5;
        _emit.life = 0.35;
        _emit.lifeVariance = 0.5;
        _emit.spin = 2;
        _emit.time = time;
        this.glints.emit(1, _emit);
      }
    }
  }

  /* ---- the look of every particle system, every frame ---- */

  _dress(c) {
    const g = settings.global;
    {
      const u = this.spray.uniforms;
      this.spray.setGradient(getColor(c.colorMist), getColor(c.colorMist), getColor(c.colorShallow), getColor(c.colorShallow));
      u.uGravity.value.set(0, -16, 0);
      u.uDrag.value = 0.5;
      u.uTurbulence.value = 0.1;
      u.uStretch.value = 0.05;
      u.uEndSize.value = 0.6;
      u.uSizeIn.value = 0.02;
      u.uFadeIn.value = 0.02;
      u.uFadeOut.value = 0.6;
      u.uGlow.value = 0.9;
      u.uOpacity.value = 0.6;
    }
    {
      const u = this.streaks.uniforms;
      this.streaks.setGradient(getColor('#ffffff'), getColor(c.colorFoam), getColor(c.colorGlow), getColor(c.colorShallow));
      u.uGravity.value.set(0, -14, 0);
      u.uDrag.value = 0.9;
      u.uTurbulence.value = 0.1;
      u.uStretch.value = 0.07;
      u.uEndSize.value = 0.4;
      u.uFadeOut.value = 0.5;
      u.uGlow.value = 1.4 * g.glow;
      u.uOpacity.value = 0.8;
    }
    {
      const u = this.mist.uniforms;
      this.mist.setGradient(getColor(c.colorFoam), getColor(c.colorMist), getColor(c.colorMist), getColor(c.colorShallow));
      u.uGravity.value.set(0, 0.5, 0);
      u.uDrag.value = 1.6;
      u.uTurbulence.value = 0.5 * g.turbulence;
      u.uTurbFrequency.value = 0.8;
      u.uEndSize.value = 1.9;
      u.uFadeIn.value = 0.06;
      u.uFadeOut.value = 0.35;
      u.uGlow.value = 0.75;
      u.uOpacity.value = 0.2;
    }
    {
      const u = this.dust.uniforms;
      this.dust.setGradient(getColor(c.colorDustCoat), getColor(c.colorDust), getColor(c.colorDust), getColor('#2a2622'));
      u.uGravity.value.set(0, 0.25, 0);
      u.uDrag.value = 2.2;
      u.uTurbulence.value = 0.45 * g.turbulence;
      u.uTurbFrequency.value = 0.9;
      u.uEndSize.value = 3.0;
      u.uFadeIn.value = 0.08;
      u.uFadeOut.value = 0.4;
      u.uGlow.value = 0.35;
      u.uOpacity.value = 0.55;
    }
    {
      const u = this.grit.uniforms;
      this.grit.setGradient(getColor(c.colorStone), getColor(c.colorStone), getColor(c.colorStoneDeep), getColor(c.colorStoneDeep));
      u.uGravity.value.set(0, -17, 0);
      u.uDrag.value = 0.4;
      u.uTurbulence.value = 0;
      u.uEndSize.value = 0.9;
      u.uFadeOut.value = 0.8;
      u.uGlow.value = 0.55;
      u.uOpacity.value = 1;
    }
    {
      const u = this.glints.uniforms;
      this.glints.setGradient(getColor('#ffffff'), getColor(c.colorFoam), getColor(c.colorGlow), getColor(c.colorGlow));
      u.uGravity.value.set(0, 0, 0);
      u.uDrag.value = 1;
      u.uTurbulence.value = 0;
      u.uEndSize.value = 0.6;
      u.uSizeIn.value = 0.001;
      u.uFadeIn.value = 0;
      u.uFadeOut.value = 0.4;
      u.uGlow.value = 2.4 * g.glow;
      u.uOpacity.value = 1;
    }
  }
}
