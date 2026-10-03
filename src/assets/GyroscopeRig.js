import { AnimationMixer, Box3, Group, LoopRepeat, Vector3 } from 'three';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';

/**
 * Turns `magical_gyroscope.glb` into the construct the Stormheart Gyroscope
 * hangs over its circle.
 *
 * The file is a Sketchfab brass gyroscope: one skinned mesh, three rings and a
 * rune core that are *bones* rather than meshes (`ring.outer`, `ring.middle`,
 * `ring.inner`, `rune`), and an 8.3 s loop, `gyro_spin`, that turns the rings
 * against each other. The amethyst in the middle is the rune.
 *
 * The ability is handed a **canonical gyroscope**:
 *
 *   - the origin is the rune — the core — so the bolts leave from the local
 *     origin and scaling it grows it about its heart, not about its foot;
 *   - it is `height` metres tall, posed;
 *   - the rings and the rune are found by name, because a clone has its own.
 */

const BONES = Object.freeze({
  outer: 'ring.outer_2',
  middle: 'ring.middle_1',
  inner: 'ring.inner_0',
  rune: 'rune_3'
});

export const GYRO_CLIPS = Object.freeze({ spin: 'gyro_spin' });

const _box = new Box3();
const _meshBox = new Box3();
const _core = new Vector3();

/**
 * @param {object} gltf the parsed glTF ({ scene, animations })
 * @param {object} [options]
 * @param {number} [options.height] metres, posed
 */
export function buildGyroscopeRig(gltf, { height = 2.2 } = {}) {
  const scene = gltf.scene;
  const clips = new Map((gltf.animations ?? []).map((clip) => [clip.name, clip]));
  const spin = clips.get(GYRO_CLIPS.spin) ?? gltf.animations?.[0] ?? null;
  if (!spin) console.warn('[GyroscopeRig] the export carries no spin clip — the rings will hold still');

  // Measure it as it moves, not as it was bound.
  const mixer = new AnimationMixer(scene);
  if (spin) mixer.clipAction(spin).play();
  mixer.update(0);
  scene.updateMatrixWorld(true);

  const meshes = [];
  scene.traverse((node) => {
    if (node.isMesh) meshes.push(node);
  });

  _box.makeEmpty();
  for (const mesh of meshes) {
    mesh.geometry.computeBoundingBox();
    _meshBox.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
    _box.union(_meshBox);
  }
  if (_box.isEmpty()) _box.setFromObject(scene);

  const rune = scene.getObjectByName(BONES.rune);
  if (rune) rune.getWorldPosition(_core);
  else _box.getCenter(_core);

  const measured = Math.max(1e-3, _box.max.y - _box.min.y);
  const scale = height / measured;

  // Wrap rather than mutate: the skin depends on the glTF nodes' own
  // transforms, and the wrapper does the normalising.
  const pivot = new Group();
  pivot.name = 'GyroPivot';
  pivot.position.copy(_core).negate();
  pivot.add(scene);

  const source = new Group();
  source.name = 'Gyroscope';
  source.scale.setScalar(scale);
  source.add(pivot);
  source.updateMatrixWorld(true);

  mixer.stopAllAction();
  mixer.uncacheRoot(scene);

  for (const mesh of meshes) {
    // A ring swung through 90° leaves the bind-space bounds behind.
    mesh.frustumCulled = false;
  }

  // The radius of the widest ring about the core, in canonical metres: where
  // the crawling arcs land and how far the glow should reach.
  const sx = Math.max(Math.abs(_box.max.x - _core.x), Math.abs(_box.min.x - _core.x));
  const sz = Math.max(Math.abs(_box.max.z - _core.z), Math.abs(_box.min.z - _core.z));
  const radius = Math.max(sx, sz, measured * 0.4) * scale;

  // The farthest the model reaches from the core — the foot of the stand,
  // usually. The condensing reveal has to grow past this or part of the brass
  // is left sitting on its fire band.
  let extent = 0;
  for (let i = 0; i < 8; i++) {
    const x = (i & 1 ? _box.max.x : _box.min.x) - _core.x;
    const y = (i & 2 ? _box.max.y : _box.min.y) - _core.y;
    const z = (i & 4 ? _box.max.z : _box.min.z) - _core.z;
    extent = Math.max(extent, Math.hypot(x, y, z));
  }

  return {
    source,
    spin,
    bones: BONES,
    height,
    radius,
    extent: extent * scale,
    /** Metres from the core down to the lowest point of the model. */
    below: (_core.y - _box.min.y) * scale
  };
}

/**
 * One gyroscope off the template: its own skeleton, its own mixer, the spin
 * bound and looping. The ability decides how fast it turns.
 *
 * @param {ReturnType<typeof buildGyroscopeRig>} rig
 */
export function instanceGyroscope(rig) {
  const root = cloneSkeleton(rig.source);
  root.name = 'Gyroscope';
  const mixer = new AnimationMixer(root);

  let spin = null;
  if (rig.spin) {
    spin = mixer.clipAction(rig.spin);
    spin.setLoop(LoopRepeat, Infinity);
  }

  const meshes = [];
  root.traverse((node) => {
    if (node.isMesh) meshes.push(node);
  });

  return {
    root,
    mixer,
    spin,
    meshes,
    rings: [rig.bones.outer, rig.bones.middle, rig.bones.inner]
      .map((name) => root.getObjectByName(name))
      .filter(Boolean),
    rune: root.getObjectByName(rig.bones.rune)
  };
}
