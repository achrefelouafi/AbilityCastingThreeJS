import { BoxGeometry, BufferAttribute, BufferGeometry, Vector3 } from 'three';

/**
 * Turns `wildroot_reliquary.glb` into the stones the Wildroot Reliquary hangs
 * in its arch.
 *
 * The file was cut in Blender (see the note at the bottom) and holds two kinds
 * of stone, three of each:
 *
 *   - `Reliquary_Slab_A…C` — curved segments of a ring, 40°–64° of arc, hewn
 *     out of one block: a raised rim round a recessed panel on both faces, the
 *     edges knocked about with chips. They are **canonical ring pieces**: the
 *     ring's centre is the mesh's origin, the arc is centred on +Y, the outer
 *     radius is one metre and the panels face ±Z — so placing one on a halo
 *     of any size is a rotation about Z and a uniform scale.
 *   - `Reliquary_Cube_A…C` — a metre cube with a recessed panel sunk into
 *     every face and its corners chipped, centred on its origin.
 *
 * They carry no material. The **vertex colour is data**, moved here into its
 * own attribute, `aStone`, so nothing mistakes it for a tint:
 *
 *   - `x` — panel: 1 on the recessed face the carving is cut into, 0 on the
 *     rim, the flanks and inside a chip;
 *   - `y` — on a slab, how far round its arc (0 at one end, 1 at the other);
 *     on a cube, which face (0, 0.2 … 1);
 *   - `z` — on a slab, how far out from the inner edge to the outer one.
 *
 * `arc` on a slab is the angle it spans, radians, read back off the mesh, so
 * the halo can lay them end to end with a gap between them.
 */

const _c = new Vector3();

/**
 * @param {object|null} gltf the parsed glTF, or null to use the stand-ins
 * @returns {{slabs: {name: string, geometry: BufferGeometry, arc: number}[],
 *            cubes: {name: string, geometry: BufferGeometry}[]}}
 */
export function buildReliquaryRig(gltf) {
  const slabs = [];
  const cubes = [];
  gltf?.scene?.traverse((node) => {
    if (!node.isMesh) return;
    node.updateWorldMatrix(true, false);
    const geometry = node.geometry.clone();
    geometry.applyMatrix4(node.matrixWorld);
    if (node.name.startsWith('Reliquary_Slab')) slabs.push({ name: node.name, geometry: dataOf(geometry), arc: arcOf(geometry) });
    else if (node.name.startsWith('Reliquary_Cube')) cubes.push({ name: node.name, geometry: centred(dataOf(geometry)) });
  });
  slabs.sort((a, b) => a.name.localeCompare(b.name));
  cubes.sort((a, b) => a.name.localeCompare(b.name));

  if (!slabs.length || !cubes.length) {
    console.warn('[ReliquaryRig] stones missing from the export — using stand-ins');
    if (!slabs.length) slabs.push({ name: 'fallback', geometry: fallbackSlab(), arc: 0.9 });
    if (!cubes.length) cubes.push({ name: 'fallback', geometry: dataOf(new BoxGeometry(1, 1, 1).toNonIndexed()) });
  }
  return { slabs, cubes };
}

/** Move COLOR_0 into `aStone`, or derive a stand-in from the shape. */
function dataOf(geometry) {
  const color = geometry.getAttribute('color');
  const n = geometry.attributes.position.count;
  const data = new Float32Array(n * 3);
  if (color) {
    for (let i = 0; i < n; i++) {
      data[i * 3] = color.getX(i);
      data[i * 3 + 1] = color.getY(i);
      data[i * 3 + 2] = color.getZ(i);
    }
    geometry.deleteAttribute('color');
  } else {
    for (let i = 0; i < n; i++) data[i * 3] = 1;
  }
  geometry.setAttribute('aStone', new BufferAttribute(data, 3));
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function centred(geometry) {
  geometry.computeBoundingBox();
  geometry.boundingBox.getCenter(_c);
  geometry.translate(-_c.x, -_c.y, -_c.z);
  geometry.computeBoundingSphere();
  return geometry;
}

/** The angle a slab spans about the ring's centre. */
function arcOf(geometry) {
  const p = geometry.attributes.position;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < p.count; i++) {
    const a = Math.atan2(p.getX(i), p.getY(i));
    if (a < lo) lo = a;
    if (a > hi) hi = a;
  }
  return Math.max(0.1, hi - lo);
}

/** A plain ring piece, if the model never arrives. */
function fallbackSlab() {
  const segs = 16;
  const arc = 0.9;
  const pos = [];
  const ring = (a, r, z) => [Math.sin(a) * r, Math.cos(a) * r, z];
  for (let i = 0; i < segs; i++) {
    const a0 = -arc / 2 + (arc * i) / segs;
    const a1 = -arc / 2 + (arc * (i + 1)) / segs;
    const quad = (p0, p1, p2, p3) => pos.push(...p0, ...p1, ...p2, ...p0, ...p2, ...p3);
    quad(ring(a0, 0.74, 0.1), ring(a1, 0.74, 0.1), ring(a1, 1, 0.1), ring(a0, 1, 0.1));
    quad(ring(a0, 1, -0.1), ring(a1, 1, -0.1), ring(a1, 0.74, -0.1), ring(a0, 0.74, -0.1));
    quad(ring(a0, 1, 0.1), ring(a1, 1, 0.1), ring(a1, 1, -0.1), ring(a0, 1, -0.1));
    quad(ring(a0, 0.74, -0.1), ring(a1, 0.74, -0.1), ring(a1, 0.74, 0.1), ring(a0, 0.74, 0.1));
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  geometry.computeVertexNormals();
  return dataOf(geometry);
}

/*
 * The Blender side, for when the stones need re-cutting. A slab is an annular
 * sector (inner radius 0.74, outer 1, 0.2 thick) swept in 2.5° steps in the
 * X-Z plane facing −Y; both faces are `inset_region`-ed 0.03 and sunk 0.024 to
 * make the panel; a bevel and two levels of simple subdivision, then a POINT
 * float colour `Col` written as (panel, arc, radius) *before* the wear — a
 * cloud-texture displace of 0.03 and six to ten icospheres booleaned out of
 * the edges with the MANIFOLD solver (EXACT returns an empty mesh on these in
 * 5.1). A cube is the same with every face inset 0.13 and sunk 0.05, `Col`
 * written as (panel, face/5, 0). Sharp edges at 40°, exported Y-up with no
 * materials and the active colour attribute as COLOR_0.
 */
