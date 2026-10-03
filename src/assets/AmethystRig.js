import { BufferAttribute, BufferGeometry, IcosahedronGeometry, Vector3 } from 'three';

/**
 * Turns `amethyst_stones.glb` into the crystals the Amethyst Verdict throws.
 *
 * The file was cut in Blender (see the note at the bottom): five faceted
 * amethyst points, `Amethyst_A`…`Amethyst_E`, each the convex hull of a few
 * dozen jittered points round an elongated profile — which is what gives them
 * the broad, chipped facets of a real point rather than the even ones of a
 * subdivided primitive. One is double-terminated; one leans.
 *
 * They carry no material. Instead the **face-corner colour** is data, read by
 * `AmethystMaterials.js`, and moved here into its own attribute, `aCrystal`,
 * so nothing mistakes it for a tint:
 *
 *   - `x` — cloud: how milky the stone is at that corner (fbm + streaks);
 *   - `y` — a random number per facet, so neighbouring faces catch the light
 *     differently even where their normals nearly agree;
 *   - `z` — height up the stone, 0 at the foot, 1 at the point.
 *
 * The ability is handed **canonical crystals**: point along +Y, origin at the
 * middle of the stone's height (so it turns about its middle when it aims),
 * one metre tall. `radius` is the widest it gets off its axis, for spacing.
 */

const _box = new Vector3();

/**
 * @param {object|null} gltf the parsed glTF, or null to use the fallback
 * @returns {{variants: {name: string, geometry: BufferGeometry, radius: number}[]}}
 */
export function buildAmethystRig(gltf) {
  const variants = [];
  gltf?.scene?.traverse((node) => {
    if (!node.isMesh || !node.name.startsWith('Amethyst')) return;
    node.updateWorldMatrix(true, false);
    const geometry = node.geometry.clone();
    geometry.applyMatrix4(node.matrixWorld);
    variants.push({ name: node.name, geometry: canonical(geometry), radius: 0 });
  });
  variants.sort((a, b) => a.name.localeCompare(b.name));

  if (!variants.length) {
    console.warn('[AmethystRig] no crystals in the export — using a stand-in');
    variants.push({ name: 'fallback', geometry: canonical(fallback()), radius: 0 });
  }

  for (const variant of variants) {
    const p = variant.geometry.attributes.position;
    let r = 0;
    for (let i = 0; i < p.count; i++) r = Math.max(r, Math.hypot(p.getX(i), p.getZ(i)));
    variant.radius = r;
  }
  return { variants };
}

/** One metre tall, centred on its height, with `aCrystal` in place of the colour. */
function canonical(geometry) {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const height = Math.max(1e-3, box.max.y - box.min.y);
  box.getCenter(_box);
  geometry.translate(-_box.x, -_box.y, -_box.z);
  geometry.scale(1 / height, 1 / height, 1 / height);

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
    // A stand-in: no cloud, a facet number off the index, height off y.
    const p = geometry.attributes.position;
    for (let i = 0; i < n; i++) {
      data[i * 3] = 0.5;
      data[i * 3 + 1] = (Math.floor(i / 3) * 0.618) % 1;
      data[i * 3 + 2] = p.getY(i) + 0.5;
    }
  }
  geometry.setAttribute('aCrystal', new BufferAttribute(data, 3));
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/** A stretched, faceted lump, if the model never arrives. */
function fallback() {
  const geometry = new IcosahedronGeometry(0.5, 0).toNonIndexed();
  geometry.scale(0.55, 1.4, 0.5);
  const out = new BufferGeometry();
  out.setAttribute('position', geometry.attributes.position);
  out.computeVertexNormals();
  return out;
}

/*
 * The Blender side, for when the stones need re-cutting: for each variant,
 * eight rings of 6–8 points up an elongated profile (a taper to the point
 * above `tipBias`, a shorter one to the foot), each point jittered, plus an
 * apex and a foot; `bmesh.ops.convex_hull`, `dissolve_limit` at 7° to merge
 * near-coplanar triangles into broad facets, flat shading, and a CORNER
 * colour attribute `Col` written as (cloud, facet random, height). Exported
 * Y-up, no materials, with the active colour attribute as COLOR_0.
 */
