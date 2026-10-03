import { AnimationMixer, Box3, BufferAttribute, Group, LoopOnce, LoopRepeat, Matrix4, Quaternion, Vector3 } from 'three';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';

/**
 * Turns `wolf.glb` into the frame the Astral Fang flies.
 *
 * The file is a Sketchfab wolf (one skinned body, a skirt of alpha-carded fur
 * over the neck and the flanks, and teeth, claws and eyes skinned to the same
 * German-named rig, Z-up, wrapped in four export nodes) with one clip authored
 * for this ability in Blender (`art/wolf/wolf.blend`) on top of the original
 * gallop:
 *
 *   - **`Gallop`** — the original in-place run cycle, re-keyed in Blender
 *     with every channel the run leaves alone taken from Pounce's first
 *     frame, so the two share a root and blend without a pop. The ability
 *     plays it against the ground speed, so the paws plant.
 *   - **`Pounce`** — the whole attack as one 2 s performance, *in place*: the
 *     push-off out of the rift with the ears pinned, the stretch of the
 *     suspension with the forelegs reaching and the jaw opening to a snarling
 *     gape, the bite snapping shut at exactly **half way** with the forelegs
 *     clutching, then the head-shake, the gather, and the forelegs reaching
 *     again for the far rift. The flight itself is not in it — the ability
 *     solves an arc between the rifts and plays the clip against it, so the
 *     bite frame lands on the bite. Same contract as the shark's `Breach`.
 *
 * What the ability is handed is a **canonical wolf**:
 *
 *   - the nose points down local **+Z** and the back up **+Y**, measured off
 *     the skeleton, posed;
 *   - the origin is the middle of the body;
 *   - it is `length` metres from the nose to the root of the tail;
 *   - every part is tagged (`userData.wolfPart`: body, fur, teeth, claws,
 *     eyes) and every solid part carries a `bary` attribute — barycentric
 *     coordinates with the diagonal of every quad hidden — so the hologram
 *     can draw the model's own wireframe without a second draw.
 */

const BONES = Object.freeze({
  head: 'Kopf_03',
  jaw: 'Unterkiefer_012',
  upperLip: 'Mauloben_021',
  lowerLip: 'Maulunten_011',
  chest: 'Brust_029',
  pelvis: 'Becken_05',
  tail: 'Schwanz_003_038',
  eyeL: 'aug_L_07',
  eyeR: 'Aug_R_06',
  pawFL: 'Vorderpfote_L_026',
  pawFR: 'Vorderpfote_R_035',
  pawHL: 'Pfote2_L_043',
  pawHR: 'Pfote2_R_047'
});

export const WOLF_CLIPS = Object.freeze({ pounce: 'Pounce', run: 'Gallop' });

/** Where in the Gallop the Pounce starts and ends, as a fraction of it: push-off and forefeet down. */
export const WOLF_TAKEOFF_AT = 13.5 / 16;
export const WOLF_LANDING_AT = 13 / 16;

/** Where in the Pounce clip the jaw closes, as a fraction of it. Authored in Blender. */
export const WOLF_BITE_AT = 0.5;

/** Which part of the model a mesh is, off the material the export gave it. */
function partOf(mesh) {
  const name = `${mesh.material?.name ?? ''} ${mesh.name}`.toLowerCase();
  if (name.includes('fur')) return 'fur';
  if (name.includes('teeth')) return 'teeth';
  if (name.includes('claw')) return 'claws';
  if (name.includes('eye')) return 'eyes';
  return 'body';
}

/**
 * Non-indexed, with a `bary` attribute: one corner of the triangle per axis.
 *
 * The longest edge of each triangle is almost always the diagonal its quad
 * was split along, so its coordinate is pushed out to 1 everywhere along it
 * and that edge never draws — the lattice reads as the model's quads, the way
 * a wireframe in a DCC does, rather than as a mesh of triangles.
 */
function wireGeometry(geometry) {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry;
  const pos = flat.attributes.position;
  const count = pos.count;
  const bary = new Float32Array(count * 3);
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  for (let i = 0; i < count; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    // Edge opposite each corner: corner 0 faces bc, 1 faces ca, 2 faces ab.
    const e0 = b.distanceToSquared(c);
    const e1 = c.distanceToSquared(a);
    const e2 = a.distanceToSquared(b);
    const longest = e0 >= e1 && e0 >= e2 ? 0 : e1 >= e2 ? 1 : 2;
    for (let k = 0; k < 3; k++) {
      const o = (i + k) * 3;
      bary[o] = k === 0 ? 1 : 0;
      bary[o + 1] = k === 1 ? 1 : 0;
      bary[o + 2] = k === 2 ? 1 : 0;
      // The hidden edge's coordinate is 0 along it; lift it out of reach.
      bary[o + longest] += 1;
    }
  }
  flat.setAttribute('bary', new BufferAttribute(bary, 3));
  return flat;
}

const _box = new Box3();
const _meshBox = new Box3();
const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _m = new Matrix4();

/**
 * @param {object} gltf the parsed glTF ({ scene, animations })
 * @param {object} [options]
 * @param {number} [options.length] metres, nose to the root of the tail
 */
export function buildWolfRig(gltf, { length = 2.2 } = {}) {
  const scene = gltf.scene;
  const clips = new Map((gltf.animations ?? []).map((clip) => [clip.name, clip]));
  const pounce = clips.get(WOLF_CLIPS.pounce) ?? null;
  const run = clips.get(WOLF_CLIPS.run) ?? null;
  if (!pounce) console.warn('[WolfRig] the export carries no Pounce clip — the wolf will hold its pose');
  // The Sketchfab file animates a light rig and a ground plane that were not
  // exported; drop their tracks rather than have every mixer warn about them.
  for (const clip of [pounce, run]) {
    if (clip) clip.tracks = clip.tracks.filter((track) => scene.getObjectByName(track.name.split('.')[0]));
  }

  /* ---- pose it before measuring anything ---- */
  // Off the attack itself, so the canonical frame is the one it is authored in.
  const mixer = new AnimationMixer(scene);
  const measureClip = pounce ?? run;
  if (measureClip) mixer.clipAction(measureClip).play();
  mixer.update(0);
  scene.updateMatrixWorld(true);

  const skinned = [];
  scene.traverse((node) => {
    if (node.isSkinnedMesh) skinned.push(node);
  });

  _box.makeEmpty();
  for (const mesh of skinned) {
    if (partOf(mesh) !== 'body') continue;
    mesh.computeBoundingBox();
    _meshBox.copy(mesh.boundingBox).applyMatrix4(mesh.matrixWorld);
    _box.union(_meshBox);
  }
  if (_box.isEmpty()) _box.setFromObject(scene);

  /* ---- which way is which, off the skeleton ---- */
  const head = scene.getObjectByName(BONES.head);
  const pelvis = scene.getObjectByName(BONES.pelvis);
  const pawFL = scene.getObjectByName(BONES.pawFL);
  const pawHL = scene.getObjectByName(BONES.pawHL);
  const chest = scene.getObjectByName(BONES.chest);
  const fwd = new Vector3(0, 0, 1);
  if (head && pelvis) fwd.subVectors(head.getWorldPosition(_a), pelvis.getWorldPosition(_b)).normalize();
  // Up is away from the feet: the spine minus the mean of a fore and a hind paw.
  const up = new Vector3(0, 1, 0);
  if (chest && pawFL && pawHL) {
    chest.getWorldPosition(_a);
    pawFL.getWorldPosition(_b);
    pawHL.getWorldPosition(_c);
    up.copy(_a).sub(_b.add(_c).multiplyScalar(0.5));
  }
  up.addScaledVector(fwd, -up.dot(fwd)).normalize();
  const lat = new Vector3().crossVectors(up, fwd).normalize();

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
  const centre = _box.getCenter(new Vector3());

  /* ---- the rest pose's own frame, for patterns that ride the animal ---- */
  // Every part is skinned to one armature with no transform of its own, so
  // the body's geometry space is every part's. Measured off the body: its
  // middle, which way its nose is, and one over its length.
  const body = skinned.find((mesh) => partOf(mesh) === 'body') ?? skinned[0];
  const bind = { centre: new Vector3(), fwd: new Vector3(0, 0, 1), scale: 1 };
  if (body) {
    body.geometry.computeBoundingBox();
    body.geometry.boundingBox.getCenter(bind.centre);
    _m.copy(body.matrixWorld).invert();
    bind.fwd.copy(fwd).transformDirection(_m);
    const size = body.geometry.boundingBox.getSize(_a);
    bind.scale = 1 / Math.max(1e-4, Math.abs(size.dot(bind.fwd)));
  }

  /* ---- the wrapper ---- */
  const pivot = new Group();
  pivot.name = 'WolfPivot';
  pivot.position.copy(centre).negate();
  pivot.add(scene);

  const source = new Group();
  source.name = 'Wolf';
  source.scale.setScalar(scale);
  source.quaternion.copy(orient);
  source.add(pivot);
  source.updateMatrixWorld(true);

  mixer.stopAllAction();
  mixer.uncacheRoot(scene);

  /* ---- the parts, ready for the hologram ---- */
  for (const mesh of skinned) {
    const part = partOf(mesh);
    mesh.userData.wolfPart = part;
    // The fur is alpha cards: its own wire would be a scribble.
    if (part !== 'fur') mesh.geometry = wireGeometry(mesh.geometry);
    mesh.frustumCulled = false;
  }
  scene.traverse((node) => {
    if (node.isMesh) node.frustumCulled = false;
  });

  return {
    source,
    pounce,
    run,
    bones: BONES,
    bind,
    length,
    height: (maxY - minY) * scale
  };
}

/**
 * One wolf off the template: its own skeleton, its own mixer, both clips
 * bound. The ability decides which plays and at what time.
 *
 * @param {ReturnType<typeof buildWolfRig>} rig
 */
export function instanceWolf(rig) {
  const root = cloneSkeleton(rig.source);
  root.name = 'Wolf';
  const mixer = new AnimationMixer(root);

  let pounce = null;
  if (rig.pounce) {
    pounce = mixer.clipAction(rig.pounce);
    pounce.setLoop(LoopOnce, 1);
    pounce.clampWhenFinished = true;
  }
  let run = null;
  if (rig.run) {
    run = mixer.clipAction(rig.run);
    run.setLoop(LoopRepeat, Infinity);
  }

  const meshes = [];
  root.traverse((node) => {
    if (node.isSkinnedMesh) meshes.push(node);
  });

  const bone = (key) => root.getObjectByName(rig.bones[key]) ?? null;
  return {
    root,
    mixer,
    pounce,
    run,
    meshes,
    head: bone('head'),
    jaw: bone('jaw'),
    upperLip: bone('upperLip'),
    lowerLip: bone('lowerLip'),
    eyeL: bone('eyeL'),
    eyeR: bone('eyeR'),
    paws: [bone('pawFL'), bone('pawFR'), bone('pawHL'), bone('pawHR')].filter(Boolean),
    chest: bone('chest'),
    pelvis: bone('pelvis'),
    tail: bone('tail')
  };
}
