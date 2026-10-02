import {
  AnimationMixer,
  Color,
  DoubleSide,
  Group,
  MathUtils,
  Matrix4,
  MeshDepthMaterial,
  MeshStandardMaterial,
  RGBADepthPacking,
  BufferAttribute,
  Vector2,
  Vector3,
  Vector4
} from 'three';
import { clone as cloneRigged } from 'three/addons/utils/SkeletonUtils.js';

import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { LAYER } from '../core/Layers.js';
import { JOINT_NAMES, Ragdoll, collideRagdolls, stripNamespace } from './Ragdoll.js';

/**
 * The pieces a body can be torn into, besides what is left of it.
 *
 * Each is a limb hanging off one joint of the trunk (`socket`) by its first
 * bone (`root`). `slot` is where its membership lives in the two vertex
 * attributes `tagTearRegions` writes — `aTearA` holds head and arms, `aTearB`
 * the legs — and `joints` is what the piece's own solver simulates once it is
 * off, on top of the socket it came out of (see `tear`).
 */
export const TEAR_REGIONS = Object.freeze({
  head: { slot: 0, root: 'Head', socket: 'Neck', joints: ['Head', 'HeadTop_End'] },
  armL: { slot: 1, root: 'LeftArm', socket: 'LeftShoulder', joints: ['LeftArm', 'LeftForeArm', 'LeftHand'] },
  armR: { slot: 2, root: 'RightArm', socket: 'RightShoulder', joints: ['RightArm', 'RightForeArm', 'RightHand'] },
  legL: {
    slot: 3,
    root: 'LeftUpLeg',
    socket: 'Hips',
    joints: ['LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase', 'LeftToe_End']
  },
  legR: {
    slot: 4,
    root: 'RightUpLeg',
    socket: 'Hips',
    joints: ['RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase', 'RightToe_End']
  }
});

/** Each region's own joints, as a set — what stays rigid when it is loosened. */
const REGION_JOINTS = Object.fromEntries(
  Object.entries(TEAR_REGIONS).map(([name, region]) => [name, new Set(region.joints)])
);

/** root bone → slot, for walking a skeleton up to the region it hangs in. */
const ROOT_SLOT = Object.fromEntries(Object.values(TEAR_REGIONS).map((region) => [region.root, region.slot]));

/**
 * How much of every vertex belongs to each limb, off its skin weights.
 *
 * A bone belongs to a region if the region's root is the bone itself or any
 * bone above it — so the fingers are the arm's and the eyes the head's — and a
 * vertex belongs to it by the share of its weight those bones carry. Across a
 * joint that share runs smoothly from 1 to 0 over exactly the skin the rig
 * blends there, which is the band a limb tears through: threshold it at a half
 * and the trunk and the limb get complementary halves of the same seam, with
 * nothing missing and nothing drawn twice.
 *
 * Written onto the geometry, which every dummy shares, so it is paid once.
 */
function tagTearRegions(model) {
  model.traverse((node) => {
    if (!node.isSkinnedMesh) return;
    const geometry = node.geometry;
    if (geometry.getAttribute('aTearA')) return;
    const index = geometry.getAttribute('skinIndex');
    const weight = geometry.getAttribute('skinWeight');
    const count = geometry.getAttribute('position').count;
    const a = new Float32Array(count * 3);
    const b = new Float32Array(count * 2);
    // Which region each of the four influences belongs to, -1 for the trunk.
    const bones = new Float32Array(count * 4).fill(-1);

    if (index && weight) {
      const slots = node.skeleton.bones.map((bone) => {
        for (let current = bone; current; current = current.parent) {
          const slot = ROOT_SLOT[stripNamespace(current.name)];
          if (slot !== undefined) return slot;
        }
        return -1;
      });
      for (let v = 0; v < count; v++) {
        for (let k = 0; k < 4; k++) {
          const slot = slots[index.getComponent(v, k)] ?? -1;
          bones[v * 4 + k] = slot;
          const w = weight.getComponent(v, k);
          if (w <= 0) continue;
          if (slot < 0) continue;
          if (slot < 3) a[v * 3 + slot] += w;
          else b[v * 2 + slot - 3] += w;
        }
      }
    }
    geometry.setAttribute('aTearA', new BufferAttribute(a, 3));
    geometry.setAttribute('aTearB', new BufferAttribute(b, 2));
    geometry.setAttribute('aTearBone', new BufferAttribute(bones, 4));
  });
}

/**
 * Skinning for a torn-off piece.
 *
 * A limb's copy of the rig simulates the limb and the socket it came out of;
 * every bone further up the trunk stays wherever it was when the limb came
 * away. Skin across the seam is weighted partly to those bones, so left alone
 * it stays anchored to the spot the body was in and stretches after the limb
 * as a sheet across the stage. On a limb, then, any influence from outside
 * it is handed to the socket instead — which travels with the limb — and the
 * seam comes away in one piece. The trunk needs nothing: the bones of a limb
 * it has lost are children of bones it still simulates, and simply ride along.
 */
const TEAR_SKINBASE = /* glsl */ `
  #ifdef USE_SKINNING
    vec4 tearIndex = skinIndex;
    if (uTearKeep > 0.5) {
      float keep = uTearKeep - 1.0;
      if (abs(aTearBone.x - keep) > 0.5) tearIndex.x = uTearSocket;
      if (abs(aTearBone.y - keep) > 0.5) tearIndex.y = uTearSocket;
      if (abs(aTearBone.z - keep) > 0.5) tearIndex.z = uTearSocket;
      if (abs(aTearBone.w - keep) > 0.5) tearIndex.w = uTearSocket;
    }
    mat4 boneMatX = getBoneMatrix( tearIndex.x );
    mat4 boneMatY = getBoneMatrix( tearIndex.y );
    mat4 boneMatZ = getBoneMatrix( tearIndex.z );
    mat4 boneMatW = getBoneMatrix( tearIndex.w );
  #endif
`;

/**
 * Which side of a tear a fragment is on, shared by the colour and depth passes
 * so the shadow comes apart exactly where the body does.
 *
 * `tearSide` is positive on the side this piece keeps and measures how far
 * into it the fragment is, in membership units. The seam is pushed about by
 * noise in *bind* space, so the edge is ragged and the rag stays stuck to the
 * body however the pieces tumble — and because the trunk and the limb read the
 * same noise with opposite signs, their two ragged edges are one edge.
 */
const TEAR_GLSL = /* glsl */ `
  uniform float uTearKeep;
  uniform vec3 uTornA;
  uniform vec2 uTornB;
  uniform float uTearNoise;
  uniform float uTearScale;
  uniform vec4 uClip;
  varying vec3 vTearA;
  varying vec2 vTearB;
  varying vec3 vWorldPos;

  float tearNoise(vec3 p) {
    return (snoise(p * uTearScale) * 0.65 + snoise(p * uTearScale * 2.7 + 11.3) * 0.35) * uTearNoise;
  }

  float tearOwn(int k) {
    return k == 0 ? vTearA.x : k == 1 ? vTearA.y : k == 2 ? vTearA.z : k == 3 ? vTearB.x : vTearB.y;
  }

  float tearSideOf(float n) {
    if (uTearKeep < -0.5) return 1.0;
    if (uTearKeep < 0.5) {
      float own = max(
        max(vTearA.x * uTornA.x, vTearA.y * uTornA.y),
        max(vTearA.z * uTornA.z, max(vTearB.x * uTornB.x, vTearB.y * uTornB.y))
      );
      return 0.5 - (own + n);
    }
    return tearOwn(int(uTearKeep + 0.5) - 1) + n - 0.5;
  }

  /** How far in front of the portal a fragment is; negative once it is through. */
  float clipSideOf() {
    if (dot(uClip.xyz, uClip.xyz) < 0.5) return 1e3;
    return dot(vWorldPos, uClip.xyz) - uClip.w;
  }
`;

/** The vertex half of the tear: membership through, and the posed world point. */
const TEAR_VERTEX_DECL = /* glsl */ `
  attribute vec3 aTearA;
  attribute vec2 aTearB;
  attribute vec4 aTearBone;
  uniform float uTearKeep;
  uniform float uTearSocket;
  varying vec3 vTearA;
  varying vec2 vTearB;
  varying vec3 vWorldPos;
`;
const TEAR_VERTEX_MAIN = /* glsl */ `
  vTearA = aTearA;
  vTearB = aTearB;
  vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
`;

/**
 * Which joints each half of a cut body simulates.
 *
 * Both keep `Hips` (a chain needs a root) and `Spine` (the stump either side of
 * the plane). Beyond that they are disjoint, and that is the point: leave the
 * legs in the top half's solver and they land on the ground holding an
 * invisible pelvis a metre in the air, with the visible torso hanging off it.
 */
const LOWER_JOINTS = new Set([
  'Hips',
  'Spine',
  'LeftUpLeg',
  'LeftLeg',
  'LeftFoot',
  'LeftToeBase',
  'LeftToe_End',
  'RightUpLeg',
  'RightLeg',
  'RightFoot',
  'RightToeBase',
  'RightToe_End'
]);

const UPPER_JOINTS = new Set([
  'Hips',
  'Spine',
  'Spine1',
  'Spine2',
  'Neck',
  'Head',
  'HeadTop_End',
  'LeftShoulder',
  'LeftArm',
  'LeftForeArm',
  'LeftHand',
  'RightShoulder',
  'RightArm',
  'RightForeArm',
  'RightHand'
]);

/**
 * Which joints each half is *solid* with — see `collideRagdolls`.
 *
 * A subset of the sets above, and the difference is the whole reason it is a
 * second pair of sets rather than a reuse of the first. `Hips` and `Spine` are
 * simulated by both halves (a chain needs a root, and the stump either side of
 * the plane has to be driven), so on the frame of the cut they sit on top of
 * each other — made solid, the two halves would shove each other across the
 * field before the beam had finished going through. So the top half's copies of
 * them are not solid, and neither is `Spine1`, which is the first joint above
 * the plane and still inside the pelvis it was cut off.
 *
 * What is left on each side is the geometry a viewer can actually see: a pelvis
 * and two legs against a ribcage, a head and two arms.
 */
const LOWER_CONTACTS = new Set([
  'Hips',
  'LeftUpLeg',
  'LeftLeg',
  'LeftFoot',
  'LeftToeBase',
  'LeftToe_End',
  'RightUpLeg',
  'RightLeg',
  'RightFoot',
  'RightToeBase',
  'RightToe_End'
]);

const UPPER_CONTACTS = new Set([
  'Spine2',
  'Neck',
  'Head',
  'HeadTop_End',
  'LeftShoulder',
  'LeftArm',
  'LeftForeArm',
  'LeftHand',
  'RightShoulder',
  'RightArm',
  'RightForeArm',
  'RightHand'
]);

const UP = /* @__PURE__ */ new Vector3(0, 1, 0);

const _cutNormal = /* @__PURE__ */ new Vector3();
const _cutNormalBind = /* @__PURE__ */ new Vector3();
const _cutNormalWorld = /* @__PURE__ */ new Vector3();
const _cutPoint = /* @__PURE__ */ new Vector3();
const _scratch = /* @__PURE__ */ new Vector3();

/**
 * A node's transform relative to one of its ancestors.
 *
 * Walks up the chain and multiplies the local matrices — no world matrices are
 * needed, so this is valid before the body has ever been added to a scene.
 */
function matrixRelativeTo(node, ancestor, out) {
  const chain = [];
  for (let current = node; current && current !== ancestor; current = current.parent) {
    chain.push(current);
  }

  out.identity();
  for (let i = chain.length - 1; i >= 0; i--) {
    chain[i].updateMatrix();
    out.multiply(chain[i].matrix);
  }
  return out;
}

/**
 * One target dummy: a rigged body that stands there breathing until an ability
 * reaches it, then falls over as a ragdoll and burns away — in one piece, or in
 * two if whatever reached it came with an edge on it.
 *
 * ## The handover
 *
 * The animation is not faded out when it dies, it is **abandoned** mid-frame:
 * the mixer is stopped, the skeleton's world matrices are brought up to date,
 * and the solver reads that pose as its first frame. There is nothing to blend
 * because the pose is continuous by construction — which is the only way a fall
 * ever looks like it happened to the body that was standing there.
 *
 * ## Being cut in half
 *
 * A cut is one plane and one clone. The body's mesh is duplicated, each copy is
 * told which side of the plane it keeps (a `discard` in the fragment shader),
 * and each gets its own solver seeded with only the joints that half actually
 * owns. Because the material has been double-sided since birth, the far wall of
 * the shell is already being rasterised — painting *that* as meat is the whole
 * of the cross-section: no cap geometry, no re-tessellation, and it is right
 * from every angle for free.
 *
 * The plane lives in the geometry's **bind** space, which is the one space no
 * bone can move: a cut measured at the waist stays at the waist however far the
 * corpse folds. See `_measureBind` for why that is not the rig's space.
 *
 * ## Its look
 *
 * The export carries no textures at all, so the material is authored here
 * rather than imported: a cold near-black body with a fresnel rim, so the
 * silhouette reads against the stage floor from across the arena, and a noise
 * dissolve that burns the corpse away when its time is up. Every dummy owns its
 * materials — the dissolve is per-body, and half a dozen materials is nothing
 * next to being able to give each corpse its own clock.
 *
 * @see Ragdoll for the solver, and DummyField for who spawns these.
 */
export class Dummy {
  /**
   * @param {object} options
   * @param {import('three').Object3D} options.source the loaded rig, at unit scale
   * @param {import('three').AnimationClip|null} options.clip its idle
   * @param {number} options.scale metres per unit of the export
   * @param {{x: number, y: number, z: number}} options.offset normalisation onto y = 0
   * @param {number} options.forwardYaw yaw of the rig's forward in model space
   * @param {import('../world/Environment.js').Environment} options.environment
   */
  constructor({ source, clip, scale, offset, forwardYaw, environment }) {
    this.environment = environment;
    this.forwardYaw = forwardYaw;
    /** Heading in radians about world +Y, on the same convention as the player. */
    this.facing = 0;
    /** 'alive' → 'dead' → 'burning' → 'gone'; or 'alive' → 'frozen' → 'gone' — see `freeze`. */
    this.state = 'alive';
    /** Seconds in the current state. */
    this.timer = 0;
    /** 0 while the body is whole, 1 once it has burned away. */
    this.dissolve = 0;
    /**
     * How much of the body something *else* has taken — see `consume`.
     *
     * Kept apart from `dissolve` because the two run on different clocks and
     * the loudest one wins: a corpse the void has eaten a third of still burns
     * away on its own schedule if whatever was eating it lets go.
     */
    this._consumed = 0;
    /**
     * How far something has stained this body, 0..1, and the look it is being
     * stained with — see `corrode`.
     *
     * Kept apart from `_consumed` for the same reason that is kept apart from
     * `dissolve`: the colour and the burn are two clocks. Corruption stains a body
     * while it is still whole, and a body it has finished with has to stay
     * stained while the natural burn takes what is left of it.
     */
    this._corroded = 0;
    this._corrodeLook = null;
    /** True once the body has been parted, which is what makes it two of them. */
    this.sliced = false;
    /** True once it has gone under a surface — see `sink`. Latches the shadow off. */
    this._sunk = false;
    /** Where the last cut opened, in world space. Read by whatever made it. */
    this.cutPoint = new Vector3();
    /** The limbs that have been torn off it, by `TEAR_REGIONS` name — see `tear`. */
    this.torn = new Set();
    /** How close each seam is to giving, 0..1, by region slot — see `strain`. */
    this._strain = [0, 0, 0, 0, 0];
    /** The look of the seams and the wounds; whoever is pulling it apart hands it in. */
    this._tearLook = null;
    /** Seconds of simulation this body has seen — the seams flicker on it. */
    this._clock = 0;

    this.root = new Group();
    this.root.name = 'Dummy';

    /** Metres per unit of the export — the dissolve's noise is sized off it. */
    this._scale = scale;
    /** How tall it stands, metres. What the hit test measures against. */
    this.height = settings.dummies.height;
    /** That height in the *export's* units — the cut is a fraction of it. */
    this._localHeight = Math.max(1e-3, this.height / scale);
    /**
     * The feet's centre in the model's own space.
     *
     * `DummyField` hands over the offset that drops that point onto the root's
     * origin, so it is that offset undone — and it is what the cut plane is
     * measured from, since a bind-space plane has to be placed in bind space.
     */
    this._base = new Vector3(-offset.x / scale, -offset.y / scale, -offset.z / scale);

    /* ---- the space the vertices are actually in — see `_measureBind` ---- */
    /** The mesh's own transform: vertex space → the model's space. */
    this._bindMatrix = new Matrix4();
    /** The rig's up, in vertex space. */
    this._bindUp = new Vector3(0, 1, 0);
    /** Where the feet are along that axis, and how far the head is from them. */
    this._bindBase = 0;
    this._bindHeight = 1;

    const model = cloneRigged(source);
    model.scale.setScalar(scale);
    model.position.set(offset.x, offset.y, offset.z);
    this.root.add(model);

    // Before the first part, because every part's uniforms are sized off it.
    this._measureBind(model);
    // And before its first draw: the shader reads the attributes this writes.
    tagTearRegions(model);

    /**
     * The body, as one or two pieces of it.
     *
     * One while it is whole; two once it has been cut, each with its own copy
     * of the mesh, its own materials, its own bones and its own fall.
     */
    this.parts = [this._makePart(model)];

    this.mixer = new AnimationMixer(this.model);
    this.action = clip ? this.mixer.clipAction(clip) : null;
    if (this.action) {
      // Its own phase and its own pace. Half a dozen bodies breathing in unison
      // is the single most artificial thing a crowd can do, and it costs two
      // lines to never do it.
      this.action.play();
      this.action.time = Math.random() * this.action.getClip().duration;
      this.action.setEffectiveTimeScale(0.92 + Math.random() * 0.16);
    }
  }

  /** The piece the animation is played on — the whole body, or its legs. */
  get model() {
    return this.parts[0].model;
  }

  /** name → bone for that piece, raw *and* namespace-stripped. */
  get bones() {
    return this.parts[0].bones;
  }

  get alive() {
    return this.state === 'alive';
  }

  /** True once it has finished burning and the slot can be reused. */
  get finished() {
    return this.state === 'gone';
  }

  get position() {
    return this.root.position;
  }

  /* ------------------------------------------------------------------ */
  /* the space a cut lives in                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Where this export's *vertices* live, which is not where its skeleton does.
   *
   * The cut is resolved against `position` — the attribute, untouched by a
   * single bone — and that attribute is in the mesh's own object space, not the
   * rig's. On a Mixamo export the two can be three axes and a factor of a
   * hundred apart: the mesh may carry its own conversion on its transform, so
   * the vertex a metre up the body reads `z = 1.0` while everything measured
   * off the rig reads `y = 100`.
   *
   * A plane built in the rig's numbers therefore misses the mesh entirely — it
   * lands far outside it, one half keeps every vertex and the other keeps none,
   * and a body that was cut falls over looking exactly like one that was not.
   *
   * So the mesh's transform is measured once, here, and every plane is pushed
   * through it (`_toBindPlane`) before a shader sees it.
   */
  _measureBind(model) {
    let mesh = null;
    model.traverse((node) => {
      if (!node.isMesh && !node.isSkinnedMesh) return;
      node.updateMatrix();
      if (!mesh) mesh = node;
      // One plane is shared by every material on a half, so a second mesh in a
      // different space would be cut somewhere else entirely.
      else if (!mesh.matrix.equals(node.matrix)) {
        console.warn(
          '[Dummy] this export has meshes in different object spaces — the cut follows the first'
        );
      }
    });
    if (mesh) matrixRelativeTo(mesh, model, this._bindMatrix);

    // The rig's up and the body's extent along it, in the space the vertices
    // are in. Two planes rather than an axis and a number: the same conversion
    // that places the cut places these, so the three cannot drift apart.
    const feet = this._toBindPlane(UP, this._base.y, this._bindUp);
    const head = this._toBindPlane(UP, this._base.y + this._localHeight, _scratch);
    this._bindBase = feet;
    this._bindHeight = Math.max(1e-4, head - feet);
  }

  /**
   * A plane in the model's space → the same plane in the mesh's vertex space.
   *
   * Planes do not transform like points. Push a normal through a matrix that
   * scales or rotates and it stops being perpendicular to its own plane; the
   * *transpose* is what carries it, and that falls straight out of the algebra
   * — `dot(n, M·v) = d` is `dot(Mᵀ·n, v) = d`, once the translation has been
   * taken off the offset. Normalising afterwards is what keeps
   * `dot(position, normal) - offset` a distance, which is the unit the cut's
   * hot edge is measured in.
   *
   * @param {Vector3} normal unit, in the model's space
   * @param {number} offset `dot(normal, point)` for any point on the plane
   * @param {Vector3} out the plane's normal in vertex space, written here
   * @returns {number} the offset that goes with it
   */
  _toBindPlane(normal, offset, out) {
    const e = this._bindMatrix.elements;
    out.set(
      e[0] * normal.x + e[1] * normal.y + e[2] * normal.z,
      e[4] * normal.x + e[5] * normal.y + e[6] * normal.z,
      e[8] * normal.x + e[9] * normal.y + e[10] * normal.z
    );
    const shifted = offset - (e[12] * normal.x + e[13] * normal.y + e[14] * normal.z);

    const length = out.length();
    // A degenerate mesh transform: nothing sensible to convert into, so the
    // plane is handed back as it came and the cut is at least not nonsense.
    if (length < 1e-9) {
      out.copy(normal);
      return offset;
    }
    out.multiplyScalar(1 / length);
    return shifted / length;
  }

  /* ------------------------------------------------------------------ */
  /* the look                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * One piece of body: its own materials, its own uniforms, its own bones.
   *
   * Everything a half needs to be shaded and simulated on its own is built
   * here, so cutting the body in two is `_makePart(clone)` and a plane.
   */
  _makePart(model) {
    const part = {
      model,
      bones: new Map(),
      materials: [],
      uniforms: this._makeUniforms(),
      ragdoll: null,
      /** The joint nearest the cut — where this half was parted. */
      cutBone: null,
      /** The limb this piece is, once one has been torn off; null for the trunk. */
      region: null,
      /** When this piece last came apart, on `_clock` — its wounds cool from then. */
      tornAt: -1e3,
      /** The pose the rig arrived in, one entry per bone. See `_restPose`. */
      rest: []
    };

    this._dress(part);

    model.traverse((node) => {
      if (!node.isBone) return;
      part.bones.set(node.name, node);
      const short = stripNamespace(node.name);
      if (short && !part.bones.has(short)) part.bones.set(short, node);
      // Taken here rather than looked up later: this runs before anything has
      // posed the skeleton, so it is the only moment the rig is guaranteed to
      // be wearing its own pose. Recorded off the traverse so each bone is
      // taken once — `bones` holds most of them twice, under both names.
      part.rest.push({
        bone: node,
        position: node.position.clone(),
        quaternion: node.quaternion.clone()
      });
    });

    return part;
  }

  /**
   * Put the skeleton back the way the rig came.
   *
   * The mixer cannot be asked to do this. It writes what the clip has tracks
   * for — rotations, here — and the solver writes one thing the clip does not
   * carry: the hips' local position. That single number is the body's
   * translation, so a corpse hands its whole displacement to whoever stands up
   * next in that slot. See `place`, which is the only caller and calls it every
   * time.
   */
  _restPose(part) {
    for (const entry of part.rest) {
      entry.bone.position.copy(entry.position);
      entry.bone.quaternion.copy(entry.quaternion);
    }
  }

  /** The dissolve, the rim and the cut, shared by every material on one piece. */
  _makeUniforms() {
    const cut = settings.slice;
    return {
      uDissolve: { value: 0 },
      uDetail: { value: 9 * this._scale },
      uEdgeWidth: { value: 0.12 },
      uEdgeColor: { value: new Color() },
      uEdgeEmissive: { value: 6 },
      uRimColor: { value: new Color() },
      uRimPower: { value: 2.6 },
      uRimEmissive: { value: 1.5 },

      /** 0 while the body is whole; ±1 for the side of the plane it keeps. */
      uCutSide: { value: 0 },
      /** The plane, in the geometry's *bind* space — see `_cut`. */
      uCutNormal: { value: new Vector3(0, 1, 0) },
      uCutOffset: { value: 0 },
      uInteriorColor: { value: getColor(cut.interiorColor).clone() },
      uInteriorEmissive: { value: cut.interiorEmissive },
      uCutEdgeColor: { value: getColor(cut.edgeColor).clone() },
      uCutEdgeEmissive: { value: cut.edgeEmissive },
      uCutEdgeWidth: { value: cut.edgeWidth * this._bindHeight },

      /** -1 while the body is whole; 0 for the trunk once a limb is off; slot + 1 for a limb. */
      uTearKeep: { value: -1 },
      /** On a limb: the skeleton index of the socket it came out of — see `TEAR_SKINBASE`. */
      uTearSocket: { value: 0 },
      /** 1 for each region that has been torn off, by slot. */
      uTornA: { value: new Vector3() },
      uTornB: { value: new Vector2() },
      /** How close each seam is to giving, by slot — the glow before the tear. */
      uStrainA: { value: new Vector3() },
      uStrainB: { value: new Vector2() },
      uTearNoise: { value: 0.3 },
      uTearScale: { value: 14 / this._bindHeight },
      uTearEdgeWidth: { value: 0.08 },
      uTearMeat: { value: new Color(0.1, 0.01, 0.01) },
      uTearMeatEmissive: { value: 0.4 },
      uTearHot: { value: new Color(1, 0.6, 0.2) },
      uTearHotEmissive: { value: 6 },
      uTearVeins: { value: 1 },
      uTearTime: { value: 0 },
      /** How hot this piece's wounds still are, 1 on the frame it tore. */
      uTearHeat: { value: 1 },
      /** A portal this piece is being drawn through: (normal, offset) in world; zero for none. */
      uClip: { value: new Vector4() },
      uClipColor: { value: new Color(1, 0.6, 0.2) },
      uClipGlow: { value: 0 },
      uClipWidth: { value: 0.06 }
    };
  }

  /**
   * Replace whatever the FBX brought with an authored PBR material, and inject
   * the rim, the dissolve and the cut into it.
   *
   * The dissolve is a plain noise threshold with a `discard`: opaque the whole
   * way, so nothing has to sort, and the burn edge is emissive rather than
   * transparent. The noise is evaluated on the *posed* vertex, which is what
   * keeps the burn stuck to a corpse that is still settling; the cut is
   * evaluated on the *bind* vertex, which is what keeps the plane at the waist
   * while the corpse folds over it.
   *
   * Double-sided from birth, and deliberately: the back faces are what fill the
   * hollow a cut opens, and a body that only became double-sided at the moment
   * it was cut would recompile its shader on the frame of the blow — which is
   * the one frame in the whole sandbox that cannot afford it.
   */
  _dress(part) {
    const converted = new Map();

    part.model.traverse((node) => {
      if (!node.isMesh && !node.isSkinnedMesh) return;

      node.castShadow = true;
      node.receiveShadow = true;
      // A ragdoll leaves the bounds the mesh was authored with far behind.
      node.frustumCulled = false;
      node.layers.set(LAYER.WORLD);
      // The cut is a `discard`, and the depth pass would otherwise go on
      // casting a whole body's shadow off half of one.
      node.customDepthMaterial = this._makeDepthMaterial(part);

      const source = Array.isArray(node.material) ? node.material : [node.material];
      const result = source.map((material) => {
        if (converted.has(material)) return converted.get(material);

        const standard = new MeshStandardMaterial({
          name: 'Dummy',
          color: 0xffffff,
          roughness: 0.78,
          metalness: 0.15,
          side: DoubleSide
        });
        this.environment.registerShadowCasterWithPatch(standard, (shader) => {
          Object.assign(shader.uniforms, part.uniforms);

          shader.vertexShader = shader.vertexShader
            .replace(
              '#include <common>',
              `#include <common>\nvarying vec3 vBodyPos;\nvarying vec3 vBindPos;\n${TEAR_VERTEX_DECL}`
            )
            // The posed vertex is taken at the projection, which is the one
            // point in the chain that is always past the skinning: the noise
            // then rides the pose rather than the bind, and a corpse does not
            // burn in a pattern that slides over it while it settles. The bind
            // vertex is the attribute itself, before a bone has touched it.
            .replace('#include <skinbase_vertex>', TEAR_SKINBASE)
            .replace(
              '#include <project_vertex>',
              `vBodyPos = transformed;\nvBindPos = position;\n${TEAR_VERTEX_MAIN}\n#include <project_vertex>`
            );

          shader.fragmentShader = shader.fragmentShader
            .replace(
              '#include <common>',
              `#include <common>
               varying vec3 vBodyPos;
               varying vec3 vBindPos;
               uniform float uDissolve;
               uniform float uDetail;
               uniform float uEdgeWidth;
               uniform vec3 uEdgeColor;
               uniform float uEdgeEmissive;
               uniform vec3 uRimColor;
               uniform float uRimPower;
               uniform float uRimEmissive;
               uniform float uCutSide;
               uniform vec3 uCutNormal;
               uniform float uCutOffset;
               uniform vec3 uInteriorColor;
               uniform float uInteriorEmissive;
               uniform vec3 uCutEdgeColor;
               uniform float uCutEdgeEmissive;
               uniform float uCutEdgeWidth;
               uniform vec3 uStrainA;
               uniform vec2 uStrainB;
               uniform float uTearEdgeWidth;
               uniform vec3 uTearMeat;
               uniform float uTearMeatEmissive;
               uniform vec3 uTearHot;
               uniform float uTearHotEmissive;
               uniform float uTearVeins;
               uniform float uTearTime;
               uniform float uTearHeat;
               uniform vec3 uClipColor;
               uniform float uClipGlow;
               uniform float uClipWidth;
               ${noiseGLSL}
               ${TEAR_GLSL}`
            )
            // Both discards as early as the chunk list allows: half of a cut
            // body is not there at all, and there is no sense shading it.
            .replace(
              '#include <clipping_planes_fragment>',
              `#include <clipping_planes_fragment>
               // Signed so that positive is the side this copy was told to
               // keep, whichever side of the plane that is. Declared here and
               // read again further down: both blocks land inside main().
               float cutSide = uCutSide == 0.0
                 ? 1.0
                 : (dot(vBindPos, uCutNormal) - uCutOffset) * uCutSide;
               if (cutSide < 0.0) discard;

               // Torn: the piece keeps its own side of the ragged seam. And
               // drawn through a portal: whatever is past it is somewhere else.
               // Only paid for on a body something is pulling apart.
               float strainAny = max(max(uStrainA.x, uStrainA.y), max(uStrainA.z, max(uStrainB.x, uStrainB.y)));
               float tearN = (uTearKeep > -0.5 || strainAny > 0.0) ? tearNoise(vBindPos) : 0.0;
               float tearSide = tearSideOf(tearN);
               if (tearSide < 0.0) discard;
               float clipSide = clipSideOf();
               if (clipSide < 0.0) discard;

               float burn = clamp(fbm3(vBodyPos * uDetail) * 0.5 + 0.5, 0.0, 1.0);
               if (burn < uDissolve) discard;`
            )
            .replace(
              '#include <emissivemap_fragment>',
              `#include <emissivemap_fragment>
               {
                 // The body is a shell, so what a cut exposes is the *inside*
                 // of the far wall — exactly the back faces the material is
                 // double-sided for. Painting them as meat is the whole of the
                 // cross-section: no cap geometry, no re-tessellation, and it
                 // is right from every angle for free.
                 if (uCutSide != 0.0 && !gl_FrontFacing) {
                   diffuseColor.rgb = uInteriorColor;
                   totalEmissiveRadiance += uInteriorColor * uInteriorEmissive;
                 }

                 // And the line the edge left along the surface it went through.
                 if (uCutSide != 0.0) {
                   float lip = 1.0 - smoothstep(0.0, max(uCutEdgeWidth, 1e-4), cutSide);
                   totalEmissiveRadiance += uCutEdgeColor * lip * uCutEdgeEmissive;
                 }

                 // The rim draws the silhouette, and the inside of a body has
                 // none — running it on the back faces would put a bright edge
                 // around the meat.
                 if (gl_FrontFacing) {
                   float rim = pow(
                     1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0),
                     uRimPower
                   );
                   totalEmissiveRadiance += uRimColor * rim * uRimEmissive;
                 }

                 // And the band of embers just ahead of the burn line.
                 float edge = 1.0 - smoothstep(0.0, max(1e-4, uEdgeWidth), burn - uDissolve);
                 totalEmissiveRadiance +=
                   uEdgeColor * edge * uEdgeEmissive * step(1e-4, uDissolve);
               }
               {
                 // A seam about to give: a line of heat exactly where the limb
                 // will come away, and veins of it cracking out into the limb
                 // ahead of the tear — read off the same membership and the
                 // same noise as the tear itself, so it is a forecast.
                 if (strainAny > 0.0) {
                   float glow = 0.0;
                   for (int k = 0; k < 5; k++) {
                     float s = k == 0 ? uStrainA.x : k == 1 ? uStrainA.y : k == 2 ? uStrainA.z : k == 3 ? uStrainB.x : uStrainB.y;
                     if (s <= 0.0) continue;
                     float m = tearOwn(k) + tearN - 0.5;
                     // Squares written out: pow() of a negative base is NaN on
                     // D3D, and one NaN texel is a black frame once bloom has it.
                     float mb = m / max(uTearEdgeWidth, 1e-3);
                     float band = exp(-mb * mb);
                     float vein = pow(max(0.0, 1.0 - abs(snoise(vBindPos * uTearScale * 2.4 + float(k) * 7.1))), 12.0);
                     float mr = m / (0.05 + 0.16 * s);
                     float reach = smoothstep(-0.04, 0.06, m) * exp(-mr * mr);
                     glow += s * s * band + s * vein * reach * uTearVeins;
                   }
                   float flicker = 0.8 + 0.2 * sin(uTearTime * 41.0 + vBindPos.y * uTearScale * 3.0);
                   totalEmissiveRadiance += uTearHot * glow * uTearHotEmissive * flicker;
                 }

                 // A wound: the torn edge still hot, and the inside of the
                 // shell — the back faces the hole shows — painted as meat,
                 // hottest where it was torn.
                 bool opened = uTearKeep > -0.5 || clipSide < 1e2;
                 // White-hot on the frame it tears, cooling to a rim of embers.
                 if (uTearKeep > -0.5) {
                   float lip = 1.0 - smoothstep(0.0, max(uTearEdgeWidth, 1e-4), tearSide);
                   float ember = 0.75 + 0.25 * snoise(vBindPos * uTearScale * 3.0 + uTearTime * 2.0);
                   totalEmissiveRadiance += uTearHot * lip * uTearHotEmissive * mix(0.18 * ember, 1.0, uTearHeat);
                 }
                 if (opened && !gl_FrontFacing) {
                   float fibre = snoise(vBindPos * uTearScale * vec3(1.0, 5.0, 1.0)) * 0.5 + 0.5;
                   diffuseColor.rgb = uTearMeat * (0.55 + 0.6 * fibre);
                   float near = 1.0 - smoothstep(0.0, 0.12, tearSide);
                   totalEmissiveRadiance += uTearMeat * uTearMeatEmissive * (0.5 + fibre)
                     + uTearHot * near * near * uTearHotEmissive * 0.25 * uTearHeat;
                 }

                 // Going through a portal: the rim of it burns on the body.
                 if (clipSide < 1e2) {
                   float rim = 1.0 - smoothstep(0.0, max(uClipWidth, 1e-4), clipSide);
                   totalEmissiveRadiance += uClipColor * rim * uClipGlow;
                 }
               }`
            );
        });

        material?.dispose();
        converted.set(material, standard);
        part.materials.push(standard);
        return standard;
      });

      node.material = Array.isArray(node.material) ? result : result[0];
    });
  }

  /**
   * The same cut, for the shadow map.
   *
   * Only the plane: the burn-away is not here because a body that has started
   * dissolving is taken out of the depth pass entirely (`_castShadows`), and a
   * noise tap per shadow texel to say the same thing twice is not worth its
   * compile.
   */
  _makeDepthMaterial(part) {
    const material = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });

    this.environment.registerShadowCasterWithPatch(material, (shader) => {
      Object.assign(shader.uniforms, part.uniforms);
      shader.vertexShader = `varying vec3 vBindPos;\n${TEAR_VERTEX_DECL}\n${shader.vertexShader}`
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBindPos = position;')
        .replace('#include <skinbase_vertex>', TEAR_SKINBASE)
        .replace('#include <project_vertex>', `${TEAR_VERTEX_MAIN}\n#include <project_vertex>`);
      shader.fragmentShader =
        `uniform float uCutSide;\nuniform vec3 uCutNormal;\nuniform float uCutOffset;\nvarying vec3 vBindPos;\n${noiseGLSL}\n${TEAR_GLSL}\n${shader.fragmentShader}`.replace(
          '#include <alphatest_fragment>',
          `#include <alphatest_fragment>
           if (uCutSide != 0.0 && (dot(vBindPos, uCutNormal) - uCutOffset) * uCutSide < 0.0) discard;
           // The same ragged seam and the same portal as the colour pass, or a
           // torn-off arm would go on casting a whole body's shadow.
           if (uTearKeep > -0.5 && tearSideOf(tearNoise(vBindPos)) < 0.0) discard;
           if (clipSideOf() < 0.0) discard;`
        );
    });

    return material;
  }

  /** Pull the live editor values through. Colours are cached by `getColor`. */
  _syncMaterials() {
    const look = settings.dummies.look;
    const cut = settings.slice;
    // What is eating this body, and how far it has got. Every colour below is
    // the authored one lerped that far toward the stain's, so a body halfway
    // through going is halfway between the two — and one nothing has touched
    // pays for a single comparison.
    const eaten = this._corrodeLook;
    const stain = eaten ? this._corroded : 0;

    for (const part of this.parts) {
      for (const material of part.materials) {
        material.color.copy(getColor(look.color));
        material.roughness = look.roughness;
        material.metalness = look.metalness;
        if (stain > 0) material.color.lerp(getColor(eaten.color), stain);
      }

      const u = part.uniforms;
      u.uRimColor.value.copy(getColor(look.rimColor));
      u.uRimPower.value = look.rimPower;
      u.uRimEmissive.value = look.rimEmissive;
      u.uEdgeColor.value.copy(getColor(look.edgeColor));
      u.uEdgeEmissive.value = look.edgeEmissive;
      if (stain > 0) {
        // The rim and the burn edge are the two things anybody actually reads
        // the body's state off at fifteen metres, so they are what has to
        // carry the colour — the diffuse under them is nearly black either way.
        u.uRimColor.value.lerp(getColor(eaten.rimColor), stain);
        u.uRimEmissive.value = MathUtils.lerp(look.rimEmissive, eaten.rimEmissive, stain);
        u.uEdgeColor.value.lerp(getColor(eaten.edgeColor), stain);
        u.uEdgeEmissive.value = MathUtils.lerp(look.edgeEmissive, eaten.edgeEmissive, stain);
      }
      u.uEdgeWidth.value =
        stain > 0 ? MathUtils.lerp(look.edgeWidth, eaten.edgeWidth, stain) : look.edgeWidth;
      u.uDetail.value = look.dissolveDetail * this._scale;
      u.uDissolve.value = this.dissolve;

      // The cut's own look, so the meat and the hot line stay editable while a
      // corpse is lying there in two pieces. The plane itself is *not* re-read:
      // it was resolved from the blow, and nothing may move it afterwards.
      u.uInteriorColor.value.copy(getColor(cut.interiorColor));
      u.uInteriorEmissive.value = cut.interiorEmissive;
      u.uCutEdgeColor.value.copy(getColor(cut.edgeColor));
      u.uCutEdgeEmissive.value = cut.edgeEmissive;

      // The seams, and the wounds once they give: whoever is pulling the body
      // apart supplies the look, read live like every other colour here.
      const s = this._strain;
      u.uStrainA.value.set(s[0], s[1], s[2]);
      u.uStrainB.value.set(s[3], s[4]);
      u.uTearTime.value = this._clock;
      u.uTearHeat.value = Math.exp(-(this._clock - part.tornAt) * 2.2);
      const tear = this._tearLook;
      if (tear) {
        u.uTearNoise.value = tear.tearNoise;
        u.uTearScale.value = tear.tearNoiseScale / this._bindHeight;
        u.uTearEdgeWidth.value = tear.tearEdge;
        u.uTearMeat.value.copy(getColor(tear.colorMeat));
        u.uTearMeatEmissive.value = tear.meatGlow;
        u.uTearHot.value.copy(getColor(tear.colorSeam));
        u.uTearHotEmissive.value = tear.seamGlow;
        u.uTearVeins.value = tear.veins;
        u.uClipColor.value.copy(getColor(tear.colorSeam));
        u.uClipGlow.value = tear.portalRimGlow;
        u.uClipWidth.value = tear.portalRimWidth;
      }
    }
  }

  /** Whichever pieces of the body there are, in or out of the depth pass. */
  _castShadows(on) {
    for (const part of this.parts) {
      part.model.traverse((node) => {
        if (node.isMesh || node.isSkinnedMesh) node.castShadow = on;
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* life                                                                */
  /* ------------------------------------------------------------------ */

  /** Stand it up at a world XZ, facing `yaw`, whole again. */
  place(x, z, yaw) {
    // Whatever the last cut left behind. The clone was this body's own, so it
    // goes with it rather than being carried into the next life.
    while (this.parts.length > 1) this._disposePart(this.parts.pop());

    this.sliced = false;
    this._sunk = false;
    const part = this.parts[0];
    part.ragdoll = null;
    part.cutBone = null;
    part.region = null;
    part.uniforms.uCutSide.value = 0;
    // Whole again: no seams straining, nothing torn, no portal round it.
    this._shaped(part, false);
    this.torn.clear();
    this._strain.fill(0);
    part.uniforms.uTearKeep.value = -1;
    part.uniforms.uTornA.value.set(0, 0, 0);
    part.uniforms.uTornB.value.set(0, 0);
    part.uniforms.uClip.value.set(0, 0, 0, 0);
    this._castShadows(true);
    // And whatever the last *fall* left behind, which is not the clip's to undo.
    // `Ragdoll#_pose` writes the hips' local position, and the idle clip has no
    // track for it — so a mixer tick restores every rotation and leaves the
    // body's translation exactly where the corpse ended up. A dummy re-used
    // after one fall then stands up with its skeleton several metres from its
    // own root, and if anything kills it before the next tick (a zone still
    // fishing, `applyHits` running in the same frame it was re-stood) the new
    // solver is built off *that*: the body is thrown, underground, and every
    // further life compounds it — three casts in, a corpse was two kilometres
    // above the stage. Cheap and unconditional, because the pose it is putting
    // back is the one the rig arrived in.
    this._restPose(part);

    this.root.position.set(x, 0, z);
    this.facing = yaw;
    this.root.rotation.y = yaw - this.forwardYaw;
    this.root.visible = true;

    this.state = 'alive';
    this.timer = 0;
    this.dissolve = 0;
    this._consumed = 0;
    this._corroded = 0;
    this._corrodeLook = null;

    // Back to the clip, from wherever the last fall left the skeleton.
    if (this.action) {
      this.action.reset();
      this.action.play();
      this.action.time = Math.random() * this.action.getClip().duration;
    }
    return this;
  }

  /**
   * Knock it down, and throw the body along `(x, z)`.
   *
   * @param {number} x unit direction of the blow, flat
   * @param {number} z
   * @param {{impulse: number, lift: number, spin: number}} force
   * @param {boolean} [slice] whether the blow came down with an edge on it
   * @returns {boolean} false if it was already down
   */
  kill(x, z, force, slice = false) {
    if (!this.alive) return false;

    this.state = 'dead';
    this.timer = 0;

    // Nothing fades: the pose the clip is on *is* the ragdoll's first frame, so
    // the skeleton is brought fully up to date — ancestors included — before it
    // is read. The solver works in world space and every rest length it
    // measures comes off these matrices.
    this.mixer.stopAllAction();
    this.root.updateWorldMatrix(true, true);

    if (slice && settings.slice.enabled && this._cut(x, z)) {
      const cut = settings.slice;
      this._fall(this.parts[0], x, z, force, cut.lower, LOWER_JOINTS, LOWER_CONTACTS);
      this._fall(this.parts[1], x, z, force, cut.upper, UPPER_JOINTS, UPPER_CONTACTS);
      // The two halves start on the same particles, so the top is lifted clear
      // by hand on this one frame; the impulses part them from here.
      this.parts[1].ragdoll?.displace(
        _cutNormalWorld.x * cut.separation,
        _cutNormalWorld.y * cut.separation,
        _cutNormalWorld.z * cut.separation
      );
      // And driven apart along the blow: the top the way the beam went, the
      // legs the other way. Without it both halves leave on the same vector and
      // land in one heap, which reads as a body that fell over rather than one
      // that came apart.
      const split = Math.max(0, cut.split);
      if (split > 0) {
        this.parts[1].ragdoll?.shove(x * split, 0, z * split);
        this.parts[0].ragdoll?.shove(-x * split, 0, -z * split);
      }
      return true;
    }

    this._fall(this.parts[0], x, z, force, null, null, null);
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* being frozen                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Stop it dead, mid-breath, and hand the pose to whoever asked.
   *
   * The one way off its feet that is not a fall. The animation is abandoned
   * exactly as `kill` abandons it — the mixer is stopped and the skeleton's
   * world matrices are brought up to date, so the pose the body is holding
   * on this frame is the one the caller reads off the skinned meshes. But no
   * solver is built: a frozen body does not move again, and what stands in
   * its place is not this rig at all but a copy of it baked by the caller
   * (see `effects/IceStatue.js`), so the body itself is hidden.
   *
   * It then waits. A frozen body is neither `alive` — nothing else may knock
   * it down or take hold of it — nor `finished`, so the field will not stand
   * a replacement up while the statue is still there. `vanish` is the other
   * half: the caller says when the statue has gone and the slot may be
   * reused.
   *
   * @returns {boolean} false if it was not standing
   */
  freeze() {
    if (!this.alive) return false;
    this.state = 'frozen';
    this.timer = 0;
    this.mixer.stopAllAction();
    this.root.updateWorldMatrix(true, true);
    return true;
  }

  /** The skinned meshes of the whole body, posed as it stands. */
  skinnedMeshes(out = []) {
    out.length = 0;
    this.parts[0].model.traverse((node) => {
      if (node.isSkinnedMesh) out.push(node);
    });
    return out;
  }

  /**
   * Take a frozen body off the stage for good.
   *
   * What the ice shattered into is the caller's to draw; this only tells the
   * field the slot is free, on the same terms a burnt-away corpse frees it.
   */
  vanish() {
    if (this.state !== 'frozen') return;
    this.state = 'gone';
    this.root.visible = false;
  }

  /* ------------------------------------------------------------------ */
  /* being taken hold of                                                 */
  /* ------------------------------------------------------------------ */

  /**
   * Where the body is while it falls — the hips, in world space.
   *
   * Not `position`, which is the spot it was placed at and which the solver
   * never moves. Null while it is still standing, because a body on its feet
   * has no solver to ask.
   *
   * @param {import('three').Vector3} out written in place
   * @returns {import('three').Vector3|null}
   */
  bodyPoint(out) {
    return this.parts[0].ragdoll?.centre(out) ?? null;
  }

  /**
   * How fast it is travelling, metres per second. Null while it is standing.
   *
   * @param {import('three').Vector3} out written in place
   * @returns {import('three').Vector3|null}
   */
  bodyVelocity(out) {
    return this.parts[0].ragdoll?.velocity(out) ?? null;
  }

  /**
   * Hand every joint of every piece to a velocity field — a current, not a blow.
   *
   * `kill` throws a body once, with a torque, and that is the whole damage
   * model for everything that simply *reaches*. This is for the one thing that
   * keeps acting on a body after it is down: a metre of moving water does not
   * hit a corpse, it carries it, so it arrives every frame as a velocity the
   * body is dragged toward rather than as an impulse on one.
   *
   * The field is sampled at each joint rather than once for the body, because
   * the water that swallows things is *turning*: it reaches the near shoulder
   * faster than the far one, and that difference is the only thing that makes a
   * corpse spin instead of slide. See `Ragdoll#steer`.
   *
   * Water also holds a body *up*, and that half cannot be done with a velocity:
   * gravity is integrated per solver substep while this arrives per frame, so a
   * current strong enough to float a corpse at sixty frames a second launches it
   * at six. `buoyancy` takes the weight off where the weight is applied, which
   * means the same thing at every frame rate. It stays where it is put, so
   * whatever set it has to give it back — `release` does.
   *
   * @param {(x: number, y: number, z: number, out: Vector3) => void} field
   *   writes the velocity of the water at a world-space point
   * @param {number} grab 0..1, how much of the gap it closes this frame
   * @param {number} [grabY] the same for the vertical
   * @param {number} [buoyancy] 0..1, how much of the body's weight the water
   *   is carrying
   */
  carry(field, grab, grabY, buoyancy = 0) {
    for (const part of this.parts) {
      if (!part.ragdoll) continue;
      part.ragdoll.buoyancy = buoyancy;
      part.ragdoll.steer(field, grab, grabY);
    }
  }

  /**
   * Hold one joint of the body to a point — a jaw, a hand, a hook.
   *
   * `carry` is a current; this is a grip. One joint goes where it is put and
   * the rest of the body hangs off it under gravity — see `Ragdoll#pin`. Only
   * the piece that owns the joint is held: a body cut in two hangs by whichever
   * half the joint is in, and the other half falls, which is what it would do.
   *
   * Safe to call every frame. A body still on its feet has no solver to hold,
   * so this answers false until something has knocked it down.
   *
   * @param {string} joint namespace-stripped bone name (`'Spine'`, `'Hips'`…)
   * @param {import('three').Vector3} at world point
   * @param {number} [stiffness] 0..1 — 1 is a hard hold, less is a leash
   * @returns {boolean} whether any piece took hold
   */
  pin(joint, at, stiffness = 1) {
    let held = false;
    for (const part of this.parts) {
      if (part.ragdoll?.pin(joint, at.x, at.y, at.z, stiffness)) held = true;
    }
    return held;
  }

  /** Let go of one joint, or of all of them. The body falls on from wherever it is. */
  unpin(joint = null) {
    for (const part of this.parts) part.ragdoll?.unpin(joint);
  }

  /* ------------------------------------------------------------------ */
  /* being torn apart                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Where one joint is right now, in the world.
   *
   * Off whichever piece's solver owns it once the body is down — the particle,
   * which is exactly where the solver put it this frame — and off the posed
   * skeleton while it is still standing.
   *
   * @param {string} name namespace-stripped joint name
   * @param {Vector3} out written in place
   * @returns {Vector3|null}
   */
  joint(name, out) {
    for (const part of this.parts) {
      if (part.ragdoll?.joint(name, out)) return out;
    }
    const bone = this.parts[0].bones.get(name);
    if (!bone) return null;
    bone.updateWorldMatrix(true, false);
    return bone.getWorldPosition(out);
  }

  /**
   * The world rotation of one joint's bone, on whichever piece owns it.
   *
   * What something wound round a limb needs to stay wound round it: a frame
   * that turns with the bone, so a chain does not slide round the arm as the
   * arm rolls.
   *
   * @param {string} name namespace-stripped joint name
   * @param {import('three').Quaternion} out written in place
   * @returns {import('three').Quaternion|null}
   */
  jointQuaternion(name, out) {
    let owner = this.parts[0];
    for (const part of this.parts) {
      if (part.ragdoll?.index.has(name)) {
        owner = part;
        break;
      }
    }
    const bone = owner.bones.get(name);
    if (!bone) return null;
    bone.updateWorldMatrix(true, false);
    return bone.getWorldQuaternion(out);
  }

  /**
   * How close one seam is to giving, 0..1 — the glow before a limb comes off.
   *
   * Monotonic within a life: a seam that has started to give does not heal
   * because whatever is pulling on it eased off for a frame.
   *
   * @param {string} region a `TEAR_REGIONS` name
   * @param {number} amount 0..1
   * @param {object} look the tear's look — see `settings.chains.tear`
   */
  strain(region, amount, look) {
    const r = TEAR_REGIONS[region];
    if (!r || this.state === 'gone') return;
    this._tearLook = look;
    if (this.torn.has(region)) return;
    const want = amount < 0 ? 0 : amount > 1 ? 1 : amount;
    if (want > this._strain[r.slot]) this._strain[r.slot] = want;
  }

  /**
   * Let a limb be dragged out of its socket by up to `slack` metres.
   *
   * See `Ragdoll#loosen`: the socket stops being a rod and becomes a rope, and
   * the skin across it stretches over the gap. Does nothing to a body still on
   * its feet (there is no solver to loosen) or to a limb already off.
   *
   * @param {string} region a `TEAR_REGIONS` name
   * @param {number} slack metres
   */
  loosen(region, slack) {
    const r = TEAR_REGIONS[region];
    if (!r || this.torn.has(region)) return;
    this.parts[0].ragdoll?.loosen(r.root, slack, REGION_JOINTS[region]);
  }

  /**
   * Tear one limb off, mid-fall.
   *
   * The same move as the cut, generalised from one plane to the rig's own
   * seams. The body as it is posed this instant is cloned; the clone is told
   * to keep only the limb (`uTearKeep`) and the trunk to keep everything that
   * has not been torn away (`uTornA/B`) — a threshold on the skin-weight
   * membership `tagTearRegions` wrote, roughened by noise, so the two pieces
   * get complementary halves of one ragged seam. The back faces a hole shows
   * are painted as meat by the same trick the cut uses.
   *
   * Each piece is then given a solver of its own, built off the pose it is
   * in and carrying the velocity it had (`Ragdoll#inherit`), so nothing stops
   * dead on the frame it parts. The limb's solver includes the socket joint it
   * came out of — the skin across a joint is weighted to both sides of it, and
   * a socket left frozen in the air where the trunk was would drag that skin
   * after the limb across the whole stage. The trunk's copy of the limb's root
   * is put back in its socket, so the stump snaps shut rather than staying
   * stretched toward an arm that is no longer there.
   *
   * @param {string} region a `TEAR_REGIONS` name
   * @param {object} [look] the tear's look — see `strain`
   * @returns {boolean} false if there was nothing to tear (still standing,
   *   already cut, already off, or no solver)
   */
  tear(region, look = this._tearLook) {
    const r = TEAR_REGIONS[region];
    if (!r || this.torn.has(region) || this.sliced) return false;
    if (this.state !== 'dead' && this.state !== 'burning') return false;
    const trunk = this.parts[0];
    const whole = trunk.ragdoll;
    if (!whole?.valid) return false;
    if (look) this._tearLook = look;

    this.root.updateWorldMatrix(true, true);
    const model = cloneRigged(trunk.model);
    this.root.add(model);
    const limb = this._makePart(model);
    limb.region = region;
    this.parts.push(limb);
    this.root.updateWorldMatrix(true, true);
    this.torn.add(region);

    limb.ragdoll = new Ragdoll(limb.bones, { include: new Set([r.socket, ...r.joints]) });
    model.traverse((node) => {
      if (!node.isSkinnedMesh) return;
      const socket = node.skeleton.bones.findIndex((bone) => stripNamespace(bone.name) === r.socket);
      if (socket >= 0) limb.uniforms.uTearSocket.value = socket;
    });
    limb.ragdoll.inherit(whole);

    const gone = new Set();
    for (const name of this.torn) for (const joint of TEAR_REGIONS[name].joints) gone.add(joint);
    trunk.ragdoll = new Ragdoll(trunk.bones, { include: new Set(JOINT_NAMES.filter((name) => !gone.has(name))) });
    trunk.ragdoll.inherit(whole);

    // The stump closes: the trunk's copy of the root goes back in its socket.
    for (const entry of trunk.rest) {
      if (stripNamespace(entry.bone.name) === r.root) entry.bone.position.copy(entry.position);
    }

    this._strain[r.slot] = 0;
    limb.tornAt = this._clock;
    trunk.tornAt = this._clock;
    for (const part of this.parts) {
      this._shaped(part, true);
      const u = part.uniforms;
      u.uTearKeep.value = part.region ? TEAR_REGIONS[part.region].slot + 1 : 0;
      u.uTornA.value.set(+this.torn.has('head'), +this.torn.has('armL'), +this.torn.has('armR'));
      u.uTornB.value.set(+this.torn.has('legL'), +this.torn.has('legR'));
    }
    return true;
  }

  /**
   * Draw one piece of the body through a portal: everything behind the plane
   * is not drawn, and the rim of it burns where the portal crosses the body.
   *
   * @param {string|null} region the limb, or null for the trunk
   * @param {Vector3|null} normal unit, pointing *out* of the portal; null to clear
   * @param {Vector3} [point] any point on the portal's plane
   */
  clip(region, normal, point = null) {
    for (const part of this.parts) {
      if (part.region !== region) continue;
      const u = part.uniforms.uClip.value;
      if (!normal) u.set(0, 0, 0, 0);
      else u.set(normal.x, normal.y, normal.z, point ? normal.dot(point) : 0);
      if (normal) this._shaped(part, true);
    }
  }

  /**
   * Out of the depth prepass, or back into it.
   *
   * The prepass draws `LAYER.WORLD` with one override material, which knows
   * nothing of a tear or a portal: a torn limb would go on writing the whole
   * body's depth — and its copy of the trunk, frozen where the body was — and
   * every soft particle and lens on the stage would be cut against a body that
   * is not there. `LAYER.SHAPED` is the layer for exactly this: lit, shadowed
   * through its own depth material, and left out of the prepass.
   */
  _shaped(part, on) {
    part.model.traverse((node) => {
      if (node.isMesh || node.isSkinnedMesh) node.layers.set(on ? LAYER.SHAPED : LAYER.WORLD);
    });
  }

  /** Keep a corpse from starting to burn while something still has hold of it. */
  hold() {
    if (this.state === 'dead') this.timer = 0;
  }

  /**
   * Take the floor out from under this body.
   *
   * The solver clamps every joint to a ground plane, which is the stage floor
   * for everything else standing on it. A whirlpool needs the one thing it has
   * no concept of — water the body can go *through* — and dropping that plane by
   * `depth` is the whole of it: gravity does the rest, the opaque floor hides
   * whatever has gone under it, and the shadow is dropped on the way past so a
   * body beneath the surface is not still printing one on top of it.
   *
   * Idempotent, and safe to call every frame: it is only ever lowering a number
   * the solver reads.
   *
   * @param {number} depth metres below the stage floor the body may fall to
   */
  sink(depth) {
    const floor = -Math.max(0, depth);
    for (const part of this.parts) {
      // Monotonic: the floor only ever goes *down*. Assigning it outright would
      // let a caller that reduces its depth — a whirlpool losing its grip, or
      // one taking hold of a body it had already let go of — shove a submerged
      // corpse back up through the surface that swallowed it.
      if (part.ragdoll) part.ragdoll.floor = Math.min(part.ragdoll.floor, floor);
    }
    if (this._sunk) return;
    const hips = this.bodyPoint(_scratch);
    if (!hips || hips.y > -0.25) return;
    this._sunk = true;
    this._castShadows(false);
  }

  /**
   * Give the floor back, wherever the body has got to.
   *
   * Called when whatever had hold of it lets go. A body still above the surface
   * is handed the stage floor again and lands on it; one already under is left
   * with the floor it has, because raising the plane under a submerged corpse
   * would shove it back up through the water that just swallowed it.
   */
  release() {
    // The weight comes back first, and unconditionally: a body left floating
    // because whatever was holding it up stopped asking is a body that never
    // lands, wherever it happens to be when the grip is dropped.
    for (const part of this.parts) {
      if (part.ragdoll) part.ragdoll.buoyancy = 0;
    }
    const hips = this.bodyPoint(_scratch);
    if (hips && hips.y < 0) return;
    for (const part of this.parts) {
      if (part.ragdoll) part.ragdoll.floor = 0;
    }
  }

  /**
   * Take the body away on somebody else's clock.
   *
   * `sink` is how a whirlpool disposes of a corpse: the floor opens and the
   * stage's own opaque geometry does the hiding. Nothing hides a body being
   * drawn into something three metres off the ground, so the Astral Void Blast
   * needs the other end of the same idea — the burn that already exists for a
   * corpse whose time is up, driven by *distance from the horizon* rather than
   * by a timer.
   *
   * Two rules make it safe to call every frame from a pull that is fighting
   * gravity for the body:
   *
   *  - **Monotonic.** It only ever raises the amount taken. A body that slips
   *    back out of the throat for a frame must not visibly heal, and a caller
   *    whose grip weakens must not be able to reassemble a corpse.
   *  - **It does not stop the natural burn.** `dissolve` is the louder of the
   *    two clocks, so a body eaten halfway and then let go finishes burning on
   *    its own schedule instead of lying around half gone.
   *
   * A body still on its feet is not consumed: it has to be knocked down first,
   * because a standing target has no solver and nothing to be dragged by.
   *
   * @param {number} amount 0..1, how much of the body has been taken
   * @returns {number} how much is gone, after the monotonic clamp
   */
  consume(amount) {
    if (this.state === 'alive' || this.state === 'gone') return this._consumed;

    const want = amount < 0 ? 0 : amount > 1 ? 1 : amount;
    if (want <= this._consumed) return this._consumed;
    this._consumed = want;

    if (this.state === 'dead') {
      // Skip the wait: this corpse is not lying there cooling, it is being
      // eaten. The depth pass has no idea the body is going away, so it would
      // go on casting a whole shadow off half of one — which is exactly why the
      // natural burn drops the shadow at this same transition.
      this.state = 'burning';
      this.timer = 0;
      this._castShadows(false);
    }

    this.dissolve = Math.max(this.dissolve, this._consumed);
    return this._consumed;
  }

  /**
   * Stain the body with whatever is eating it.
   *
   * `consume` says how much of a body is gone; this says what colour the rest
   * of it is while it goes. They are separate calls because they are separate
   * clocks — the Caustic Bloom turns a body green over half a second and then
   * spends three taking it apart, and a corpse that went green *as* it
   * disappeared would not have been dissolved by anything, only recoloured on
   * its way out.
   *
   * Monotonic, like `consume`, and for the same reason: this is polled every
   * frame by something that may lose its grip, and a body must not visibly
   * heal. The look is taken from the last caller rather than blended between
   * them — two things eating one corpse is not a case worth a colour space, and
   * the loudest one is whichever asked most recently.
   *
   * Unlike `consume` this is safe on a body that is still standing. Nothing
   * calls it that way today, but a poison that stains before it fells would be
   * the obvious next thing to want, and there is nothing here that a live body
   * cannot wear.
   *
   * @param {number} amount 0..1, how far the stain has taken the body
   * @param {{color: string, rimColor: string, rimEmissive: number,
   *          edgeColor: string, edgeEmissive: number}} look what it stains it
   *   with — settings colours, resolved through `getColor` each frame
   * @returns {number} how far it is stained, after the monotonic clamp
   */
  corrode(amount, look) {
    if (this.state === 'gone') return this._corroded;

    const want = amount < 0 ? 0 : amount > 1 ? 1 : amount;
    // The look is refreshed even when the amount is not, so dragging the
    // corroded colours in the editor moves a body that is already fully
    // stained — which is the whole point of being able to drag them.
    this._corrodeLook = look;
    if (want > this._corroded) this._corroded = want;
    return this._corroded;
  }

  /**
   * Build one piece's ragdoll and hand it the blow.
   *
   * @param {object} part
   * @param {{impulse: number, lift: number, spin: number}} force the blow's own
   * @param {{impulse: number, lift: number, spin: number}|null} weights what
   *   this half takes of it — null for a body that is still in one piece
   * @param {Set<string>|null} joints which of them this half simulates
   * @param {Set<string>|null} contacts which of *those* the other half can land
   *   on — null for a body that is still in one piece
   */
  _fall(part, x, z, force, weights, joints, contacts) {
    const ragdoll = new Ragdoll(part.bones, { include: joints, collide: contacts });
    if (!ragdoll.valid) {
      console.warn('[Dummy] no ragdoll could be built from this rig — the body will not fall');
      return;
    }

    part.ragdoll = ragdoll;
    ragdoll.strike(
      x,
      z,
      weights
        ? {
            impulse: force.impulse * weights.impulse,
            lift: force.lift * weights.lift,
            spin: force.spin * weights.spin
          }
        : force
    );
  }

  /**
   * Part the body along a plane, and stand a second copy of it up to hold the
   * other side.
   *
   * The plane is resolved in the *model's* space first, because that is the
   * space the blow arrives in and the space `height` and `tilt` are meant in:
   * `height` up the export from the feet, tipped `tilt` degrees away along the
   * blow so the cut reads as a stroke rather than as a bandsaw. The blow is in
   * world space and the root only ever turns about Y, so undoing that one yaw
   * is the whole of that conversion.
   *
   * It is then pushed into the mesh's vertex space (`_toBindPlane`), which is
   * where a shader can test it — and, critically, a space no bone can move.
   *
   * @returns {boolean} false if there was nothing to duplicate
   */
  _cut(x, z) {
    const cut = settings.slice;
    const yaw = this.root.rotation.y;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    // World → the model's frame: R(-yaw) on a horizontal vector.
    const dirX = x * cos - z * sin;
    const dirZ = x * sin + z * cos;

    // Up, tipped away along the blow. `tilt` is the only thing keeping the two
    // halves from meeting again in a perfectly flat plane as they settle.
    const tilt = MathUtils.degToRad(cut.tilt);
    _cutNormal.set(-dirX * Math.sin(tilt), Math.cos(tilt), -dirZ * Math.sin(tilt)).normalize();

    _cutPoint.copy(this._base);
    _cutPoint.y += MathUtils.clamp(cut.height, 0.05, 0.95) * this._localHeight;
    // The model's plane, and then the only one a shader can use.
    const bindOffset = this._toBindPlane(_cutNormal, _cutNormal.dot(_cutPoint), _cutNormalBind);

    const upper = cloneRigged(this.parts[0].model);
    this.root.add(upper);
    this.parts.push(this._makePart(upper));
    // The clone has to be in the world before the solver reads a bone off it.
    this.root.updateWorldMatrix(true, true);

    for (const [index, part] of this.parts.entries()) {
      const u = part.uniforms;
      // −1 keeps what is under the plane, +1 what is over it.
      u.uCutSide.value = index === 0 ? -1 : 1;
      u.uCutNormal.value.copy(_cutNormalBind);
      u.uCutOffset.value = bindOffset;
      u.uCutEdgeWidth.value = Math.max(1e-4, cut.edgeWidth * this._bindHeight);
      part.cutBone = part.bones.get('Spine') ?? part.bones.get('Hips') ?? null;
    }

    this.sliced = true;

    /* ---- what the rest of the frame gets to see of it ---- */
    // Where the cut is, in the world. Taken off the joint nearest the plane
    // rather than by pushing the plane's own point through the model's matrix:
    // a bone's world position is unambiguous, and the geometry's space is only
    // the model's space as long as nobody exports a mesh with a transform on it.
    const waist = this.parts[0].cutBone;
    if (waist) waist.getWorldPosition(this.cutPoint);
    else this.cutPoint.copy(this.root.position).setY(cut.height * this.height);
    // The plane's normal in world space — the direction the top half is lifted
    // clear along on the frame it parts (see `kill`).
    _cutNormalWorld.copy(_cutNormal).applyAxisAngle(UP, yaw);

    return true;
  }

  /**
   * @param {number} dt simulation delta — the corpse freezes with the sandbox
   * @param {import('three').Vector3|null} watch where to look, while it still can
   */
  update(dt, watch = null) {
    if (this.state === 'gone') return;
    this._clock += dt;
    // Frozen: the statue standing in for it is drawn by whoever froze it, and
    // the body waits, hidden, for `vanish`. Hidden here rather than in
    // `freeze`: the field steps right after the abilities do, so the swap
    // lands on the same frame, and a body frozen by something that never
    // bakes a statue still disappears rather than standing there stopped.
    if (this.state === 'frozen') {
      this.root.visible = false;
      return;
    }
    this._syncMaterials();

    const config = settings.dummies;

    if (this.state === 'alive') {
      if (config.watch && watch) this._turnToward(watch, dt);
      this.mixer.timeScale = settings.global.animationSpeed;
      this.mixer.update(dt);
      return;
    }

    // Down: the solver owns the bones, and the clock only decides when the body
    // stops being scenery. Two solvers, if it came apart.
    for (const part of this.parts) part.ragdoll?.update(dt);
    // And two solvers that know nothing of each other, so the torso would fall
    // straight through the legs it was cut off. This is the only thing that
    // puts the halves in each other's way, and it runs here rather than inside
    // either solver because this is the one object that owns both of them.
    if (this.sliced && collideRagdolls(this.parts[0].ragdoll, this.parts[1]?.ragdoll)) {
      // Only what moved: a half that is asleep was treated as furniture by the
      // pass above and is already posed where it settled.
      for (const part of this.parts) {
        if (!part.ragdoll?.asleep) part.ragdoll?.repose();
      }
    }

    this.timer += dt;

    if (this.state === 'dead') {
      if (this.timer < config.corpseTime) return;
      this.state = 'burning';
      this.timer = 0;
      // The depth pass has no idea the body is being burned away, so it would
      // go on casting a whole shadow off a corpse that is half gone. (The *cut*
      // it does know about — see `_makeDepthMaterial`.)
      this._castShadows(false);
      return;
    }

    // Past 1 rather than at it: the threshold is a strict `<`, so the last
    // few texels of the body need the burn to go over the top to clear.
    // Whichever clock is further along wins — see `consume`, which is the other
    // one and which can be well ahead of this by the time it starts.
    this.dissolve = Math.max(this._consumed, this.timer / Math.max(0.05, config.dissolveTime));
    // A body eaten outright is gone on that frame rather than lingering as a
    // fully-discarded shell until the natural burn catches up with it.
    if (this.dissolve < 1.05 && this._consumed < 1) return;

    this.state = 'gone';
    this.root.visible = false;
  }

  /** Face the caster, slowly enough that it reads as a turn rather than a snap. */
  _turnToward(target, dt) {
    if (dt <= 0) return;
    const yaw = Math.atan2(target.x - this.root.position.x, target.z - this.root.position.z);
    const delta = MathUtils.euclideanModulo(yaw - this.facing + Math.PI, Math.PI * 2) - Math.PI;
    const rate = MathUtils.clamp(settings.dummies.turnRate, 1e-6, 1);
    this.facing += delta * (1 - Math.pow(rate, dt));
    this.root.rotation.y = this.facing - this.forwardYaw;
  }

  /**
   * Release one piece of body.
   *
   * The geometry is the source rig's and is shared with every other dummy; the
   * materials, the skeletons and the depth overrides are this piece's own, so
   * they are the parts that must go.
   */
  _disposePart(part) {
    part.model.traverse((node) => {
      if (node.isSkinnedMesh) node.skeleton?.dispose();
      node.customDepthMaterial?.dispose();
      node.customDepthMaterial = undefined;
    });
    for (const material of part.materials) material.dispose();
    part.materials.length = 0;
    part.bones.clear();
    part.ragdoll = null;
    part.model.parent?.remove(part.model);
  }

  dispose() {
    this.mixer.stopAllAction();
    this.action = null;
    for (const part of this.parts) this._disposePart(part);
    this.parts.length = 0;
    this.root.parent?.remove(this.root);
  }
}
