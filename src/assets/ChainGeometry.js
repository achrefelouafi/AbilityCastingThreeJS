import { BufferGeometry, Float32BufferAttribute, Vector3 } from 'three';

/**
 * The two pieces of hardware the Chains of Penance are built from, both
 * generated: a forged link, and the barbed head that leads each chain out of
 * its portal.
 *
 * Neither is a model on disk. A link is a tube swept round a *stadium* — two
 * straight sides and two half-round ends — which is the one silhouette that
 * reads as chain at any distance; a torus squashed into an oval reads as a
 * ring of rubber. The head is a faceted lance, flat-shaded on purpose: it is
 * small on screen and only ever seen moving fast, so what it needs is a few
 * planes that each catch the light at once.
 */

const _c = new Vector3();
const _t = new Vector3();
const _n = new Vector3();
const _z = new Vector3(0, 0, 1);

/**
 * One link, unit length along +Y, lying in the XY plane.
 *
 * The centreline is a stadium: `width` across, 1 long, swept by a tube of
 * radius `wire`. Everything is a fraction of the length, so the instance
 * matrix scales a link to whatever size the editor asks for.
 *
 * Besides the usual attributes it writes `aSide`, the angle round the wire
 * (cos of it, really): +1 on the outside of the stadium and −1 inside it. The
 * shader etches its runes on the outside faces only, where the eye actually
 * sees them, and runs the heat down the inner faces where link bears on link.
 *
 * @param {object} [options]
 * @param {number} [options.width] outer width across the link, × its length
 * @param {number} [options.wire] radius of the wire, × the length
 * @param {number} [options.tubular] segments round the stadium
 * @param {number} [options.radial] segments round the wire
 */
export function createLinkGeometry({ width = 0.62, wire = 0.13, tubular = 36, radial = 8 } = {}) {
  const rc = Math.max(0.02, width * 0.5 - wire); // radius of the half-round ends, to the centreline
  const sl = Math.max(0, 0.5 - wire - rc); // half-length of the straight sides
  const straight = 2 * sl;
  const arc = Math.PI * rc;
  const perimeter = 2 * straight + 2 * arc;

  const positions = [];
  const normals = [];
  const uvs = [];
  const sides = [];
  const indices = [];

  /** Point on the centreline and its outward in-plane normal, `s` metres round it. */
  const centreline = (s) => {
    s = ((s % perimeter) + perimeter) % perimeter;
    if (s < straight) {
      // right side, going up
      _c.set(rc, -sl + s, 0);
      _n.set(1, 0, 0);
      return;
    }
    s -= straight;
    if (s < arc) {
      const a = s / rc;
      _c.set(rc * Math.cos(a), sl + rc * Math.sin(a), 0);
      _n.set(Math.cos(a), Math.sin(a), 0);
      return;
    }
    s -= arc;
    if (s < straight) {
      // left side, going down
      _c.set(-rc, sl - s, 0);
      _n.set(-1, 0, 0);
      return;
    }
    s -= straight;
    const a = Math.PI + s / rc;
    _c.set(rc * Math.cos(a), -sl + rc * Math.sin(a), 0);
    _n.set(Math.cos(a), Math.sin(a), 0);
  };

  for (let i = 0; i <= tubular; i++) {
    const s = (i / tubular) * perimeter;
    centreline(s);
    for (let j = 0; j <= radial; j++) {
      const phi = (j / radial) * Math.PI * 2;
      const cp = Math.cos(phi);
      const sp = Math.sin(phi);
      // Round the wire: out along the in-plane normal and the plane's own normal.
      _t.copy(_n).multiplyScalar(cp).addScaledVector(_z, sp);
      positions.push(_c.x + _t.x * wire, _c.y + _t.y * wire, _c.z + _t.z * wire);
      normals.push(_t.x, _t.y, _t.z);
      uvs.push(i / tubular, j / radial);
      sides.push(cp);
    }
  }

  for (let i = 0; i < tubular; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * (radial + 1) + j;
      const b = (i + 1) * (radial + 1) + j;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('aSide', new Float32BufferAttribute(sides, 1));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * The head a chain is thrown with: a four-faceted lance with two barbs swept
 * back off its shoulders. Unit length along +Y, the point at the top and the
 * socket the chain hangs off at the origin.
 *
 * Non-indexed and flat-shaded — every facet one normal, so it glints as a
 * whole as it turns rather than shading smoothly like a cone.
 */
export function createHookGeometry() {
  const positions = [];
  const sides = [];
  const tri = (a, b, c, side = 1) => {
    positions.push(...a, ...b, ...c);
    sides.push(side, side, side);
  };

  const tip = [0, 1, 0];
  const base = [0, 0, 0];
  const shoulderY = 0.32;
  const w = 0.17; // half-width of the blade at the shoulders
  const t = 0.07; // half-thickness
  const ring = [
    [w, shoulderY, 0],
    [0, shoulderY, t],
    [-w, shoulderY, 0],
    [0, shoulderY, -t]
  ];

  // The blade: four facets up to the point, four down to the socket.
  for (let i = 0; i < 4; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % 4];
    tri(a, b, tip, 1);
    tri(b, a, base, -1);
  }

  // Two barbs, swept back and out off the shoulders.
  for (const sx of [1, -1]) {
    const root = [sx * w * 0.9, shoulderY + 0.02, 0];
    const rootUp = [sx * w * 0.35, shoulderY + 0.22, 0];
    const point = [sx * (w + 0.16), shoulderY - 0.2, 0];
    const front = [sx * w * 0.6, shoulderY + 0.08, t * 0.8];
    const back = [sx * w * 0.6, shoulderY + 0.08, -t * 0.8];
    const order = (a, b, c) => (sx > 0 ? tri(a, b, c, 0.5) : tri(a, c, b, 0.5));
    order(root, point, front);
    order(rootUp, front, point);
    order(point, root, back);
    order(point, back, rootUp);
    order(front, rootUp, root);
    order(back, root, rootUp);
  }

  // A collar at the socket, where the last link hangs.
  const collar = 0.06;
  const cy = -0.06;
  const cr = [
    [collar, cy, 0],
    [0, cy, collar],
    [-collar, cy, 0],
    [0, cy, -collar]
  ];
  for (let i = 0; i < 4; i++) {
    const a = cr[i];
    const b = cr[(i + 1) % 4];
    tri(b, a, [0, 0.04, 0], -1);
    tri(a, b, [0, cy - 0.06, 0], -1);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aSide', new Float32BufferAttribute(sides, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}
