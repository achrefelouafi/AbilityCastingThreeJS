import {
  AdditiveBlending,
  BackSide,
  Color,
  DoubleSide,
  FrontSide,
  NormalBlending,
  ShaderMaterial,
  Vector4
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * Everything the Astral Fang draws that is not a particle.
 *
 * The ability is a wolf made of starlight: two rifts torn in the air, a
 * compass sigil burnt into the stone under the prey, and the wolf itself —
 * the Sketchfab model with its own textures read for *detail only*, drawn as
 * a hologram of its own topology.
 *
 *   - **the wolf**: a deep, see-through body lit from its edges, the model's
 *     own quads drawn over it as a lattice (`bary`, see `WolfRig`), bands of
 *     light streaming nose to tail, stars caught inside it, and a white-hot
 *     seam wherever a rift's plane cuts it — so it *materialises* through the
 *     rift rather than being clipped by it. One depth-only prepass in front
 *     of it, so only its nearest surface is seen and it reads as a solid
 *     animal of light rather than an x-ray;
 *   - **the halo**: the same skin pushed out along its normals and drawn from
 *     the back, so it glows round its silhouette — the bloom the pipeline
 *     does not have, put where it is wanted;
 *   - **the rift**: a vertical disc that tears open as a slit and irises out
 *     into a vortex of nebula and stars, with a hot rim spitting filaments and
 *     a gold rune ring that writes itself round it;
 *   - **the sigil**: a gold compass rose on the floor — rings, an eight-point
 *     star, an octagram, a band of runes — drawn on in a sweep, that pulses
 *     when it lifts the prey;
 *   - **the column**: the shaft of light the sigil throws the prey up on.
 *
 * Everything is in metres. Colours and strengths are read from
 * `settings.wolf` every frame through each material's `userData.sync`.
 */

/* ==================================================================== */
/* The wolf                                                              */
/* ==================================================================== */

const WOLF_VERTEX = /* glsl */ `
  #include <common>
  #include <skinning_pars_vertex>

  attribute vec3 bary;
  uniform float uInflate;   // metres along the normal, world space

  varying vec3 vWorld;
  varying vec3 vNormalW;
  varying vec3 vBary;
  varying vec3 vBind;
  varying vec2 vUv;

  void main() {
    vUv = uv;
    vBary = bary;
    vBind = position;

    #include <skinbase_vertex>
    #include <beginnormal_vertex>
    #include <skinnormal_vertex>
    #include <begin_vertex>
    #include <skinning_vertex>

    vec4 world = modelMatrix * vec4(transformed, 1.0);
    vec3 n = normalize(mat3(modelMatrix) * objectNormal);
    world.xyz += n * uInflate;
    vWorld = world.xyz;
    vNormalW = n;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

/** The cut every wolf material shares: two rift planes, a ragged burning edge. */
const WOLF_CLIP_GLSL = /* glsl */ `
  uniform vec4  uClipA;
  uniform vec4  uClipB;
  uniform float uTime;

  float wfPlane(vec4 pl) {
    return dot(pl.xyz, pl.xyz) < 0.5 ? 1e3 : dot(vWorld, pl.xyz) - pl.w;
  }

  /* Distance in front of the nearer rift, roughened so the cut tears. */
  float wfCut(out float grain) {
    grain = snoise(vec3(vWorld * 6.5 + vec3(0.0, uTime * 1.8, 0.0)));
    float d = min(wfPlane(uClipA), wfPlane(uClipB));
    return d + grain * 0.045;
  }
`;

const WOLF_FRAGMENT = /* glsl */ `
  uniform float uPart;        // 0 body, 1 teeth & claws, 2 eyes, 3 fur
  uniform sampler2D uMap;
  uniform float uHasMap;
  uniform vec3  uBindCentre;
  uniform vec3  uBindFwd;
  uniform float uBindScale;
  uniform float uSeed;

  uniform float uRim;
  uniform float uRimPower;
  uniform float uWire;
  uniform float uWireWidth;
  uniform float uFlow;
  uniform float uFlowSpeed;
  uniform float uFlowBands;
  uniform float uStars;
  uniform float uDetail;
  uniform float uFill;
  uniform float uScan;
  uniform float uSeam;
  uniform float uSeamWidth;
  uniform float uFlare;
  uniform float uOpacity;

  uniform vec3 uColorDeep;
  uniform vec3 uColorCore;
  uniform vec3 uColorRim;
  uniform vec3 uColorWire;
  uniform vec3 uColorStar;
  uniform vec3 uColorHot;
  uniform float uGlobalGlow;

  varying vec3 vWorld;
  varying vec3 vNormalW;
  varying vec3 vBary;
  varying vec3 vBind;
  varying vec2 vUv;

  ${noiseGLSL}
  ${WOLF_CLIP_GLSL}

  void main() {
    float grain;
    float cut = wfCut(grain);
    if (cut < 0.0) discard;
    float seam = 1.0 - smoothstep(0.0, uSeamWidth, cut);

    vec3 V = normalize(cameraPosition - vWorld);
    vec3 N = normalize(vNormalW);
    if (!gl_FrontFacing) N = -N;
    float ndv = clamp(abs(dot(N, V)), 0.0, 1.0);
    float fres = pow(1.0 - ndv, uRimPower);

    vec4 tex = uHasMap > 0.5 ? texture2D(uMap, vUv) : vec4(0.5, 0.5, 0.5, 1.0);
    float lum = dot(tex.rgb, vec3(0.299, 0.587, 0.114));

    // Where on the animal, in its rest pose: -0.5 the tail .. +0.5 the nose.
    vec3 o = (vBind - uBindCentre) * uBindScale;
    float along = dot(o, uBindFwd);

    // Light streaming back along the body, nose to tail, torn by noise.
    float bandPos = along * uFlowBands + uTime * uFlowSpeed + snoise(o * 5.0 + uSeed) * 0.22;
    float band = fract(bandPos);
    float flow = smoothstep(0.0, 0.06, band) * (1.0 - smoothstep(0.06, 0.42, band));
    flow *= flow;

    vec3 col;
    float alpha;

    if (uPart > 2.5) {
      /* ---- fur: strands of light, its card's alpha for the shape ---- */
      float a = tex.a * smoothstep(0.05, 0.6, lum + 0.3);
      float shimmer = 0.6 + 0.4 * sin(uTime * 7.0 + along * 40.0 + vUv.x * 30.0);
      col = mix(uColorRim, uColorHot, flow * 0.7) * (0.55 + 0.9 * flow + 0.4 * fres) * shimmer;
      alpha = a * (0.45 + 0.4 * flow) * uOpacity;
    } else if (uPart > 1.5) {
      /* ---- eyes: the hottest thing on it ---- */
      col = uColorHot * (1.6 + uFlare * 2.0);
      alpha = uOpacity;
    } else {
      /* ---- the lattice of its own quads ---- */
      float edge = min(min(vBary.x, vBary.y), vBary.z);
      float fe = max(fwidth(edge), 1e-5);
      float wire = 1.0 - smoothstep(fe * uWireWidth * 0.5, fe * (uWireWidth * 0.5 + 1.25), edge);

      // Stars caught in the body: one in a few cells of a rest-pose grid.
      vec3 sg = o * 46.0;
      vec3 cell = floor(sg);
      float h = hash13(cell + uSeed * 7.0);
      float star = step(0.955, h) * smoothstep(0.32, 0.0, length(fract(sg) - 0.5));
      star *= 0.55 + 0.45 * sin(uTime * (2.0 + h * 7.0) + h * 61.0);

      if (uPart > 0.5) {
        // Teeth and claws: ice, lit from inside.
        col = mix(uColorRim, uColorHot, 0.65 + 0.35 * fres) * (0.9 + wire * 0.6);
        alpha = (0.75 + 0.25 * fres) * uOpacity;
      } else {
        col = uColorDeep * uFill * (0.45 + lum * 1.2)
            + uColorCore * lum * uDetail * (0.35 + 0.65 * ndv)
            + uColorRim * fres * uRim
            + uColorWire * wire * uWire * (0.5 + 0.5 * fres + 1.6 * flow)
            + uColorRim * flow * uFlow * (0.25 + fres)
            + uColorStar * star * uStars;
        alpha = clamp(uFill * (0.22 + lum * 0.22) + fres * uRim * 0.55 + wire * uWire * 0.55 + flow * uFlow * 0.25 + star, 0.0, 1.0);
        alpha *= uOpacity;
      }
    }

    // A hologram's own interference, faint.
    float scan = 1.0 - uScan + uScan * (0.5 + 0.5 * sin(vWorld.y * 70.0 - uTime * 9.0));
    col *= scan;

    // Materialising through the rift, and the flash of the bite.
    col += uColorHot * seam * uSeam * (0.7 + 0.5 * grain);
    alpha = max(alpha, seam * uSeam * uOpacity);
    col += uColorHot * uFlare * (0.25 + fres) * 0.8;

    if (alpha < 0.003) discard;
    gl_FragColor = vec4(col * uGlobalGlow, clamp(alpha, 0.0, 1.0));
  }
`;

const DEPTH_FRAGMENT = /* glsl */ `
  varying vec3 vWorld;
  varying vec3 vNormalW;
  varying vec3 vBary;
  varying vec3 vBind;
  varying vec2 vUv;
  ${noiseGLSL}
  ${WOLF_CLIP_GLSL}
  void main() {
    float grain;
    if (wfCut(grain) < 0.0) discard;
    gl_FragColor = vec4(0.0);
  }
`;

const HALO_FRAGMENT = /* glsl */ `
  uniform float uHalo;
  uniform float uHaloPower;
  uniform float uFlare;
  uniform float uOpacity;
  uniform vec3  uColorRim;
  uniform vec3  uColorHot;
  uniform float uGlobalGlow;
  varying vec3 vWorld;
  varying vec3 vNormalW;
  varying vec3 vBary;
  varying vec3 vBind;
  varying vec2 vUv;
  ${noiseGLSL}
  ${WOLF_CLIP_GLSL}
  void main() {
    float grain;
    float cut = wfCut(grain);
    if (cut < 0.0) discard;
    vec3 V = normalize(cameraPosition - vWorld);
    // Drawn from the back: brightest just off the body, nothing at its own edge.
    float ndv = clamp(dot(-normalize(vNormalW), V), 0.0, 1.0);
    float glow = pow(ndv, uHaloPower) * uHalo * (1.0 + uFlare * 2.0);
    glow *= smoothstep(0.0, 0.25, cut);
    vec3 col = mix(uColorRim, uColorHot, uFlare * 0.6) * glow;
    gl_FragColor = vec4(col * uGlobalGlow * uOpacity, 1.0);
  }
`;

/**
 * The uniforms one wolf's materials share: where it is cut, how faded and
 * how lit it is right now. One per wolf (the echoes have their own), so
 * every part of an animal is cut by the same plane on the same frame.
 */
export function createWolfLook() {
  return {
    uClipA: { value: new Vector4() },
    uClipB: { value: new Vector4() },
    uFlare: { value: 0 },
    uOpacity: { value: 1 },
    uSeed: { value: Math.random() * 10 }
  };
}

function wolfUniforms(look, bind) {
  return sharedUniforms({
    ...look,
    uPart: { value: 0 },
    uMap: { value: null },
    uHasMap: { value: 0 },
    uBindCentre: { value: bind.centre.clone() },
    uBindFwd: { value: bind.fwd.clone() },
    uBindScale: { value: bind.scale },
    uInflate: { value: 0 },
    uRim: { value: 1.4 },
    uRimPower: { value: 2.2 },
    uWire: { value: 0.9 },
    uWireWidth: { value: 1.2 },
    uFlow: { value: 0.8 },
    uFlowSpeed: { value: 1.6 },
    uFlowBands: { value: 3.5 },
    uStars: { value: 1 },
    uDetail: { value: 0.6 },
    uFill: { value: 1 },
    uScan: { value: 0.15 },
    uSeam: { value: 2 },
    uSeamWidth: { value: 0.12 },
    uHalo: { value: 0.8 },
    uHaloPower: { value: 2 },
    uColorDeep: { value: new Color() },
    uColorCore: { value: new Color() },
    uColorRim: { value: new Color() },
    uColorWire: { value: new Color() },
    uColorStar: { value: new Color() },
    uColorHot: { value: new Color() }
  });
}

const PART_INDEX = { body: 0, teeth: 1, claws: 1, eyes: 2, fur: 3 };

/**
 * The visible surface of one part of one wolf.
 *
 * @param {object} look   `createWolfLook()`, shared by this wolf's parts
 * @param {object} bind   { centre, fwd, scale } the rest pose's frame
 * @param {string} part   body | fur | teeth | claws | eyes
 * @param {import('three').Texture|null} map the part's own colour map
 */
export function createWolfMaterial(look, bind, part, map = null) {
  const uniforms = wolfUniforms(look, bind);
  uniforms.uPart.value = PART_INDEX[part] ?? 0;
  uniforms.uMap.value = map;
  uniforms.uHasMap.value = map ? 1 : 0;
  const material = new ShaderMaterial({
    name: `wolf-${part}`,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: part === 'fur' ? AdditiveBlending : NormalBlending,
    side: part === 'fur' ? DoubleSide : FrontSide,
    toneMapped: false,
    uniforms,
    vertexShader: WOLF_VERTEX,
    fragmentShader: WOLF_FRAGMENT
  });
  material.userData.sync = () => syncWolf(uniforms);
  return material;
}

/** Depth only, cut the same way: the nearest surface of the wolf, and nothing behind it. */
export function createWolfDepthMaterial(look, bind) {
  const uniforms = wolfUniforms(look, bind);
  const material = new ShaderMaterial({
    name: 'wolf-depth',
    colorWrite: false,
    depthWrite: true,
    depthTest: true,
    uniforms,
    vertexShader: WOLF_VERTEX,
    fragmentShader: DEPTH_FRAGMENT
  });
  material.userData.sync = () => {};
  return material;
}

/** The glow round its silhouette: the skin pushed out and drawn from the back. */
export function createWolfHaloMaterial(look, bind) {
  const uniforms = wolfUniforms(look, bind);
  const material = new ShaderMaterial({
    name: 'wolf-halo',
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: BackSide,
    toneMapped: false,
    uniforms,
    vertexShader: WOLF_VERTEX,
    fragmentShader: HALO_FRAGMENT
  });
  material.userData.sync = (scale = 1) => {
    syncWolf(uniforms);
    const c = settings.wolf;
    uniforms.uInflate.value = c.haloWidth * scale;
  };
  return material;
}

function syncWolf(u) {
  const c = settings.wolf;
  const g = settings.global;
  u.uRim.value = c.rim * g.fresnel;
  u.uRimPower.value = c.rimPower;
  u.uWire.value = c.wire * g.shaderIntensity;
  u.uWireWidth.value = c.wireWidth;
  u.uFlow.value = c.flow * g.shaderIntensity;
  u.uFlowSpeed.value = c.flowSpeed * g.noiseSpeed;
  u.uFlowBands.value = c.flowBands;
  u.uStars.value = c.innerStars;
  u.uDetail.value = c.furDetail;
  u.uFill.value = c.fill;
  u.uScan.value = c.scanlines;
  u.uSeam.value = c.seam * g.glow;
  u.uSeamWidth.value = c.seamWidth;
  u.uHalo.value = c.halo * g.glow;
  u.uHaloPower.value = c.haloPower;
  u.uColorDeep.value.copy(getColor(c.colorDeep));
  u.uColorCore.value.copy(getColor(c.colorCore));
  u.uColorRim.value.copy(getColor(c.colorRim));
  u.uColorWire.value.copy(getColor(c.colorWire));
  u.uColorStar.value.copy(getColor(c.colorStar));
  u.uColorHot.value.copy(getColor(c.colorHot));
  u.uGlobalGlow.value = g.glow;
}

/* ==================================================================== */
/* The rift                                                              */
/* ==================================================================== */

const QUAD_VERTEX = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorld;
  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

/**
 * The aperture both the rift and its occluder are cut to: a slit of light
 * that widens into a disc. `p` in metres in the rift's plane, y up.
 * Returns the radius normalised so the edge is 1.
 */
const APERTURE_GLSL = /* glsl */ `
  vec2 riftAxes(float open) {
    float ax = mix(0.035, 1.0, smoothstep(0.05, 0.8, open));
    float ay = mix(0.5, 1.0, smoothstep(0.0, 0.45, open)) * clamp(open * 4.0, 0.0, 1.0);
    return vec2(ax, ay);
  }
`;

const RIFT_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uQuad;
  uniform float uRadius;
  uniform float uOpen;
  uniform float uSpin;
  uniform float uFlare;
  uniform float uRune;
  uniform float uRuneSpin;
  uniform float uFade;
  uniform float uSeed;
  uniform float uNebula;
  uniform float uRimGlow;
  uniform float uFilaments;
  uniform float uStarsIn;
  uniform vec3  uColorDeep;
  uniform vec3  uColorA;
  uniform vec3  uColorB;
  uniform vec3  uColorC;
  uniform vec3  uColorHot;
  uniform vec3  uColorRune;
  uniform float uGlobalGlow;
  varying vec2 vUv;

  ${noiseGLSL}
  ${commonGLSL}
  ${APERTURE_GLSL}

  #define RF_TAU 6.283185307179586

  void main() {
    vec2 p = (vUv - 0.5) * uQuad;
    vec2 axes = riftAxes(uOpen);
    vec2 q = p / max(vec2(uRadius) * axes, vec2(1e-3));
    float r = length(q);
    float ang = atan(q.y, q.x);

    // The lip boils.
    float wob = snoise(vec3(ang * 2.0, uTime * 1.3, uSeed)) * 0.05
              + snoise(vec3(ang * 7.0, uTime * 3.1, uSeed + 3.0)) * 0.025;
    float re = r + wob;
    float inside = 1.0 - smoothstep(0.95, 1.0, re);

    /* ---- the far side: a nebula turning, harder toward the middle ---- */
    float twist = uSpin + 1.8 / (0.22 + r);
    vec2 sp = rot2(twist * 0.55) * q;
    float neb = fbm3(vec3(sp * 1.5, uTime * 0.12 + uSeed));
    float neb2 = fbm3(vec3(sp * 3.1 + 4.0, -uTime * 0.18 + uSeed));
    float arms = 0.5 + 0.5 * sin(ang * 3.0 + log(r + 0.05) * 5.5 - uSpin * 2.0 + neb * 3.0);
    vec3 c = uColorDeep;
    c = mix(c, uColorB, smoothstep(0.15, 0.85, neb) * 0.75 * uNebula);
    c = mix(c, uColorA, smoothstep(0.5, 1.0, neb2) * arms * 0.9 * uNebula);
    c += uColorC * pow(arms, 5.0) * smoothstep(0.25, 0.9, r) * 0.55 * uNebula;
    // The eye of it, and how it flares when something comes through.
    c += uColorHot * exp(-r * r * 9.0) * (0.9 + uFlare * 3.0);
    c += uColorA * exp(-r * r * 2.5) * 0.35;

    vec2 sq = rot2(uSpin * 0.4) * q * 13.0;
    vec2 cell = floor(sq);
    float h = hash13(vec3(cell, uSeed));
    float star = step(0.88, h) * smoothstep(0.2, 0.0, length(fract(sq) - 0.5));
    star *= 0.55 + 0.45 * sin(uTime * 5.0 + h * 30.0);
    c += vec3(1.0) * star * uStarsIn;
    // Depth: the wall of the tunnel darkens before the rim takes over.
    c *= mix(1.0, 0.5, smoothstep(0.55, 0.96, r));

    /* ---- the rim, its filaments, the air round it ---- */
    float rim = exp(-pow((re - 1.0) * 20.0, 2.0));
    float rimCore = exp(-pow((re - 1.0) * 55.0, 2.0));
    float outside = step(1.0, re);
    float fil = 1.0 - abs(snoise(vec3(ang * 4.5, re * 2.6 - uTime * 2.2, uSeed + 9.0))) * 3.2;
    fil = pow(clamp(fil, 0.0, 1.0), 5.0) * smoothstep(1.75, 1.02, re) * outside;
    float flick = 0.7 + 0.3 * sin(uTime * 23.0 + ang * 3.0);
    float halo = exp(-max(re - 1.0, 0.0) * 4.0) * outside;

    vec3 col = c * inside;
    col += (uColorA * rim + uColorHot * rimCore * 0.8) * uRimGlow * (1.0 + uFlare * 1.5);
    col += uColorA * fil * uFilaments * flick;
    col += uColorB * halo * 0.45;
    float alpha = inside * 0.96 + rim * 0.9 + fil * uFilaments * 0.8 + halo * 0.35;

    /* ---- the rune ring, round, whatever shape the tear is ---- */
    float rr = length(p) / max(uRadius, 1e-3);
    float ra = atan(p.y, p.x);
    float sweep = fract((ra + 1.5707963) / RF_TAU);
    float written = step(sweep, uRune);
    float a2 = ra / RF_TAU + uTime * uRuneSpin;
    float ring1 = exp(-pow((rr - 1.2) * 70.0, 2.0));
    float ring2 = exp(-pow((rr - 1.33) * 90.0, 2.0));
    float band = step(1.225, rr) * step(rr, 1.305);
    float seg = floor(a2 * 40.0);
    float glyph = step(0.45, hash11(seg + uSeed)) * step(0.15, fract(a2 * 40.0)) * step(fract(a2 * 40.0), 0.85);
    float notch = step(0.5, fract(a2 * 160.0)) * step(0.7, hash11(seg * 1.7 + 3.0));
    float runes = (ring1 + ring2 + band * glyph * (0.55 + 0.45 * notch)) * written * uRune;
    col += uColorRune * runes * 1.4;
    alpha = max(alpha, runes * 0.9);

    alpha = clamp(alpha, 0.0, 1.0) * uFade;
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(col * uGlobalGlow, alpha);
  }
`;

/** One vertical rift: the vortex, its rim and its rune ring, on one quad. */
export function createRiftMaterial() {
  const material = new ShaderMaterial({
    name: 'wolf-rift',
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: NormalBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uQuad: { value: 4 },
      uRadius: { value: 1.2 },
      uOpen: { value: 0 },
      uSpin: { value: 0 },
      uFlare: { value: 0 },
      uRune: { value: 0 },
      uRuneSpin: { value: 0.05 },
      uFade: { value: 1 },
      uSeed: { value: 0 },
      uNebula: { value: 1 },
      uRimGlow: { value: 1.6 },
      uFilaments: { value: 1 },
      uStarsIn: { value: 1 },
      uColorDeep: { value: new Color() },
      uColorA: { value: new Color() },
      uColorB: { value: new Color() },
      uColorC: { value: new Color() },
      uColorHot: { value: new Color() },
      uColorRune: { value: new Color() }
    }),
    vertexShader: QUAD_VERTEX,
    fragmentShader: RIFT_FRAGMENT
  });

  /** @param {object} s { quad, radius, open, spin, flare, rune, fade, seed } */
  material.userData.sync = (s) => {
    const c = settings.wolf;
    const g = settings.global;
    const u = material.uniforms;
    u.uQuad.value = s.quad;
    u.uRadius.value = s.radius;
    u.uOpen.value = s.open;
    u.uSpin.value = s.spin;
    u.uFlare.value = s.flare;
    u.uRune.value = s.rune;
    u.uFade.value = s.fade * g.opacity;
    u.uSeed.value = s.seed;
    u.uRuneSpin.value = c.runeSpin;
    u.uNebula.value = c.nebula * g.shaderIntensity;
    u.uRimGlow.value = c.riftRim * g.glow;
    u.uFilaments.value = c.filaments * g.shaderIntensity;
    u.uStarsIn.value = c.riftStars;
    u.uColorDeep.value.copy(getColor(c.colorVoid));
    u.uColorA.value.copy(getColor(c.colorRim));
    u.uColorB.value.copy(getColor(c.colorNebula));
    u.uColorC.value.copy(getColor(c.colorNebulaHot));
    u.uColorHot.value.copy(getColor(c.colorHot));
    u.uColorRune.value.copy(getColor(c.colorGold));
    u.uGlobalGlow.value = g.glow;
  };
  return material;
}

/**
 * Depth only, the shape of the open aperture: the rift is a hole into
 * somewhere else, so whatever is behind it — the wolf's far half, a body
 * already through, the sparks on the other side — is hidden by it from
 * either side. Pushed back a hair so the vortex itself still draws over it.
 */
export function createRiftOccluderMaterial() {
  const material = new ShaderMaterial({
    name: 'wolf-rift-occluder',
    colorWrite: false,
    depthWrite: true,
    depthTest: true,
    side: DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 2,
    polygonOffsetUnits: 4,
    uniforms: { uQuad: { value: 4 }, uRadius: { value: 1 }, uOpen: { value: 0 } },
    vertexShader: QUAD_VERTEX,
    fragmentShader: /* glsl */ `
      uniform float uQuad;
      uniform float uRadius;
      uniform float uOpen;
      varying vec2 vUv;
      varying vec3 vWorld;
      ${APERTURE_GLSL}
      void main() {
        vec2 p = (vUv - 0.5) * uQuad;
        vec2 q = p / max(vec2(uRadius) * riftAxes(uOpen), vec2(1e-3));
        if (dot(q, q) > 0.81 || uOpen < 0.05) discard;
        gl_FragColor = vec4(0.0);
      }
    `
  });
  material.userData.sync = (s) => {
    material.uniforms.uQuad.value = s.quad;
    material.uniforms.uRadius.value = s.radius;
    material.uniforms.uOpen.value = s.open;
  };
  return material;
}

/**
 * Screen-space refraction for the composite (`LAYER.DISTORTION`): the air
 * round the rim dragged round with the vortex. R,G the offset round 0.5, B
 * the strength, A the coverage — the same contract as the shark's water.
 */
export function createRiftWarpMaterial() {
  const material = new ShaderMaterial({
    name: 'wolf-rift-warp',
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: DoubleSide,
    uniforms: sharedUniforms({
      uQuad: { value: 4 },
      uRadius: { value: 1.2 },
      uOpen: { value: 0 },
      uSpin: { value: 0 },
      uStrength: { value: 1 },
      uSeed: { value: 0 }
    }),
    vertexShader: QUAD_VERTEX,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uQuad;
      uniform float uRadius;
      uniform float uOpen;
      uniform float uSpin;
      uniform float uStrength;
      uniform float uSeed;
      uniform float uShaderIntensity;
      varying vec2 vUv;
      varying vec3 vWorld;
      ${noiseGLSL}
      ${APERTURE_GLSL}
      void main() {
        vec2 p = (vUv - 0.5) * uQuad;
        vec2 q = p / max(vec2(uRadius) * riftAxes(uOpen), vec2(1e-3));
        float r = length(q);
        float band = smoothstep(0.75, 1.0, r) * (1.0 - smoothstep(1.0, 1.8, r));
        if (band < 0.004 || uOpen < 0.02) discard;
        vec2 tangent = vec2(-q.y, q.x) / max(r, 1e-3);
        vec2 n = vec2(snoise(vec3(q * 2.0, uTime + uSeed)), snoise(vec3(q * 2.0 + 9.0, uTime + uSeed)));
        vec2 offset = clamp(tangent * 0.8 + n * 0.5, vec2(-1.0), vec2(1.0));
        gl_FragColor = vec4(offset * 0.5 + 0.5, uStrength * uShaderIntensity * band, band);
      }
    `
  });
  material.userData.sync = (s) => {
    const u = material.uniforms;
    u.uQuad.value = s.quad;
    u.uRadius.value = s.radius;
    u.uOpen.value = s.open;
    u.uSpin.value = s.spin;
    u.uSeed.value = s.seed;
    u.uStrength.value = settings.wolf.warp * s.fade;
  };
  return material;
}

/* ==================================================================== */
/* The sigil                                                             */
/* ==================================================================== */

const SIGIL_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uQuad;
  uniform float uRadius;
  uniform float uDraw;
  uniform float uPulse;      // 0.. seconds since the lift, < 0 none
  uniform float uGlow;
  uniform float uFade;
  uniform float uSpin;
  uniform float uSeed;
  uniform float uLines;
  uniform vec3  uColorGold;
  uniform vec3  uColorHot;
  uniform vec3  uColorGround;
  uniform float uGlobalGlow;
  varying vec2 vUv;

  ${noiseGLSL}

  #define SG_TAU 6.283185307179586
  #define SG_PI  3.141592653589793

  float sgLine(float d, float w) { return exp(-pow(d / w, 2.0)); }

  void main() {
    vec2 p = vec2(vUv.x - 0.5, 0.5 - vUv.y) * uQuad / max(uRadius, 1e-3);
    float r = length(p);
    if (r > 1.25) discard;
    float a = atan(p.y, p.x);
    float px = uQuad / max(uRadius, 1e-3) / 512.0;
    float w = max(0.006, px);

    // Drawn on: the rings sweep round, the star and its chords grow outward.
    float sweep = fract((a + SG_PI * 0.5) / SG_TAU);
    float ringOn = step(sweep, uDraw * 1.35);
    float starOn = step(r, uDraw * 1.6 - 0.25);

    /* ---- rings ---- */
    float rings = sgLine(r - 1.0, w * 1.6) + sgLine(r - 0.94, w) * 0.8 + sgLine(r - 0.74, w) * 0.7
                + sgLine(r - 0.68, w * 0.8) * 0.5 + sgLine(r - 0.16, w) * 0.8;

    /* ---- the band of runes between 0.94 and 1.0, turning ---- */
    float ar = a / SG_TAU + uTime * uSpin;
    float seg = floor(ar * 48.0);
    float f = fract(ar * 48.0);
    float glyph = step(0.35, hash11(seg + uSeed)) * step(0.18, f) * step(f, 0.82);
    float bar = step(0.5, hash11(seg * 3.1 + uSeed)) * sgLine(fract(ar * 144.0) - 0.5, 0.12);
    float runeBand = step(0.952, r) * step(r, 0.988) * (glyph * 0.6 + bar * 0.6);
    float ticks = step(0.75, r) * step(r, 0.92) * sgLine(fract(a / SG_TAU * 72.0) - 0.5, 0.07) * 0.35;

    /* ---- the compass rose: four long points, four short ---- */
    float k = a / (SG_TAU / 8.0);
    float idx = floor(k + 0.5);
    float dk = (k - idx) * (SG_TAU / 8.0);       // angle off the nearest point
    float longP = mod(idx, 2.0) < 0.5 ? 1.0 : 0.62;
    float tip = 0.92 * longP;
    float halfW = 0.16 * (1.0 - clamp(r / tip, 0.0, 1.0));
    float edgeD = abs(abs(dk) * r - halfW);
    float rose = sgLine(edgeD, w) * step(r, tip) + sgLine(dk * r, w * 0.6) * step(r, tip) * 0.6;
    float roseFill = step(abs(dk) * r, halfW) * step(r, tip) * (mod(idx + step(0.0, dk), 2.0) < 0.5 ? 0.18 : 0.06);

    /* ---- the octagram: chords between every third point ---- */
    float chords = 0.0;
    for (int i = 0; i < 8; i++) {
      float th = float(i) * SG_TAU / 8.0 + SG_TAU * 3.0 / 16.0;
      vec2 n = vec2(cos(th), sin(th));
      chords += sgLine(dot(p, n) - 0.74 * cos(SG_TAU * 3.0 / 16.0), w * 0.8);
    }
    chords *= step(r, 0.74) * 0.55;

    /* ---- stars of a constellation in the field ---- */
    vec2 sg = p * 9.0;
    vec2 cell = floor(sg);
    float h = hash13(vec3(cell, uSeed));
    float dots = step(0.86, h) * sgLine(length(fract(sg) - 0.5), 0.08) * step(r, 0.92);

    float lines = (rings + runeBand + ticks) * ringOn + (rose + chords) * starOn * uLines;
    float fill = roseFill * starOn;

    // The lift: a ring of light running out, and the whole thing flaring.
    float pulse = 0.0;
    float flare = 0.0;
    if (uPulse >= 0.0) {
      pulse = sgLine(r - uPulse * 2.2, 0.05 + uPulse * 0.08) * exp(-uPulse * 2.5);
      flare = exp(-uPulse * 3.0);
    }
    float shimmer = 0.85 + 0.15 * sin(uTime * 3.0 + r * 12.0);
    float pool = exp(-r * r * 2.2) * 0.35 * (0.6 + flare);

    vec3 col = uColorGold * (lines * shimmer * (1.0 + flare * 1.5) + fill) * uGlow
             + uColorHot * (dots * 0.8 + pulse * 2.0 + lines * flare * 0.6) * uGlow
             + uColorGround * pool * uGlow;
    float alpha = clamp(lines * 0.9 + fill + dots * 0.6 + pulse + pool * 0.6, 0.0, 1.0) * uFade;
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(col * uGlobalGlow, alpha);
  }
`;

/** A gold compass rose burnt into the floor. */
export function createSigilMaterial() {
  const material = new ShaderMaterial({
    name: 'wolf-sigil',
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uQuad: { value: 6 },
      uRadius: { value: 2.5 },
      uDraw: { value: 0 },
      uPulse: { value: -1 },
      uGlow: { value: 1 },
      uFade: { value: 1 },
      uSpin: { value: 0.02 },
      uSeed: { value: 0 },
      uLines: { value: 1 },
      uColorGold: { value: new Color() },
      uColorHot: { value: new Color() },
      uColorGround: { value: new Color() }
    }),
    vertexShader: QUAD_VERTEX,
    fragmentShader: SIGIL_FRAGMENT
  });
  /** @param {object} s { quad, radius, draw, pulse, fade, seed, lines, ground } */
  material.userData.sync = (s) => {
    const c = settings.wolf;
    const g = settings.global;
    const u = material.uniforms;
    u.uQuad.value = s.quad;
    u.uRadius.value = s.radius;
    u.uDraw.value = s.draw;
    u.uPulse.value = s.pulse;
    u.uFade.value = s.fade * g.opacity;
    u.uSeed.value = s.seed;
    u.uLines.value = s.lines;
    u.uGlow.value = c.sigilGlow * g.shaderIntensity;
    u.uSpin.value = c.runeSpin * 0.5;
    u.uColorGold.value.copy(getColor(c.colorGold));
    u.uColorHot.value.copy(getColor(c.colorHot));
    u.uColorGround.value.copy(getColor(s.ground ?? c.colorRim));
    u.uGlobalGlow.value = g.glow;
  };
  return material;
}

/* ==================================================================== */
/* The column                                                            */
/* ==================================================================== */

/** The shaft of light the sigil throws the prey up on. Unit cylinder, base at 0. */
export function createColumnMaterial() {
  const material = new ShaderMaterial({
    name: 'wolf-column',
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uLife: { value: 0 },
      uStrength: { value: 1 },
      uSeed: { value: 0 },
      uColorGold: { value: new Color() },
      uColorHot: { value: new Color() }
    }),
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vWorld;
      varying vec3 vNormalW;
      void main() {
        vUv = uv;
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uLife;
      uniform float uStrength;
      uniform float uSeed;
      uniform vec3  uColorGold;
      uniform vec3  uColorHot;
      uniform float uGlobalGlow;
      varying vec2 vUv;
      varying vec3 vWorld;
      varying vec3 vNormalW;
      ${noiseGLSL}
      void main() {
        vec3 V = normalize(cameraPosition - vWorld);
        float edge = 1.0 - abs(dot(normalize(vNormalW), V));
        float streak = snoise(vec3(vUv.x * 18.0, vUv.y * 2.0 - uTime * 4.0, uSeed));
        streak = smoothstep(0.1, 0.9, streak * 0.5 + 0.5);
        float up = pow(1.0 - vUv.y, 1.6);
        float a = up * (0.25 + 0.75 * edge) * (0.45 + 0.55 * streak) * uStrength;
        // The head of it runs up as it is born.
        a *= smoothstep(0.0, 0.05, uLife * 3.0 - vUv.y);
        vec3 col = mix(uColorGold, uColorHot, streak * 0.4 + (1.0 - vUv.y) * 0.3) * a;
        gl_FragColor = vec4(col * uGlobalGlow, 1.0);
      }
    `
  });
  material.userData.sync = (life, strength) => {
    const c = settings.wolf;
    const u = material.uniforms;
    u.uLife.value = life;
    u.uStrength.value = strength * settings.global.shaderIntensity;
    u.uColorGold.value.copy(getColor(c.colorGold));
    u.uColorHot.value.copy(getColor(c.colorHot));
    u.uGlobalGlow.value = settings.global.glow;
  };
  return material;
}
