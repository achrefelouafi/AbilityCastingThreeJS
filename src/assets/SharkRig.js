import { AnimationMixer, Box3, Group, LoopOnce, LoopRepeat, Matrix4, Quaternion, Vector3 } from 'three';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';

/**
 * Turns `shark.glb` into the frame the Abyssal Maw flies.
 *
 * The file is a Sketchfab great white (one skinned body, two meshes of teeth
 * parented to the head and the jaw bones, a centimetre rig buried under four
 * wrapper nodes and a Z-up export) with two clips authored for this ability in
 * Blender, plus the rock that kicks the target and a chip of it for debris:
 *
 *   - **`Swim`** — the original in-place tail cycle.
 *   - **`Breach`** — the whole leap as one 2 s performance, *in place*: a
 *     power kick with the fins flared on the way out of the water, a glide
 *     with the snout lifting and the jaw opening to the full gape, the bite
 *     snapping shut at exactly **half way**, the head shaking the prey with
 *     the jaw clamped and chomping, then fins tucked and head down for the
 *     dive. The flight itself is not in it: the ability solves an arc for
 *     wherever the portals opened and plays the clip against it, so the bite
 *     frame lands on the bite.
 *
 * What the ability is handed is a **canonical shark**, the same contract
 * `PhoenixRig` gives the phoenix:
 *
 *   - the nose points down local **+Z** and the dorsal fin up **+Y**,
 *     whichever axes the export used — measured off the skeleton, posed;
 *   - the origin is the middle of the body, so pitching it along an arc turns
 *     it about its own centre and not about its nose;
 *   - it is `length` metres from snout to tail;
 *   - the head, the jaw and the two rows of teeth are found by name, because a
 *     clone has its own and the ability reads the bite off them every frame.
 */

const BONES = Object.freeze({
  head: 'Head_019',
  jaw: 'Jaw_020',
  mid: 'Spine03_04',
  tail: 'TailMid_06',
  finBase: 'FirstDorsalFin01_012',
  finTip: 'FirstDorsalFin02_013'
});

export const SHARK_CLIPS = Object.freeze({ breach: 'Breach', swim: 'Swim' });

/** Where in the Breach clip the jaw closes, as a fraction of it. Authored in Blender. */
export const SHARK_BITE_AT = 0.5;

const _box = new Box3();
const _meshBox = new Box3();
const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _m = new Matrix4();

/** The first plain (unskinned) mesh under `node`, not looking inside `skip`. */
function firstMesh(node, skip = null) {
  if (node === skip) return null;
  if (node.isMesh && !node.isSkinnedMesh) return node;
  for (const child of node.children) {
    const found = firstMesh(child, skip);
    if (found) return found;
  }
  return null;
}

/**
 * @param {object} gltf the parsed glTF ({ scene, animations })
 * @param {object} [options]
 * @param {number} [options.length] metres, snout to tail
 */
export function buildSharkRig(gltf, { length = 4.6 } = {}) {
  const scene = gltf.scene;
  const clips = new Map((gltf.animations ?? []).map((clip) => [clip.name, clip]));
  const breach = clips.get(SHARK_CLIPS.breach) ?? null;
  const swim = clips.get(SHARK_CLIPS.swim) ?? null;
  if (!breach) console.warn('[SharkRig] the export carries no Breach clip — the shark will hold its pose');

  /* ---- the props riding in the same file ---- */
  const rockNode = scene.getObjectByName('SharkRock');
  const chipNode = scene.getObjectByName('SharkRockChip');
  const rockGeometry = rockNode?.geometry ?? null;
  const chipGeometry = chipNode?.geometry ?? null;
  rockNode?.parent?.remove(rockNode);
  chipNode?.parent?.remove(chipNode);
  let rockHeight = 1;
  if (rockGeometry) {
    rockGeometry.computeBoundingBox();
    rockHeight = Math.max(0.05, rockGeometry.boundingBox.max.y);
    rockGeometry.computeVertexNormals();
  }
  if (chipGeometry) {
    chipGeometry.computeBoundingBox();
    chipGeometry.computeVertexNormals();
  }

  /* ---- pose it before measuring anything ---- */
  // The rest pose of a Sketchfab conversion is whatever the FBX bind happened
  // to be; the swim cycle is the shark. Measure the animal, not the bind.
  const mixer = new AnimationMixer(scene);
  if (swim) mixer.clipAction(swim).play();
  mixer.update(0);
  scene.updateMatrixWorld(true);

  const skinned = [];
  scene.traverse((node) => {
    if (node.isSkinnedMesh) skinned.push(node);
  });

  _box.makeEmpty();
  for (const mesh of skinned) {
    mesh.computeBoundingBox();
    _meshBox.copy(mesh.boundingBox).applyMatrix4(mesh.matrixWorld);
    _box.union(_meshBox);
  }
  if (_box.isEmpty()) _box.setFromObject(scene);

  /* ---- which way is which, off the skeleton ---- */
  const head = scene.getObjectByName(BONES.head);
  const tail = scene.getObjectByName(BONES.tail);
  const finBase = scene.getObjectByName(BONES.finBase);
  const finTip = scene.getObjectByName(BONES.finTip);
  const fwd = new Vector3(0, 0, 1);
  if (head && tail) fwd.subVectors(head.getWorldPosition(_a), tail.getWorldPosition(_b)).normalize();
  const up = new Vector3(0, 1, 0);
  if (finBase && finTip) up.subVectors(finTip.getWorldPosition(_a), finBase.getWorldPosition(_b));
  up.addScaledVector(fwd, -up.dot(fwd)).normalize();
  const lat = new Vector3().crossVectors(up, fwd).normalize();

  // Model → canonical: the basis (lat, up, fwd) onto (X, Y, Z) is its transpose.
  _m.makeBasis(lat, up, fwd).transpose();
  const orient = new Quaternion().setFromRotationMatrix(_m);

  /* ---- the length, along the animal ---- */
  let minZ = Infinity;
  let maxZ = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < 8; i++) {
    _c.set(i & 1 ? _box.max.x : _box.min.x, i & 2 ? _box.max.y : _box.min.y, i & 4 ? _box.max.z : _box.min.z);
    const z = _c.dot(fwd);
    const y = _c.dot(up);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const measured = Math.max(1e-3, maxZ - minZ);
  const scale = length / measured;

  // The middle of the box is the middle of the body: half way nose to tail.
  const centre = _box.getCenter(new Vector3());

  /* ---- the wrapper ---- */
  // Wrap rather than mutate: the glTF nodes keep their own transforms (the
  // skin depends on them) and the wrapper does the normalising.
  const pivot = new Group();
  pivot.name = 'SharkPivot';
  pivot.position.copy(centre).negate();
  pivot.add(scene);

  const source = new Group();
  source.name = 'Shark';
  source.scale.setScalar(scale);
  source.quaternion.copy(orient);
  source.add(pivot);
  source.updateMatrixWorld(true);

  mixer.stopAllAction();
  mixer.uncacheRoot(scene);

  for (const mesh of skinned) {
    // A thrashing tail leaves the bind-space bounds far behind.
    mesh.frustumCulled = false;
  }
  scene.traverse((node) => {
    if (node.isMesh) node.frustumCulled = false;
  });

  return {
    source,
    breach,
    swim,
    bones: BONES,
    length,
    girth: (maxY - minY) * scale,
    rockGeometry,
    chipGeometry,
    rockHeight
  };
}

/**
 * One shark off the template: its own skeleton, its own mixer, both clips
 * bound and ready. The ability decides which plays and at what time.
 *
 * @param {ReturnType<typeof buildSharkRig>} rig
 */
export function instanceShark(rig) {
  const root = cloneSkeleton(rig.source);
  root.name = 'Shark';
  const mixer = new AnimationMixer(root);

  let breach = null;
  if (rig.breach) {
    breach = mixer.clipAction(rig.breach);
    breach.setLoop(LoopOnce, 1);
    breach.clampWhenFinished = true;
  }
  let swim = null;
  if (rig.swim) {
    swim = mixer.clipAction(rig.swim);
    swim.setLoop(LoopRepeat, Infinity);
  }

  const meshes = [];
  root.traverse((node) => {
    if (node.isMesh) meshes.push(node);
  });

  const head = root.getObjectByName(rig.bones.head);
  const jaw = root.getObjectByName(rig.bones.jaw);
  // Two rows of teeth: the upper one rides the head, the lower one the jaw.
  const lowerTeeth = jaw ? firstMesh(jaw) : null;
  const upperTeeth = head ? firstMesh(head, jaw) : null;
  const toothCentre = (mesh) => {
    if (!mesh) return new Vector3();
    mesh.geometry.computeBoundingBox();
    return mesh.geometry.boundingBox.getCenter(new Vector3());
  };

  return {
    root,
    mixer,
    breach,
    swim,
    meshes,
    head,
    jaw,
    upperTeeth,
    lowerTeeth,
    upperCentre: toothCentre(upperTeeth),
    lowerCentre: toothCentre(lowerTeeth),
    mid: root.getObjectByName(rig.bones.mid),
    tail: root.getObjectByName(rig.bones.tail)
  };
}
