import { Box3, BufferAttribute, Group, Mesh, Vector3 } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Turns `arcane_tome.glb` into the book the Astral Tome conjures.
 *
 * The file was built in Blender (see the note at the bottom): a clasped tome
 * with gunmetal corner clamps, moon-gem studs, a lock knob on one side, a
 * strap, and a zodiac dial set into the cover. Its thirty-odd parts share
 * seven materials, named `Tome_*`, and the parts that glow carry their own
 * textures — the glyph ring an emissive zodiac strip, the studs a crescent.
 *
 * The ability is handed a **canonical tome**:
 *
 *   - one mesh per material, merged, so the book is seven draws, not thirty;
 *   - lying flat, cover up (+Y), spine toward −Z;
 *   - the origin is the middle of the book, so it turns and grows about its
 *     heart as it flies;
 *   - one metre across its widest side.
 *
 * `dialY` is the height of the dial's lit core over the origin, in canonical
 * metres — where the hologram rises from.
 */

const _box = new Box3();
const _centre = new Vector3();

/**
 * @param {object|null} gltf the parsed glTF, or null for a stand-in
 * @returns {{source: Group, width: number, depth: number, thickness: number, dialY: number}}
 */
export function buildTomeRig(gltf) {
  const groups = new Map();
  gltf?.scene?.updateMatrixWorld(true);
  gltf?.scene?.traverse((node) => {
    if (!node.isMesh) return;
    const material = Array.isArray(node.material) ? node.material[0] : node.material;
    const geometry = node.geometry.clone();
    geometry.applyMatrix4(node.matrixWorld);
    const entry = groups.get(material.name) ?? { material, geometries: [] };
    entry.geometries.push(geometry);
    groups.set(material.name, entry);
  });

  if (!groups.size) {
    console.warn('[TomeRig] no tome in the export — the cast will have no book');
    return null;
  }

  // Measure the whole book, then centre it and bring it to a metre across.
  _box.makeEmpty();
  for (const { geometries } of groups.values()) {
    for (const g of geometries) {
      g.computeBoundingBox();
      _box.union(g.boundingBox);
    }
  }
  _box.getCenter(_centre);
  const across = Math.max(1e-3, _box.max.x - _box.min.x, _box.max.z - _box.min.z);
  const k = 1 / across;

  const source = new Group();
  source.name = 'Tome';
  let dialY = (_box.max.y - _centre.y) * k;

  for (const [name, { material, geometries }] of groups) {
    for (const g of geometries) {
      g.translate(-_centre.x, -_centre.y, -_centre.z);
      g.scale(k, k, k);
    }
    const merged = mergeGeometries(uniform(geometries), false);
    if (!merged) continue;
    merged.computeBoundingSphere();
    const mesh = new Mesh(merged, material);
    mesh.name = name;
    source.add(mesh);

    if (name === 'Tome_Core') {
      merged.computeBoundingBox();
      dialY = merged.boundingBox.max.y;
    }
  }

  return {
    source,
    width: (_box.max.x - _box.min.x) * k,
    depth: (_box.max.z - _box.min.z) * k,
    thickness: (_box.max.y - _box.min.y) * k,
    dialY
  };
}

/**
 * `mergeGeometries` wants every part to carry the same attributes. Blender
 * only writes UVs where a part was unwrapped, so give the rest zeros and drop
 * anything that is not on every part.
 */
function uniform(geometries) {
  const hasUv = geometries.some((g) => g.attributes.uv);
  for (const g of geometries) {
    if (hasUv && !g.attributes.uv) {
      g.setAttribute('uv', new BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    }
  }
  const shared = Object.keys(geometries[0].attributes).filter((key) => geometries.every((g) => g.attributes[key]));
  const indexed = geometries.every((g) => g.index);
  for (const g of geometries) {
    for (const key of Object.keys(g.attributes)) if (!shared.includes(key)) g.deleteAttribute(key);
    for (const key of Object.keys(g.morphAttributes)) delete g.morphAttributes[key];
  }
  return indexed ? geometries : geometries.map((g) => (g.index ? g.toNonIndexed() : g));
}

/*
 * The Blender side, for when the tome needs re-cutting. Everything is built
 * from bmesh boxes, cones and tori in a scene of its own, `Tome`: two covers
 * with an inset panel and a trim frame, a page block whose UVs run the page
 * lines across its thickness, a rounded spine with two ribs, a gunmetal clamp
 * at every corner with a cap plate and a moon-gem stud, three edge clamps and
 * a lock knob, a strap with a ring, and the dial — a base, two rims, the lit
 * core, and an annulus whose UVs run clockwise round it so the zodiac strip
 * reads upright from above. The three textures (page edges, the twelve-glyph
 * zodiac strip, the crescent) are drawn with numpy as signed-distance strokes
 * and packed. Bevel modifiers with hardened normals, applied on export; GLB,
 * Y-up, meshes only.
 */
