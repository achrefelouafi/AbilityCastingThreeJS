import { AnimationMixer, Box3, Group, LoopRepeat, Quaternion, Vector3 } from 'three';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';

/**
 * Turns `dragon.glb` into the frame the Dragonfire Circle flies.
 *
 * The file is a Sketchfab black dragon (one skinned body in three meshes —
 * the hide, the wing membranes and the eyes — a 232-bone rig with its IK
 * controllers baked in, a ground plane it was presented on, and **one** clip:
 * `Scene`, a 22 s idle, standing, the wings working a little). There is no
 * flight cycle and no breath in it, and the ability needs both, so this file
 * owns the dragon's whole performance:
 *
 *   - the idle is kept as a *texture* — it plays under everything at a low
 *     weight (`idleWeight`), and what it contributes is the life in the neck,
 *     the jaw and the tail that a procedural pose never has;
 *   - the rest pose of this rig is the wings spread wide, which is already a
 *     glide, so the flight is laid over it rather than over the idle: a flap
 *     that starts at the shoulder and runs out to the fingers a beat later,
 *     a sweep that folds the wings back into a dive, and the tail answering
 *     both (`poseDragon`);
 *   - the breath is a pose too: the neck is bent, joint by joint, until the
 *     mouth points at whatever is to be burnt, and the jaw drops.
 *
 * What the ability is handed is a **canonical dragon**, the same contract
 * `PhoenixRig` and `SharkRig` give theirs:
 *
 *   - the snout points down local **+Z** and the back up **+Y**, measured off
 *     the skeleton — the export's axes never leave this file;
 *   - the origin is between the shoulders, where the wings join the body, so
 *     a bank or a dive turns it about the joint it would turn about;
 *   - it is `wingspan` metres from tip to tip, measured off the posed hide.
 */

const BONES = Object.freeze({
  pelvis: 'pelvic_2_03',
  chest: 'breast_018',
  head: 'head_022',
  jaw: 'Bone_024',
  upperLip: 'upper_lip_end_0219',
  lowerLip: 'lower_lip_end_0199',
  shoulderL: 'w_C_L.001_056',
  shoulderR: 'w_C_R.001_068',
  neck: ['ACT_neck_4_01', 'ACT_neck_3_019', 'ACT_neck_2_020', 'ACT_neck_1_021', 'head_022'],
  tail: ['tail_1_04', 'tail_2_05', 'tail_3_06', 'ik_ACT_tail_5_07'],
  /**
   * Each wing, root first. The hub (`w_C`) carries the whole wing; the arm
   * (`w1 → w2`) is the leading edge, `w4` and `w7` the two fingers the
   * membrane is stretched between. `lag` is how far behind the hub each one
   * moves through a beat, in radians of the cycle, and `gain` its share of
   * the stroke — which is what turns a hinge into a wave.
   */
  wingL: [
    { name: 'w_C_L_057', lag: 0, gain: 1 },
    { name: 'w1_L_058', lag: 0.55, gain: 0.35 },
    { name: 'w2_L_059', lag: 1.0, gain: 0.45 },
    { name: 'w4_L_062', lag: 0.9, gain: 0.3 },
    { name: 'w7_L_065', lag: 1.2, gain: 0.25 }
  ],
  wingR: [
    { name: 'w_C_R_069', lag: 0, gain: 1 },
    { name: 'w1_R_070', lag: 0.55, gain: 0.35 },
    { name: 'w2_R_071', lag: 1.0, gain: 0.45 },
    { name: 'w4_R_074', lag: 0.9, gain: 0.3 },
    { name: 'w7_R_077', lag: 1.2, gain: 0.25 }
  ]
});

/** The node the export was presented on; it has no place on this stage. */
const PRESENTATION = ['Plane', 'Hemi'];

const _box = new Box3();
const _meshBox = new Box3();
const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _axis = new Vector3();
const _q = new Quaternion();
const _parent = new Quaternion();

/**
 * GLTFLoader sanitises node names the way `PropertyBinding` does, which drops
 * the dots out of Blender's `.001` suffixes. Ask for both spellings.
 */
function findNode(root, name) {
  return root.getObjectByName(name) ?? root.getObjectByName(name.replace(/[.[\]:/]/g, '')) ?? null;
}

/**
 * @param {object} gltf the parsed glTF ({ scene, animations })
 * @param {object} [options]
 * @param {number} [options.wingspan] metres, wing tip to wing tip
 */
export function buildDragonRig(gltf, { wingspan = 8 } = {}) {
  const scene = gltf.scene;
  const idle = gltf.animations?.[0] ?? null;
  if (!idle) console.warn('[DragonRig] the export carries no idle — the dragon will fly on its rest pose alone');

  for (const name of PRESENTATION) {
    const node = findNode(scene, name);
    node?.parent?.remove(node);
  }
  scene.updateMatrixWorld(true);

  const skinned = [];
  scene.traverse((node) => {
    if (node.isSkinnedMesh) skinned.push(node);
  });
  if (skinned.length === 0) console.warn('[DragonRig] no skinned mesh found');

  /* ---- measure the rest pose: the wings spread, which is the glide ---- */
  _box.makeEmpty();
  for (const mesh of skinned) {
    mesh.computeBoundingBox();
    _meshBox.copy(mesh.boundingBox).applyMatrix4(mesh.matrixWorld);
    _box.union(_meshBox);
  }
  if (_box.isEmpty()) _box.setFromObject(scene);

  /* ---- which way is which, off the skeleton ---- */
  const pelvis = findNode(scene, BONES.pelvis);
  const head = findNode(scene, BONES.head);
  const fwd = new Vector3(0, 0, 1);
  if (pelvis && head) {
    fwd.subVectors(head.getWorldPosition(_a), pelvis.getWorldPosition(_b)).setY(0);
    if (fwd.lengthSq() > 1e-8) fwd.normalize();
    else fwd.set(0, 0, 1);
  }
  // The export stands on its plane, so world up is its up. Only the heading
  // has to be measured, and only about Y.
  const yaw = Math.atan2(-fwd.x, fwd.z);
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);

  /* ---- the span, across the heading ---- */
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < 8; i++) {
    const x = i & 1 ? _box.max.x : _box.min.x;
    const z = i & 2 ? _box.max.z : _box.min.z;
    const rx = x * cosY + z * sinY;
    const rz = -x * sinY + z * cosY;
    minX = Math.min(minX, rx);
    maxX = Math.max(maxX, rx);
    minZ = Math.min(minZ, rz);
    maxZ = Math.max(maxZ, rz);
  }
  const scale = wingspan / Math.max(1e-3, maxX - minX);

  /* ---- the pivot: between the shoulders ---- */
  const shoulderL = findNode(scene, BONES.shoulderL);
  const shoulderR = findNode(scene, BONES.shoulderR);
  const pivotPoint = new Vector3();
  if (shoulderL && shoulderR) {
    pivotPoint.addVectors(shoulderL.getWorldPosition(_a), shoulderR.getWorldPosition(_b)).multiplyScalar(0.5);
  } else {
    _box.getCenter(pivotPoint);
  }

  /* ---- the wrapper ---- */
  // Wrap rather than mutate: the glTF nodes keep their own transforms (the
  // skin depends on them) and the wrapper does the normalising.
  const pivot = new Group();
  pivot.name = 'DragonPivot';
  pivot.position.copy(pivotPoint).negate();
  pivot.add(scene);

  const source = new Group();
  // Not 'Dragon': the export has a node of that name, and the idle's tracks
  // would bind to the wrapper instead of it.
  source.name = 'DragonRigSource';
  source.scale.setScalar(scale);
  source.rotation.y = yaw;
  source.add(pivot);
  source.updateMatrixWorld(true);

  /* ---- landmarks, in rig metres ---- */
  const mouth = new Vector3(0, 0.5, 2);
  const upper = findNode(scene, BONES.upperLip);
  const lower = findNode(scene, BONES.lowerLip);
  if (upper && lower) {
    mouth.addVectors(upper.getWorldPosition(_a), lower.getWorldPosition(_b)).multiplyScalar(0.5);
    source.worldToLocal(mouth);
  }

  for (const mesh of skinned) {
    // A wing in mid-beat leaves the bind-space bounds far behind.
    mesh.frustumCulled = false;
  }

  return {
    source,
    idle,
    bones: BONES,
    wingspan,
    length: (maxZ - minZ) * scale,
    /** Where the mouth is at rest, rig space — a fallback for the breath. */
    mouth
  };
}

/**
 * One dragon off the template: its own skeleton, its own mixer with the idle
 * already looping, and every bone the performance moves looked up once and
 * paired with its rest rotation.
 *
 * @param {ReturnType<typeof buildDragonRig>} rig
 */
export function instanceDragon(rig) {
  const root = cloneSkeleton(rig.source);
  root.name = 'DragonInstance';
  const mixer = new AnimationMixer(root);
  let idle = null;
  if (rig.idle) {
    idle = mixer.clipAction(rig.idle);
    idle.setLoop(LoopRepeat, Infinity);
    idle.play();
  }

  const meshes = [];
  root.traverse((node) => {
    if (node.isSkinnedMesh) meshes.push(node);
  });

  /** Every bone this file writes, so it can be put back before the mixer runs. */
  const touched = [];
  const take = (name) => {
    const bone = findNode(root, name);
    if (bone) touched.push({ bone, rest: bone.quaternion.clone() });
    return bone;
  };
  const wing = (chain) =>
    chain
      .map((link) => ({ bone: take(link.name), lag: link.lag, gain: link.gain }))
      .filter((link) => link.bone);

  // Which side each wing is on, in the dragon's own frame: the flap is the
  // same rotation mirrored, and the mirror is this sign.
  root.updateMatrixWorld(true);
  const sideOf = (name) => {
    const node = findNode(root, name);
    if (!node) return 1;
    node.getWorldPosition(_a);
    root.worldToLocal(_a);
    return _a.x >= 0 ? 1 : -1;
  };

  return {
    root,
    mixer,
    idle,
    meshes,
    touched,
    head: findNode(root, rig.bones.head),
    jaw: take(rig.bones.jaw),
    upperLip: findNode(root, rig.bones.upperLip),
    lowerLip: findNode(root, rig.bones.lowerLip),
    neck: rig.bones.neck.map(take).filter(Boolean),
    tail: rig.bones.tail.map(take).filter(Boolean),
    wings: [
      { side: sideOf(rig.bones.wingL[0].name), links: wing(rig.bones.wingL) },
      { side: sideOf(rig.bones.wingR[0].name), links: wing(rig.bones.wingR) }
    ]
  };
}

/** Where the mouth is right now, in the world. */
export function dragonMouth(dragon, out) {
  if (dragon.upperLip && dragon.lowerLip) {
    dragon.upperLip.getWorldPosition(out);
    dragon.lowerLip.getWorldPosition(_c);
    return out.add(_c).multiplyScalar(0.5);
  }
  return dragon.head ? dragon.head.getWorldPosition(out) : out.set(0, 0, 0);
}

/**
 * Turn `bone` by `angle` about a *world* axis, about its own joint.
 *
 * The axis is carried into the bone's parent frame and the turn premultiplied
 * there, so it composes with whatever the clip put on the bone. The bone's
 * world matrix is refreshed at once: the next link of a chain reads it.
 */
function turnWorld(bone, axis, angle) {
  if (Math.abs(angle) < 1e-5) return;
  bone.parent.getWorldQuaternion(_parent).invert();
  _axis.copy(axis).applyQuaternion(_parent).normalize();
  _q.setFromAxisAngle(_axis, angle);
  bone.quaternion.premultiply(_q);
  bone.updateWorldMatrix(false, false);
}

const _fwd = new Vector3();
const _up = new Vector3();
const _side = new Vector3();
const _mouth = new Vector3();
const _head = new Vector3();
const _want = new Vector3();
const _have = new Vector3();

/**
 * The procedural half of the performance, laid over whatever the mixer left.
 *
 * Call after `root` has been placed for the frame. It ticks the mixer itself,
 * because the bones it writes have to be put back to rest *before* the clip
 * runs — a bone the idle has no track for would otherwise accumulate every
 * frame's turn on top of the last one's.
 *
 * @param {ReturnType<typeof instanceDragon>} dragon
 * @param {object} pose
 * @param {number} pose.dt          seconds, already scaled for playback speed
 * @param {number} pose.idleWeight  0..1, how much of the idle shows through
 * @param {number} pose.phase       radians through the wing beat
 * @param {number} pose.flap        radians of stroke at the shoulder
 * @param {number} pose.dihedral    radians the wings are held up (+) or down
 * @param {number} pose.sweep       radians the wings are folded back
 * @param {number} pose.jaw         radians the jaw is dropped
 * @param {number} pose.neckPitch   radians the neck curls down (+) at rest
 * @param {import('three').Vector3|null} pose.aim  a world point to breathe at
 * @param {number} pose.aimWeight   0..1, how far the neck goes to get there
 * @param {number} pose.aimLimit    radians, the most the neck will turn
 * @param {number} pose.tailSway    radians of tail swing
 * @param {number} pose.time        seconds, for the tail and the breathing
 */
export function poseDragon(dragon, pose) {
  for (const entry of dragon.touched) entry.bone.quaternion.copy(entry.rest);
  if (dragon.idle) dragon.idle.setEffectiveWeight(pose.idleWeight);
  dragon.mixer.update(pose.dt);
  dragon.root.updateMatrixWorld(true);

  // The dragon's own axes, in the world.
  const e = dragon.root.matrixWorld.elements;
  _side.set(e[0], e[1], e[2]).normalize();
  _up.set(e[4], e[5], e[6]).normalize();
  _fwd.set(e[8], e[9], e[10]).normalize();

  /* ---- the wings ---- */
  for (const wing of dragon.wings) {
    const s = wing.side;
    for (const link of wing.links) {
      const beat = Math.sin(pose.phase - link.lag);
      // Up and down about the body's long axis, mirrored per side. The hub
      // carries the held angle; every link carries its share of the beat.
      const stroke = (beat * pose.flap * link.gain + (link.lag === 0 ? pose.dihedral : 0)) * s;
      turnWorld(link.bone, _fwd, stroke);
      if (link.lag === 0) turnWorld(link.bone, _up, pose.sweep * s);
    }
  }

  /* ---- the tail: it answers the beat, and swings ---- */
  for (let i = 0; i < dragon.tail.length; i++) {
    const k = (i + 1) / dragon.tail.length;
    const sway = Math.sin(pose.time * 1.3 - i * 0.7) * pose.tailSway * k;
    const lift = Math.sin(pose.phase - 1.6 - i * 0.5) * pose.flap * 0.08;
    turnWorld(dragon.tail[i], _up, sway);
    turnWorld(dragon.tail[i], _side, lift);
  }

  /* ---- the neck: curl, then point the mouth ---- */
  const neck = dragon.neck;
  if (neck.length) {
    const share = pose.neckPitch / neck.length;
    for (const bone of neck) turnWorld(bone, _side, share);

    if (pose.aim && pose.aimWeight > 1e-3 && dragon.head) {
      // One rotation, from where the mouth points to where it should, shared
      // out evenly down the neck. Every share is about the same world axis,
      // so they compose to the whole of it at the head, and the curve of the
      // neck is kept rather than kinked at one joint.
      dragon.head.getWorldPosition(_head);
      dragonMouth(dragon, _mouth);
      _have.subVectors(_mouth, _head).normalize();
      _want.subVectors(pose.aim, _mouth).normalize();
      _axis.crossVectors(_have, _want);
      const sin = _axis.length();
      if (sin > 1e-5) {
        _axis.multiplyScalar(1 / sin);
        const angle = Math.min(Math.atan2(sin, _have.dot(_want)), pose.aimLimit) * pose.aimWeight;
        const each = angle / neck.length;
        const axis = _a.copy(_axis);
        for (const bone of neck) turnWorld(bone, axis, each);
      }
    }
  }

  /* ---- the jaw ---- */
  if (dragon.jaw) {
    dragon.jaw.quaternion.multiply(_q.setFromAxisAngle(_b.set(1, 0, 0), pose.jaw));
  }

  dragon.root.updateMatrixWorld(true);
}
