import {
  AdditiveBlending,
  Color,
  DoubleSide,
  MeshDepthMaterial,
  MeshStandardMaterial,
  RGBADepthPacking,
  ShaderMaterial,
  Vector4
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { frame, sharedUniforms } from '../core/FrameUniforms.js';
import { patchOnBeforeCompile } from '../utils/shaderPatch.js';
import { MAX_CURVES, ROOT_SAMPLES } from '../assets/RootGeometry.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * Every shader the Wildroot Reliquary brings with it.
 *
 *   - the **bark**: every root, tendril and vine, one instanced draw placed
 *     entirely in the vertex stage off the curve texture (`RootGeometry.js`).
 *     Lit and shadowed like the stage — it is a real `MeshStandardMaterial`
 *     with fibrous bark bump-mapped into it, moss and teal lichen grown over
 *     it where the noise says so, and the one thing a real root does not
 *     have: light in its crevices, with sap pulses running up from the floor
 *     and a white-hot tip while it is still growing;
 *   - the **leaves**: narrow blades hung off the same curves, folded down the
 *     midrib, drooping under their own weight, lit through from behind;
 *   - the **stone**: the carved slabs and rune cubes cut in Blender — dark
 *     slate with teal patina, a woven lattice cut into every panel, and a row
 *     of runes in medallions that ignite one after another;
 *   - the **sigil**: the circle on the floor, a braided band, a ring of runes,
 *     a whorl of leaves round the body and two root veins torn out toward
 *     the feet of the arch;
 *   - the **aura**: the soft light standing in the ring of stones, behind
 *     whatever hangs in it.
 */

const ADDITIVE = {
  transparent: true,
  depthWrite: false,
  blending: AdditiveBlending,
  toneMapped: false
};

/* ---------------------------------------------------------------------- */
/* Shared GLSL                                                              */
/* ---------------------------------------------------------------------- */

/** Reading a curve, and placing a root or a leaf on it. */
const CURVE_DECL = /* glsl */ `
  #define ROOT_SAMPLES ${ROOT_SAMPLES}
  #define MAX_CURVES ${MAX_CURVES}
  #define RTAU 6.283185307179586
  uniform sampler2D uCurves;
  uniform vec4 uCurveState[MAX_CURVES];
  uniform vec4 uCurveLook[MAX_CURVES];
  uniform float uTime;
  uniform float uTaper;
  uniform float uLeafSize;

  vec4 curveTex(int row, float s) {
    float x = clamp(s, 0.0, 1.0) * float(ROOT_SAMPLES - 1);
    int i0 = int(floor(x));
    int i1 = min(i0 + 1, ROOT_SAMPLES - 1);
    return mix(texelFetch(uCurves, ivec2(i0, row), 0), texelFetch(uCurves, ivec2(i1, row), 0), x - float(i0));
  }

  /** Centre + radius, and a frame (T, N, B), at s along curve ci. */
  void curveFrame(int ci, float s, out vec4 c, out vec3 T, out vec3 N, out vec3 B) {
    c = curveTex(ci * 2, s);
    float ds = 1.0 / float(ROOT_SAMPLES - 1);
    T = curveTex(ci * 2, min(1.0, s + ds)).xyz - curveTex(ci * 2, max(0.0, s - ds)).xyz;
    T = dot(T, T) > 1e-10 ? normalize(T) : vec3(0.0, 1.0, 0.0);
    N = curveTex(ci * 2 + 1, s).xyz;
    N = N - T * dot(N, T);
    N = dot(N, N) > 1e-8 ? normalize(N) : vec3(1.0, 0.0, 0.0);
    B = normalize(cross(N, T));
  }
`;

const ROOT_DECL = /* glsl */ `
  ${CURVE_DECL}
  attribute vec4 aStrand;   // curve, phase, radius share, offset share
  attribute vec4 aStrand2;  // handedness of the twist (× the curve's turns/m), seed, kind, -
  varying vec4 vRoot;       // metres along, angle round, metres short of the tip, kind
  varying vec4 vRoot2;      // seed, growing, wither, sap glow
  varying float vRootUp;    // how much the surface faces the sky

  void rootPlace(out vec3 P, out vec3 Nrm) {
    int ci = int(aStrand.x + 0.5);
    vec4 st = uCurveState[ci];
    float L = max(st.w, 1e-3);
    float g = st.x;
    float u = position.x;
    float s = min(u, g);
    vec4 c; vec3 T; vec3 N; vec3 B;
    curveFrame(ci, s, c, T, N, B);
    float along = s * L;

    // The last stretch tapers to a point: at the tip while it grows, at the
    // end of the curve once it has.
    float taper = sqrt(clamp((g - u) * L / max(0.05, uTaper), 0.0, 1.0));

    // A strand winds round the centreline; at the tip the strands close up.
    float phi = RTAU * (aStrand.y + along * aStrand2.x * uCurveLook[ci].x);
    vec3 centre = c.xyz + (N * cos(phi) + B * sin(phi)) * c.w * aStrand.w * mix(0.2, 1.0, taper);

    float ang = position.y * RTAU;
    vec3 n = N * cos(ang) + B * sin(ang);
    float seed = aStrand2.y;
    float lump = 1.0 + 0.14 * snoise(vec3(along * 1.6, cos(ang) * 0.8, sin(ang) * 0.8) + seed * 7.0);
    float rs = c.w * aStrand.z * taper * lump * (1.0 - 0.3 * st.y);

    P = centre + n * rs;
    Nrm = n;
    vRootUp = n.y;
    vRoot = vec4(along, ang, (g - u) * L, aStrand2.z);
    vRoot2 = vec4(seed + aStrand.y * 3.0, step(g, 0.999), st.y, st.z);
  }
`;

const LEAF_DECL = /* glsl */ `
  ${CURVE_DECL}
  attribute vec4 aLeaf;    // curve, u, angle round, length m
  attribute vec4 aLeaf2;   // tilt, droop, seed, hue
  varying vec4 vLeaf;      // along, across, hue, wither

  void leafPlace(out vec3 P, out vec3 Nrm) {
    int ci = int(aLeaf.x + 0.5);
    vec4 st = uCurveState[ci];
    float L = max(st.w, 1e-3);
    float u0 = aLeaf.y;
    // Out once the growth is past it, and shed as the root withers.
    float show = smoothstep(u0, u0 + 0.6 / L, st.x);
    float shed = smoothstep(aLeaf2.z * 0.55, aLeaf2.z * 0.55 + 0.2, st.y);
    show *= 1.0 - shed;

    vec4 c; vec3 T; vec3 N; vec3 B;
    curveFrame(ci, u0, c, T, N, B);
    float ang = aLeaf.z * RTAU;
    vec3 n = N * cos(ang) + B * sin(ang);
    vec3 base = c.xyz + n * c.w * 0.8;
    vec3 D = normalize(mix(T, n, 0.3 + 0.6 * aLeaf2.x));
    vec3 S = normalize(cross(n, D));

    float along = position.x;
    float across = position.y;
    float len = aLeaf.w * uLeafSize * show;
    float width = len * 0.17 * pow(sin(3.14159265 * clamp(along * 0.92 + 0.04, 0.0, 1.0)), 0.75);
    vec3 p = base + D * along * len + S * across * width;
    p += n * abs(across) * width * 0.45;                      // folded down the midrib
    p.y -= aLeaf2.y * along * along * len;                     // its own weight
    float flutter = sin(uTime * 3.1 + aLeaf2.z * 21.0 + along * 2.4) * 0.5 + sin(uTime * 7.3 + aLeaf2.z * 9.0) * 0.25;
    p += n * flutter * 0.05 * along * len;
    P = p;
    Nrm = normalize(cross(D, S) + n * 0.4);
    vLeaf = vec4(along, across, aLeaf2.w, shed + st.y * 0.6);
  }
`;

/** A rune: a stave and a few strokes between points of a 3×3 lattice. */
const RUNE_GLSL = /* glsl */ `
  float segD(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-5), 0.0, 1.0);
    return length(pa - ba * h);
  }
  float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  vec2 runePt(float h) { return vec2(floor(h * 3.0), floor(fract(h * 7.0) * 3.0)) - 1.0; }
  /** Distance to the strokes of rune \`id\`, p in −1..1. */
  float rune(vec2 p, float id) {
    float d = 1e3;
    if (h21(vec2(id, 3.7)) < 0.6) d = segD(p, vec2(0.0, -0.85), vec2(0.0, 0.85));
    for (int k = 0; k < 4; k++) {
      if (k > 1 && h21(vec2(id, 91.0 + float(k))) < 0.45) continue;
      vec2 a = runePt(h21(vec2(id, float(k) * 7.31)));
      vec2 b = runePt(h21(vec2(id * 1.7 + 3.1, float(k) * 3.17)));
      if (a == b) b = vec2(-a.y, a.x) + vec2(0.0, 1.0) * step(dot(a, a), 0.0);
      d = min(d, segD(p, a * 0.75, b * 0.75));
    }
    return d;
  }
`;

/** three's `perturbNormalArb`, off a height we compute rather than a map. */
const BUMP_GLSL = /* glsl */ `
  vec3 bumpNormal(vec3 surfPos, vec3 surfNorm, float h, float scale) {
    vec3 dpx = dFdx(surfPos);
    vec3 dpy = dFdy(surfPos);
    float dhx = dFdx(h) * scale;
    float dhy = dFdy(h) * scale;
    vec3 r1 = cross(dpy, surfNorm);
    vec3 r2 = cross(surfNorm, dpx);
    float det = dot(dpx, r1);
    vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
    return normalize(abs(det) * surfNorm - grad);
  }
`;

/* ---------------------------------------------------------------------- */
/* The bark                                                                 */
/* ---------------------------------------------------------------------- */

/**
 * @param {import('../assets/RootGeometry.js').CurveBank} bank
 */
export function createBarkMaterial(bank) {
  const material = new MeshStandardMaterial({
    name: 'ReliquaryBark',
    color: 0xffffff,
    metalness: 0,
    roughness: 0.85
  });

  const uniforms = {
    uCurves: { value: bank.texture },
    uCurveState: { value: bank.state },
    uCurveLook: { value: bank.look },
    uTime: frame.uTime,
    uGlobalGlow: frame.uGlobalGlow,
    uTaper: { value: 0.5 },
    uBarkDark: { value: new Color() },
    uBarkLight: { value: new Color() },
    uMoss: { value: new Color() },
    uLichen: { value: new Color() },
    uVine: { value: new Color() },
    uVein: { value: new Color() },
    uTip: { value: new Color() },
    uDry: { value: new Color() },
    uMossAmount: { value: 0.5 },
    uLichenAmount: { value: 0.5 },
    uBump: { value: 1 },
    uVeinGlow: { value: 1 },
    uSapSpeed: { value: 1 },
    uTipGlow: { value: 4 },
    uRim: { value: 0.4 }
  };
  material.userData.uniforms = uniforms;

  patchOnBeforeCompile(
    material,
    (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${noiseGLSL}\n${ROOT_DECL}`)
        .replace('#include <beginnormal_vertex>', `vec3 rootP; vec3 objectNormal; rootPlace(rootP, objectNormal);`)
        .replace('#include <begin_vertex>', `vec3 transformed = rootP;`);
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           uniform float uGlobalGlow;
           uniform float uTime;
           uniform vec3 uBarkDark, uBarkLight, uMoss, uLichen, uVine, uVein, uTip, uDry;
           uniform float uMossAmount, uLichenAmount, uBump, uVeinGlow, uSapSpeed, uTipGlow, uRim;
           varying vec4 vRoot;
           varying vec4 vRoot2;
           varying float vRootUp;
           ${noiseGLSL}
           ${BUMP_GLSL}
           float barkH;
           float barkCrev;
           float barkMoss;
           float barkLichen;`
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
           {
             float along = vRoot.x;
             vec2 ca = vec2(cos(vRoot.y), sin(vRoot.y));
             float seed = vRoot2.x;
             float vine = step(0.5, vRoot.w);
             // Plates: noise stretched along the length, so the bark runs in
             // broad plates up the root, split by one family of long fissures
             // where it crosses zero. A finer octave only roughens them.
             float f1 = snoise(vec3(along * 0.75, ca * 1.7) + seed);
             float f2 = snoise(vec3(along * 2.6, ca * 4.2) + seed * 1.7);
             float f3 = snoise(vec3(along * 7.0, ca * 9.0) + seed * 2.3);
             float plate = abs(f1 + f2 * 0.14);
             barkCrev = 1.0 - smoothstep(0.015, 0.075, plate);
             barkH = smoothstep(0.0, 0.3, plate) * (0.85 + 0.15 * f2) + f3 * 0.04;
             barkH = mix(barkH, f2 * 0.2 + 0.5, vine * 0.7);

             float grain = f2 * 0.5 + 0.5;
             float tone = snoise(vec3(along * 0.25, ca * 0.6) + seed * 3.0) * 0.5 + 0.5;
             vec3 bark = mix(uBarkDark, uBarkLight, smoothstep(0.1, 0.9, tone * 0.55 + grain * 0.3 + barkH * 0.25));
             bark *= 1.0 - barkCrev * 0.7;

             // Moss where it faces the sky, lichen in teal blooms.
             float m = snoise(vec3(along * 0.55, ca * 0.9) + seed * 4.0) * 0.5 + 0.5;
             barkMoss = smoothstep(0.55, 0.85, m + vRootUp * 0.25) * uMossAmount;
             float l = snoise(vec3(along * 0.8, ca * 1.4) + seed * 9.0 + 20.0) * 0.5 + 0.5;
             barkLichen = smoothstep(0.58, 0.82, l) * uLichenAmount;
             bark = mix(bark, uMoss * (0.7 + 0.5 * grain), barkMoss);
             bark = mix(bark, uLichen * (0.75 + 0.4 * grain), barkLichen * (1.0 - barkMoss * 0.5));
             bark = mix(bark, uVine * (0.75 + 0.5 * grain), vine);
             // Dry and grey as it withers.
             bark = mix(bark, uDry * (0.6 + 0.6 * grain), vRoot2.z * 0.85);
             diffuseColor.rgb = bark;
           }`
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
           roughnessFactor = mix(0.95, 0.75, barkLichen * 0.6 + barkMoss * 0.2);`
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
           normal = bumpNormal(-vViewPosition, normal, barkH, 0.05 * uBump);`
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
           {
             float along = vRoot.x;
             float alive = 1.0 - vRoot2.z;
             // Sap: pulses of light climbing from the floor, in the crevices.
             float ph = fract(along * 0.32 - uTime * 0.55 * uSapSpeed + vRoot2.x * 0.37);
             float pulse = exp(-pow((ph - 0.5) * 7.0, 2.0));
             float sap = vRoot2.w;
             float vein = barkCrev * (0.12 + sap * (0.35 + 1.6 * pulse)) * uVeinGlow;
             // The tip, white hot while it is still pushing out of the floor.
             float tip = exp(-max(0.0, vRoot.z) * 5.0) * vRoot2.y * step(-0.01, vRoot.z);
             vec3 V = normalize(vViewPosition);
             float rim = pow(1.0 - abs(dot(normal, V)), 3.0) * uRim * (0.3 + sap);
             vec3 glow = uVein * (vein + rim + barkLichen * 0.06) + uTip * tip * uTipGlow;
             totalEmissiveRadiance += glow * alive * uGlobalGlow;
           }`
        );
    },
    'reliquary-bark'
  );

  /* ---- the same silhouette, for the sun ---- */
  const depth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
  patchOnBeforeCompile(
    depth,
    (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${noiseGLSL}\n${ROOT_DECL}`)
        .replace('#include <begin_vertex>', `vec3 rootP; vec3 rootN; rootPlace(rootP, rootN); vec3 transformed = rootP;`);
    },
    'reliquary-bark-depth'
  );
  material.userData.depth = depth;

  material.userData.sync = () => {
    const c = settings.reliquary;
    uniforms.uBarkDark.value.copy(getColor(c.colorBarkDark));
    uniforms.uBarkLight.value.copy(getColor(c.colorBark));
    uniforms.uMoss.value.copy(getColor(c.colorMoss));
    uniforms.uLichen.value.copy(getColor(c.colorLichen));
    uniforms.uVine.value.copy(getColor(c.colorVine));
    uniforms.uVein.value.copy(getColor(c.colorVein));
    uniforms.uTip.value.copy(getColor(c.colorTip));
    uniforms.uDry.value.copy(getColor(c.colorDry));
    uniforms.uMossAmount.value = c.moss;
    uniforms.uLichenAmount.value = c.lichen;
    uniforms.uBump.value = c.barkBump;
    uniforms.uVeinGlow.value = c.veinGlow;
    uniforms.uSapSpeed.value = c.sapSpeed;
    uniforms.uTipGlow.value = c.tipGlow;
    uniforms.uRim.value = c.barkRim;
    uniforms.uTaper.value = c.taper;
    material.envMapIntensity = c.barkEnv;
  };
  return material;
}

/* ---------------------------------------------------------------------- */
/* The leaves                                                               */
/* ---------------------------------------------------------------------- */

export function createLeafMaterial(bank) {
  const material = new MeshStandardMaterial({
    name: 'ReliquaryLeaf',
    color: 0xffffff,
    metalness: 0,
    roughness: 0.55,
    side: DoubleSide
  });

  const uniforms = {
    uCurves: { value: bank.texture },
    uCurveState: { value: bank.state },
    uCurveLook: { value: bank.look },
    uTime: frame.uTime,
    uGlobalGlow: frame.uGlobalGlow,
    uLightDir: frame.uLightDir,
    uTaper: { value: 0.5 },
    uLeafSize: { value: 0.4 },
    uLeafDark: { value: new Color() },
    uLeafLight: { value: new Color() },
    uLeafEdge: { value: new Color() },
    uDry: { value: new Color() },
    uTranslucency: { value: 1 }
  };
  material.userData.uniforms = uniforms;

  patchOnBeforeCompile(
    material,
    (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${LEAF_DECL}`)
        .replace('#include <beginnormal_vertex>', `vec3 leafP; vec3 objectNormal; leafPlace(leafP, objectNormal);`)
        .replace('#include <begin_vertex>', `vec3 transformed = leafP;`);
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           uniform float uGlobalGlow;
           uniform vec3 uLightDir;
           uniform vec3 uLeafDark, uLeafLight, uLeafEdge, uDry;
           uniform float uTranslucency;
           varying vec4 vLeaf;`
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
           {
             float along = vLeaf.x;
             float across = vLeaf.y;
             float rib = 1.0 - smoothstep(0.0, 0.12, abs(across));
             float side = 1.0 - smoothstep(0.0, 0.1, abs(fract(along * 7.0 - abs(across) * 1.6) - 0.5) - 0.38);
             vec3 leaf = mix(uLeafDark, uLeafLight, clamp(along * 0.7 + vLeaf.z * 0.5 + abs(across) * 0.2, 0.0, 1.0));
             leaf = mix(leaf, uLeafLight * 1.3, rib * 0.5 + side * 0.12);
             leaf = mix(leaf, uDry, clamp(vLeaf.w, 0.0, 1.0));
             diffuseColor.rgb = leaf;
           }`
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
           {
             // Light through the blade from behind, and a cold edge at the tip.
             vec3 V = normalize(vViewPosition);
             vec3 L = normalize((viewMatrix * vec4(uLightDir, 0.0)).xyz);
             float through = pow(clamp(dot(-V, L) * 0.5 + 0.5, 0.0, 1.0), 3.0);
             float back = gl_FrontFacing ? 0.4 : 1.0;
             float edge = smoothstep(0.75, 1.0, vLeaf.x) * 0.6 + smoothstep(0.6, 1.0, abs(vLeaf.y)) * 0.25;
             vec3 glow = uLeafLight * through * back * 0.35 * uTranslucency + uLeafEdge * edge * 0.35;
             totalEmissiveRadiance += glow * (1.0 - clamp(vLeaf.w, 0.0, 1.0)) * uGlobalGlow;
           }`
        );
    },
    'reliquary-leaf'
  );

  const depth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking, side: DoubleSide });
  patchOnBeforeCompile(
    depth,
    (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${LEAF_DECL}`)
        .replace('#include <begin_vertex>', `vec3 leafP; vec3 leafN; leafPlace(leafP, leafN); vec3 transformed = leafP;`);
    },
    'reliquary-leaf-depth'
  );
  material.userData.depth = depth;

  material.userData.sync = () => {
    const c = settings.reliquary;
    uniforms.uLeafDark.value.copy(getColor(c.colorLeafDark));
    uniforms.uLeafLight.value.copy(getColor(c.colorLeaf));
    uniforms.uLeafEdge.value.copy(getColor(c.colorVein));
    uniforms.uDry.value.copy(getColor(c.colorDry));
    uniforms.uTranslucency.value = c.leafTranslucency;
    uniforms.uLeafSize.value = c.leafSize;
    uniforms.uTaper.value = c.taper;
  };
  return material;
}

/* ---------------------------------------------------------------------- */
/* The stone                                                                */
/* ---------------------------------------------------------------------- */

/**
 * @param {object} options
 * @param {boolean} options.cube a rune cube rather than a ring slab
 */
export function createStoneMaterial({ cube = false } = {}) {
  const material = new MeshStandardMaterial({
    name: cube ? 'ReliquaryCube' : 'ReliquarySlab',
    color: 0xffffff,
    metalness: 0,
    roughness: 0.8
  });

  const uniforms = {
    uTime: frame.uTime,
    uGlobalGlow: frame.uGlobalGlow,
    uStoneDark: { value: new Color() },
    uStone: { value: new Color() },
    uPatina: { value: new Color() },
    uGlyph: { value: new Color() },
    uGlyphHot: { value: new Color() },
    uLattice: { value: new Color() },
    uSeed: { value: 0 },
    uArc: { value: 0.9 },
    uIgnite: { value: 0 },
    uCharge: { value: 0 },
    uFlash: { value: 0 },
    uDim: { value: 0 },
    uPatinaAmount: { value: 0.5 },
    uGlyphGlow: { value: 1 },
    uCarve: { value: 1 },
    uRim: { value: 0.4 }
  };
  material.userData.uniforms = uniforms;

  patchOnBeforeCompile(
    material,
    (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           attribute vec3 aStone;
           varying vec3 vStone;
           varying vec3 vObj;
           varying vec3 vObjN;`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           vStone = aStone;
           vObj = position;
           vObjN = normal;`
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           #define IS_CUBE ${cube ? 1 : 0}
           uniform float uGlobalGlow;
           uniform float uTime;
           uniform vec3 uStoneDark, uStone, uPatina, uGlyph, uGlyphHot, uLattice;
           uniform float uSeed, uArc, uIgnite, uCharge, uFlash, uDim, uPatinaAmount, uGlyphGlow, uCarve, uRim;
           varying vec3 vStone;
           varying vec3 vObj;
           varying vec3 vObjN;
           ${noiseGLSL}
           ${RUNE_GLSL}
           ${BUMP_GLSL}
           float stH;
           float stGroove;
           float stGlyph;
           float stLit;
           float stPatina;`
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
           {
             vec3 sp = vObj * 3.0 + uSeed * 11.3;
             float mottle = snoise(sp * 1.3) * 0.5 + 0.5;
             float fine = snoise(sp * 7.0) * 0.5 + 0.5;
             vec3 stone = mix(uStoneDark, uStone, smoothstep(0.2, 0.85, mottle * 0.7 + fine * 0.3));
             stPatina = smoothstep(0.5, 0.78, snoise(sp * 0.7 + 30.0) * 0.5 + 0.5 + fine * 0.15) * uPatinaAmount;
             stone = mix(stone, uPatina * (0.7 + 0.5 * fine), stPatina);
             float panel = smoothstep(0.5, 0.9, vStone.x);
             stH = fine * 0.25 + mottle * 0.15;
             stGroove = 0.0;
             stGlyph = 1e3;
             stLit = 0.0;

           #if IS_CUBE
             // Which face: the axis the object normal leans furthest along.
             vec3 an = abs(vObjN);
             vec2 q = an.x > an.y && an.x > an.z ? vObj.yz : (an.y > an.z ? vObj.xz : vObj.xy);
             q /= 0.37;
             float face = floor(vStone.y * 5.0 + 0.5);
             float ring = abs(length(q) - 0.82);
             stGlyph = min(rune(q * 1.45, uSeed * 7.0 + face), ring * 1.4);
             stGroove = (1.0 - smoothstep(0.05, 0.11, stGlyph)) * panel;
             stLit = 1.0;
           #else
             // Along the arc and across it, in metres.
             float arcLen = uArc * 0.87;
             vec2 q = vec2(vStone.y * arcLen, (vStone.z - 0.5) * 0.26);
             // A woven lattice: two families of diagonal bands, over and under.
             vec2 g = q / 0.085;
             float d1 = abs(fract(g.x + g.y * 1.6) - 0.5);
             float d2 = abs(fract(g.x - g.y * 1.6) - 0.5);
             float parity = mod(floor(g.x + g.y * 1.6) + floor(g.x - g.y * 1.6), 2.0);
             float b1 = smoothstep(0.30, 0.22, d1);
             float b2 = smoothstep(0.30, 0.22, d2);
             float over = parity > 0.5 ? b1 : b2;
             float under = parity > 0.5 ? b2 : b1;
             float weave = max(over, under * (1.0 - over));
             float edge = smoothstep(0.03, 0.0, abs(d1 - 0.26));
             float edge2 = smoothstep(0.03, 0.0, abs(d2 - 0.26));
             stGroove = max(1.0 - weave, max(edge, edge2) * 0.7);

             // A row of medallions down the middle, a rune in each.
             float n = max(1.0, floor(arcLen / 0.15));
             float cell = clamp(floor(vStone.y * n), 0.0, n - 1.0);
             float cu = (cell + 0.5) / n;
             vec2 c = vec2(cu * arcLen, 0.0);
             vec2 m = (q - c) / 0.05;
             float disc = length(m);
             float medallion = 1.0 - smoothstep(0.95, 1.05, disc);
             stGroove = mix(stGroove, 0.0, medallion);
             stGroove = max(stGroove, smoothstep(0.08, 0.0, abs(disc - 1.0)));
             stGlyph = mix(1e3, rune(m * 1.25, uSeed * 13.0 + cell), medallion);
             // Lit one after another, round the arc.
             stLit = smoothstep(cu - 0.02, cu + 0.04, uIgnite);
             stGroove *= panel;
           #endif
             stH -= stGroove * 0.5 * uCarve;
             stone *= 1.0 - stGroove * 0.55 * uCarve;
             float glyphLine = 1.0 - smoothstep(0.06, 0.14, stGlyph);
             stone = mix(stone, uLattice * 0.6, glyphLine * panel * 0.5);
             stone *= 1.0 - uDim * 0.5;
             diffuseColor.rgb = stone;
           }`
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
           roughnessFactor = mix(0.82, 0.45, stPatina * 0.6);`
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
           normal = bumpNormal(-vViewPosition, normal, stH, 0.02);`
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
           {
             float panel = smoothstep(0.5, 0.9, vStone.x);
             float glyphLine = 1.0 - smoothstep(0.05, 0.12, stGlyph);
             float glyphHalo = exp(-max(0.0, stGlyph - 0.05) * 9.0);
             float flick = 0.88 + 0.12 * sin(uTime * 13.0 + uSeed * 7.0 + vStone.y * 20.0);
             float lit = stLit * uIgnite > 0.0 ? stLit : 0.0;
             float dimGlyph = 0.25 + 0.75 * lit;
             vec3 V = normalize(vViewPosition);
             float rim = pow(1.0 - abs(dot(normal, V)), 3.0) * uRim;
             vec3 glow = mix(uGlyph, uGlyphHot, lit) * glyphLine * dimGlyph * (1.0 + uCharge * 1.5) * flick
                       + uGlyphHot * glyphHalo * lit * 0.35
                       + uLattice * stGroove * (0.04 + uCharge * 0.5 * lit)
                       + uPatina * rim * (0.4 + uCharge)
                       + vec3(1.0) * uFlash;
             totalEmissiveRadiance += glow * panel * uGlyphGlow * (1.0 - uDim) * uGlobalGlow
                                    + (uPatina * rim * 0.4 + vec3(1.0) * uFlash * 0.6) * (1.0 - panel) * (1.0 - uDim) * uGlobalGlow;
           }`
        );
    },
    cube ? 'reliquary-cube' : 'reliquary-slab'
  );

  material.userData.sync = () => {
    const c = settings.reliquary;
    uniforms.uStoneDark.value.copy(getColor(c.colorStoneDark));
    uniforms.uStone.value.copy(getColor(c.colorStone));
    uniforms.uPatina.value.copy(getColor(c.colorPatina));
    uniforms.uGlyph.value.copy(getColor(c.colorGlyph));
    uniforms.uGlyphHot.value.copy(getColor(c.colorGlyphHot));
    uniforms.uLattice.value.copy(getColor(c.colorVein));
    uniforms.uPatinaAmount.value = c.patina;
    uniforms.uGlyphGlow.value = c.glyphGlow;
    uniforms.uCarve.value = c.carveDepth;
    uniforms.uRim.value = c.stoneRim;
    material.envMapIntensity = c.stoneEnv;
  };
  return material;
}

/* ---------------------------------------------------------------------- */
/* The sigil on the floor                                                   */
/* ---------------------------------------------------------------------- */

const QUAD_VERTEX = /* glsl */ `
  uniform float uQuadSize;
  varying vec2 vP;
  void main() {
    vP = (uv - 0.5) * uQuadSize;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SIGIL_FRAGMENT = /* glsl */ `
  #define TAU 6.283185307179586
  #define PI 3.141592653589793
  uniform float uTime;
  uniform float uGlobalGlow;
  uniform float uRadius;
  uniform float uDraw;
  uniform float uVeins;
  uniform float uSide;      // the bearing of the arch's feet, radians
  uniform float uSpan;      // how far out they stand, metres
  uniform float uIgnite;
  uniform float uPulse;
  uniform float uFlare;
  uniform float uFade;
  uniform float uSpin;
  uniform float uIntensity;
  uniform vec4 uSprouts;    // the binding tendrils' sprouts: bearings, packed as 4 angles
  uniform float uSproutR;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform vec3 uColorC;
  varying vec2 vP;
  ${noiseGLSL}
  ${RUNE_GLSL}

  float band(float d, float w) { return 1.0 - smoothstep(w, w + 0.025, abs(d)); }
  float angDiff(float a, float b) { return abs(mod(a - b + PI, TAU) - PI); }

  /** A root vein torn out along bearing \`dir\`, out to \`reach\` metres. */
  float vein(vec2 p, float dir, float reach, float seed) {
    vec2 d = vec2(cos(dir), sin(dir));
    vec2 s = vec2(-d.y, d.x);
    float along = dot(p, d);
    float across = dot(p, s);
    if (along < 0.0 || along > reach) return 0.0;
    float wob = snoise(vec3(along * 1.3, seed, 0.0)) * 0.22 + snoise(vec3(along * 4.0, seed, 3.0)) * 0.06;
    float w = mix(0.07, 0.012, along / reach);
    float main = 1.0 - smoothstep(w, w + 0.02, abs(across - wob * along * 0.5));
    // A few side roots.
    float side = 0.0;
    for (int k = 0; k < 3; k++) {
      float at = reach * (0.3 + 0.2 * float(k));
      float sg = (mod(float(k), 2.0) * 2.0 - 1.0);
      float t = along - at;
      if (t > 0.0 && t < reach * 0.35) {
        float off = sg * t * 0.6 + snoise(vec3(t * 3.0, seed + float(k), 9.0)) * 0.05;
        float ww = mix(0.03, 0.006, t / (reach * 0.35));
        side = max(side, 1.0 - smoothstep(ww, ww + 0.015, abs(across - wob * along * 0.5 - off)));
      }
    }
    return max(main, side * 0.8);
  }

  void main() {
    float R = max(0.5, uRadius);
    float r = length(vP);
    float a = atan(vP.y, vP.x);
    float t = uTime;
    float reachMax = max(R, uSpan) + 0.6;
    if (r > reachMax + 0.3) discard;

    // It writes itself both ways round from the bearing of the arch.
    float fromFoot = angDiff(a, uSide) / PI;
    float drawn = 1.0 - smoothstep(uDraw - 0.02, uDraw, fromFoot);
    float writing = exp(-abs(fromFoot - uDraw) * 60.0) * step(uDraw, 0.999) * step(0.001, uDraw);

    /* ---- the rims ---- */
    float rims = band(r - R, 0.018) + band(r - (R - 0.07), 0.008) * 0.7
               + band(r - (R - 0.5), 0.012) + band(r - (R - 0.56), 0.006) * 0.6;

    /* ---- the braid between them: two strands, over and under ---- */
    float bw = 0.19;
    float bc = R - 0.285;
    float y = (r - bc) / bw;
    float k = 7.0 / max(bc, 0.5);
    float aa = a + t * uSpin * 0.05;
    float xs = aa * bc;
    float y1 = 0.72 * sin(xs * k);
    float y2 = -0.72 * sin(xs * k);
    float crossing = mod(floor(xs * k / PI), 2.0);
    float s1 = band((y - y1) * bw, 0.022);
    float s2 = band((y - y2) * bw, 0.022);
    float e1 = band(abs((y - y1) * bw) - 0.034, 0.004);
    float e2 = band(abs((y - y2) * bw) - 0.034, 0.004);
    float nearCross = 1.0 - smoothstep(0.08, 0.2, abs(y1 - y2) * bw);
    float top = crossing > 0.5 ? s1 + e1 : s2 + e2;
    float bottom = crossing > 0.5 ? s2 + e2 : s1 + e1;
    float braid = (top + bottom * (1.0 - nearCross)) * step(abs(r - bc), bw);

    /* ---- the ring of runes ---- */
    float rr0 = R - 0.85;
    float cells = floor(TAU * rr0 / 0.32);
    float ra = fract((a + t * uSpin * -0.03) / TAU) * cells;
    float cell = floor(ra);
    vec2 rq = vec2((fract(ra) - 0.5) * TAU * rr0 / cells, r - rr0) / 0.11;
    float runeD = rune(rq, cell + 17.0);
    float runeL = (1.0 - smoothstep(0.06, 0.14, runeD)) * step(abs(r - rr0), 0.13);
    float lit = smoothstep(cell / cells - 0.02, cell / cells + 0.03, uIgnite);
    float runeRim = band(r - (rr0 + 0.17), 0.006) + band(r - (rr0 - 0.17), 0.006);

    /* ---- a whorl of leaves round the body ---- */
    float petals = 0.0;
    for (int i = 0; i < 6; i++) {
      float pa = float(i) / 6.0 * TAU;
      vec2 pd = vec2(cos(pa + t * uSpin * 0.2), sin(pa + t * uSpin * 0.2));
      vec2 ps = vec2(-pd.y, pd.x);
      vec2 lp = vec2(dot(vP, pd), dot(vP, ps));
      // a vesica: two arcs from r 0.25 to 0.75
      float u = (lp.x - 0.25) / 0.5;
      if (u > 0.0 && u < 1.0) {
        float w = sin(u * PI) * 0.12;
        petals = max(petals, band(abs(lp.y) - w, 0.006) + band(lp.y, 0.004) * 0.6);
      }
    }
    float inner = band(r - 0.85, 0.01) + band(r - 0.22, 0.008);

    /* ---- the root veins out to the feet of the arch, and to the sprouts ---- */
    float veins = vein(vP, uSide, uSpan * uVeins, 1.3) + vein(vP, uSide + PI, uSpan * uVeins, 4.7);
    float sprouts = 0.0;
    for (int i = 0; i < 4; i++) {
      sprouts += vein(vP, uSprouts[i], uSproutR * uVeins * 1.05, 9.0 + float(i) * 2.3) * 0.6;
    }
    veins = clamp(veins + sprouts, 0.0, 1.0);
    float veinPulse = 0.6 + 0.4 * sin(r * 6.0 - t * 5.0);

    /* ---- the wash and the pulse ---- */
    float inside = 1.0 - smoothstep(R - 0.05, R, r);
    float wash = pow(clamp(r / R, 0.0, 1.0), 4.0) * inside * 0.14 + exp(-r * r * 1.4) * 0.12 * (0.5 + uIgnite);
    float pr = uPulse * (R + 1.0);
    float pulse = exp(-abs(r - pr) * 6.0) * (1.0 - uPulse) * step(0.001, uPulse);

    float grow = smoothstep(0.0, 0.3, uDraw);
    float lines = (rims + braid * 0.85 + runeRim * 0.5 + inner * 0.6) * drawn * grow;
    float glow = 0.75 + uFlare * 1.6 + uIgnite * 0.5;
    vec3 col = uColorA * lines * glow
             + uColorB * runeL * drawn * (0.25 + 1.5 * lit) * (1.0 + uFlare)
             + uColorC * (petals * grow * 0.7 + veins * veinPulse * 1.4 + wash * drawn)
             + uColorB * (pulse * 2.0 + writing * 2.5 * step(abs(r - R + 0.28), 0.4));
    gl_FragColor = vec4(col * uIntensity * uFade * uGlobalGlow, 1.0);
  }
`;

export function createSigilMaterial() {
  const material = new ShaderMaterial({
    uniforms: sharedUniforms({
      uQuadSize: { value: 10 },
      uRadius: { value: 3 },
      uDraw: { value: 0 },
      uVeins: { value: 0 },
      uSide: { value: 0 },
      uSpan: { value: 3 },
      uIgnite: { value: 0 },
      uPulse: { value: 0 },
      uFlare: { value: 0 },
      uFade: { value: 1 },
      uSpin: { value: 0.4 },
      uIntensity: { value: 1 },
      uSprouts: { value: new Vector4() },
      uSproutR: { value: 1.2 },
      uColorA: { value: new Color() },
      uColorB: { value: new Color() },
      uColorC: { value: new Color() }
    }),
    vertexShader: QUAD_VERTEX,
    fragmentShader: SIGIL_FRAGMENT,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    ...ADDITIVE
  });

  material.userData.sync = (s) => {
    const c = settings.reliquary;
    const u = material.uniforms;
    u.uQuadSize.value = s.quad;
    u.uRadius.value = s.radius;
    u.uDraw.value = s.draw;
    u.uVeins.value = s.veins;
    u.uSide.value = s.side;
    u.uSpan.value = s.span;
    u.uIgnite.value = s.ignite;
    u.uPulse.value = s.pulse;
    u.uFlare.value = s.flare;
    u.uFade.value = s.fade;
    u.uSpin.value = c.sigilSpin;
    u.uIntensity.value = c.sigilIntensity;
    u.uSprouts.value.copy(s.sprouts);
    u.uSproutR.value = s.sproutR;
    u.uColorA.value.copy(getColor(c.colorSigil));
    u.uColorB.value.copy(getColor(c.colorGlyphHot));
    u.uColorC.value.copy(getColor(c.colorVein));
  };
  return material;
}

/* ---------------------------------------------------------------------- */
/* The aura in the ring of stones                                           */
/* ---------------------------------------------------------------------- */

const AURA_FRAGMENT = /* glsl */ `
  #define TAU 6.283185307179586
  uniform float uTime;
  uniform float uGlobalGlow;
  uniform float uRadius;
  uniform float uAmount;
  uniform float uFlare;
  uniform float uIntensity;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  varying vec2 vP;
  ${noiseGLSL}

  void main() {
    float R = max(0.2, uRadius);
    float r = length(vP) / R;
    if (r > 1.25) discard;
    float a = atan(vP.y, vP.x);
    // Shafts turning slowly about the middle, and a body of light behind it.
    float shafts = pow(snoise(vec3(cos(a) * 2.0, sin(a) * 2.0, uTime * 0.25)) * 0.5 + 0.5, 3.0);
    float shafts2 = pow(snoise(vec3(cos(a) * 5.0, sin(a) * 5.0, uTime * 0.4 + 7.0)) * 0.5 + 0.5, 4.0);
    float body = exp(-r * r * 3.2);
    float halo = exp(-pow((r - 0.86) * 7.0, 2.0)) * 0.5;
    float rays = (shafts * 0.7 + shafts2 * 0.5) * smoothstep(1.2, 0.15, r) * smoothstep(0.0, 0.25, r);
    float core = exp(-r * r * 40.0) * (0.4 + uFlare * 3.0);
    vec3 col = uColorA * (body * 0.55 + rays * 0.65 + halo) + uColorB * (core + body * uFlare * 0.6);
    gl_FragColor = vec4(col * uAmount * uIntensity * uGlobalGlow, 1.0);
  }
`;

export function createAuraMaterial() {
  const material = new ShaderMaterial({
    uniforms: sharedUniforms({
      uQuadSize: { value: 4 },
      uRadius: { value: 1.6 },
      uAmount: { value: 0 },
      uFlare: { value: 0 },
      uIntensity: { value: 1 },
      uColorA: { value: new Color() },
      uColorB: { value: new Color() }
    }),
    vertexShader: QUAD_VERTEX,
    fragmentShader: AURA_FRAGMENT,
    side: DoubleSide,
    ...ADDITIVE
  });
  material.userData.sync = (s) => {
    const c = settings.reliquary;
    const u = material.uniforms;
    u.uQuadSize.value = s.quad;
    u.uRadius.value = s.radius;
    u.uAmount.value = s.amount;
    u.uFlare.value = s.flare;
    u.uIntensity.value = c.auraIntensity;
    u.uColorA.value.copy(getColor(c.colorAura));
    u.uColorB.value.copy(getColor(c.colorGlyphHot));
  };
  return material;
}
