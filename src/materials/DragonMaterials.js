import {
  AddEquation,
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  CustomBlending,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  OneFactor,
  OneMinusSrcAlphaFactor,
  ShaderMaterial,
  Sphere,
  Vector3
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms, frame } from '../core/FrameUniforms.js';
import { patchOnBeforeCompile } from '../utils/shaderPatch.js';
import { FIRE_GLSL, FIRE_UNIFORMS_GLSL, fireUniforms } from './PhoenixMaterials.js';

/**
 * THE DRAGONFIRE CIRCLE — every material the dragon and its fire draw with.
 *
 * The fire is the phoenix's fire, deliberately: `FIRE_GLSL` turns a heat into
 * a Planckian colour and the same flame field tears it into tongues, so a
 * breath, a wall and a burning floor read as one fire at different
 * temperatures, and the two fire casts in the sandbox read as the same
 * element. What is new here is *where* the fire is, and that is all clocks:
 *
 *   1. hide       the dragon's own PBR, patched: the portal it comes through,
 *                 the fire under it lighting its belly and through its wing
 *                 membranes, its throat glowing before it breathes
 *   2. portal     a tear of burning sky, a void inside a ring of fire
 *   3. breath     a jet on a bent tube from the mouth to the floor, its gas
 *                 streaming down the tube at the breath's own speed
 *   4. ring       the wall of flame the breath leaves behind it — lit by
 *                 *angle*: a point of the ring is burning if the breath has
 *                 been past it (`uTraced`), and the fire is youngest, tallest
 *                 and hottest where it has only just arrived
 *   5. ground     the floor as it burns: the ring's scorched band, then a
 *                 front running inward with a ragged burning edge, char and
 *                 glowing cracks behind it, ash once it has cooled
 *   6. blaze      the field ablaze — tongues of flame standing everywhere the
 *                 front has passed, each lit on the frame the front reaches it
 *
 * The ring, the ground and the blaze all agree on one shape, `frontWobble`,
 * so the wall that runs inward stands exactly on the edge the floor burns
 * along.
 */

/** Tongues of flame standing in the field, one instanced draw. */
export const DRAGON_BLAZE_COUNT = 320;

/* ------------------------------------------------------------------ */
/* shared                                                              */
/* ------------------------------------------------------------------ */

/** The ragged outline of the fire front, -1..1, by angle. Shared verbatim. */
const FRONT_GLSL = /* glsl */ `
  float frontWobble(float th, float seed) {
    vec2 c = vec2(cos(th), sin(th));
    return snoise(vec3(c * 1.4, seed)) * 0.6 + snoise(vec3(c * 3.7, seed + 3.1)) * 0.4;
  }
`;

/* ------------------------------------------------------------------ */
/* 1 · the hide                                                        */
/* ------------------------------------------------------------------ */

/**
 * Patch one of the dragon's own materials in place.
 *
 * The export's PBR is kept — the scales, the clearcoat and the dark hide are
 * the model — but three things are added, and one is taken away:
 *
 *   - **the portal.** Everything past a plane is discarded, with a molten band
 *     along the cut, so the dragon comes *through* the tear in the sky rather
 *     than fading in under it;
 *   - **the fire under it.** The floor is burning and the dragon is over it,
 *     so the faces that look down take its light — and the wing membranes,
 *     which are thin, take it *through* themselves and glow from behind;
 *   - **the throat.** A warm light at the mouth, swelling as it draws breath.
 *
 * And the transmission is taken off the membranes. It is what the export used
 * to make them thin, and it costs a second render of the opaque scene every
 * frame for a few hundred triangles; the back-light above does the same job
 * for nothing.
 *
 * @param {import('three').MeshStandardMaterial} material a clone, its own
 * @param {{ membrane?: boolean }} [options]
 */
export function patchDragonMaterial(material, { membrane = false } = {}) {
  if ('transmission' in material) material.transmission = 0;
  if (membrane) {
    // Opaque, so it sorts with the body and writes depth for the fire behind it.
    // And matte: lacquered skin catches every light on the stage as a pale
    // sheet, which reads as paper rather than as a wing.
    if ('clearcoat' in material) material.clearcoat = 0.15;
    material.roughness = Math.max(material.roughness, 0.75);
    material.transparent = false;
    material.opacity = 1;
    material.depthWrite = true;
  }

  const uniforms = {
    uTime: frame.uTime,
    uRevealOn: { value: 0 },
    uRevealPoint: { value: new Vector3() },
    uRevealNormal: { value: new Vector3(0, -1, 0) },
    uRevealWidth: { value: 0.3 },
    uRevealGlow: { value: 6 },
    uRevealColor: { value: new Color(1, 0.6, 0.2) },
    uMouth: { value: new Vector3() },
    uThroat: { value: 0 },
    uThroatRadius: { value: 0.6 },
    uThroatColor: { value: new Color(1, 0.5, 0.1) },
    uUnder: { value: 0 },
    uUnderColor: { value: new Color(1, 0.4, 0.08) },
    uFloorY: { value: 0 },
    uMembrane: { value: membrane ? 1 : 0 },
    uRim: { value: 0.4 },
    uRimPower: { value: 3 },
    uRimColor: { value: new Color(1, 0.45, 0.15) },
    uDissolve: { value: 0 }
  };

  patchOnBeforeCompile(
    material,
    (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\nvarying vec3 vDragonWorld;\nvarying vec3 vDragonNormal;`)
        .replace(
          '#include <skinning_vertex>',
          `#include <skinning_vertex>
           vDragonWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`
        )
        .replace(
          '#include <defaultnormal_vertex>',
          `#include <defaultnormal_vertex>
           vDragonNormal = normalize(mat3(modelMatrix) * objectNormal);`
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           varying vec3 vDragonWorld;
           varying vec3 vDragonNormal;
           uniform float uTime;
           uniform float uRevealOn;
           uniform vec3  uRevealPoint;
           uniform vec3  uRevealNormal;
           uniform float uRevealWidth;
           uniform float uRevealGlow;
           uniform vec3  uRevealColor;
           uniform vec3  uMouth;
           uniform float uThroat;
           uniform float uThroatRadius;
           uniform vec3  uThroatColor;
           uniform float uUnder;
           uniform vec3  uUnderColor;
           uniform float uFloorY;
           uniform float uMembrane;
           uniform float uRim;
           uniform float uRimPower;
           uniform vec3  uRimColor;
           uniform float uDissolve;
           ${noiseGLSL}`
        )
        .replace(
          '#include <clipping_planes_fragment>',
          `#include <clipping_planes_fragment>
           // Past the portal: not here yet, or already gone. The cut is
           // roughened so the molten band reads as a tear and not a plane.
           float dragonGrain = snoise(vDragonWorld * 2.3 + uTime * 0.4) * 0.5 + 0.5;
           float dragonCut = uRevealOn > 0.5
             ? dot(vDragonWorld - uRevealPoint, uRevealNormal) + (dragonGrain - 0.5) * uRevealWidth
             : 1e3;
           if (dragonCut < 0.0) discard;
           float dragonBurn = snoise(vDragonWorld * 1.7) * 0.5 + 0.5;
           if (dragonBurn < uDissolve) discard;`
        )
        .replace(
          '#include <opaque_fragment>',
          `{
             vec3 dN = normalize(vDragonNormal);
             // The floor's fire, from below. Strongest on what faces it and
             // on what is close to it.
             float height = max(vDragonWorld.y - uFloorY, 0.0);
             float reach = 1.0 / (1.0 + height * height * 0.04);
             float facing = clamp(-dN.y * 0.75 + 0.25, 0.0, 1.0);
             float flicker = 0.85 + 0.15 * snoise(vec3(vDragonWorld.xz * 0.4, uTime * 3.0));
             vec3 under = uUnderColor * uUnder * reach * flicker;
             outgoingLight += diffuseColor.rgb * under * facing * 2.4 + under * facing * 0.06;
             // The membranes are thin: the fire behind them comes through.
             outgoingLight += under * uMembrane * (0.35 + 0.65 * abs(dN.y)) * 0.2 * vec3(1.0, 0.5, 0.3);

             // The throat, lit from inside.
             float throat = exp(-dot(vDragonWorld - uMouth, vDragonWorld - uMouth) / max(uThroatRadius * uThroatRadius, 1e-4));
             outgoingLight += uThroatColor * throat * uThroat * (0.8 + 0.2 * sin(uTime * 23.0));

             // An ember rim, so the black hide keeps its silhouette over fire.
             float rimK = pow(1.0 - clamp(abs(dot(normal, normalize(vViewPosition))), 0.0, 1.0), uRimPower);
             outgoingLight += uRimColor * rimK * uRim;

             // The molten band where it is coming through the portal.
             float band = 1.0 - smoothstep(0.0, uRevealWidth, dragonCut);
             outgoingLight += uRevealColor * band * band * uRevealGlow;
             float edge = 1.0 - smoothstep(0.0, 0.08, dragonBurn - uDissolve);
             outgoingLight += uRevealColor * edge * step(1e-4, uDissolve) * uRevealGlow;
           }
           #include <opaque_fragment>`
        );
    },
    membrane ? 'dragon-membrane' : 'dragon-hide'
  );

  material.userData.dragon = uniforms;
  return material;
}

/* ------------------------------------------------------------------ */
/* 2 · the portal                                                      */
/* ------------------------------------------------------------------ */

const PORTAL_VERTEX = /* glsl */ `
  varying vec2 vP;
  void main() {
    vP = (uv - 0.5) * 2.0;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const PORTAL_FRAGMENT = /* glsl */ `
  #define TAU 6.283185307179586
  ${FIRE_UNIFORMS_GLSL}
  uniform float uTime;
  uniform float uSeed;
  uniform float uOpen;
  uniform float uSpin;
  uniform float uIntensity;
  uniform float uVoid;
  uniform float uFade;
  uniform float uGlobalGlow;
  varying vec2 vP;

  ${noiseGLSL}
  ${commonGLSL}
  ${FIRE_GLSL}

  void main() {
    float r = length(vP);
    float a = atan(vP.y, vP.x);
    vec2 c = vec2(cos(a), sin(a));

    // A ragged tear, not a circle: the rim is pushed about by the same noise
    // it is burning with.
    float tear = snoise(vec3(c * 2.2, uSeed + uTime * 0.3)) * 0.07 + snoise(vec3(c * 6.0, uSeed + 4.0)) * 0.03;
    float rim = max(uOpen * (0.6 + tear), 1e-3);
    float rr = r / rim;

    // Spiral: the inside turns faster than the rim, so it reads as a vortex.
    float twist = a + uTime * uSpin + (1.0 - clamp(rr, 0.0, 1.0)) * 2.4;
    vec2 s = vec2(cos(twist), sin(twist)) * rr;
    float ridge;
    float n = flameFbm(vec3(s * 2.2, rr * 3.0 - uTime * 1.3 + uSeed), uTime * 0.25, 0.5, ridge);

    // The ring of fire round the tear, and its tongues licking outward.
    float rd = (rr - 0.94) / 0.11;
    float ring = exp(-rd * rd);
    float lick = smoothstep(0.0, 0.4, n - (rr - 1.0) * 2.2 - 0.25) * step(0.94, rr) * (1.0 - smoothstep(1.0, 1.45, rr));
    float fire = clamp(ring * (0.55 + n) + lick * 0.9, 0.0, 1.5);

    // The void inside: black, with embers streaming down the spiral into it.
    float inside = 1.0 - smoothstep(0.82, 0.98, rr);
    // Spiral arms winding down into the dark, embers streaming along them.
    float arms = 0.5 + 0.5 * sin(twist * 3.0 + log(max(rr, 0.02)) * 6.0 - uTime * 2.0);
    arms = smoothstep(0.55, 1.0, arms);
    float streak = (pow(clamp(ridge, 0.0, 1.0), 6.0) * 0.5 + arms * (0.35 + 0.65 * n)) * inside * smoothstep(0.1, 0.85, rr);
    float heat = clamp(fire * 0.75 + streak * 0.4, 0.0, 1.0);
    vec3 col = fireColor(heat) * (fire + streak * 0.35) * uIntensity;
    // A low ember glow deep in it, so it is a hole into fire and not into space.
    col += uColorEmber * inside * (0.25 + 0.5 * n) * smoothstep(0.2, 0.85, rr) * uIntensity;

    float alpha = clamp(inside * uVoid + fire * 0.3, 0.0, 1.0) * uFade;
    col *= uFade * uGlobalGlow;
    if (alpha < 0.002 && max(col.r, max(col.g, col.b)) < 0.002) discard;
    gl_FragColor = vec4(col, alpha);
  }
`;

/** The tear in the sky. Premultiplied over: it darkens the night and glows. */
export function createDragonPortalMaterial() {
  return new ShaderMaterial({
    uniforms: sharedUniforms({
      ...fireUniforms(),
      uSeed: { value: Math.random() * 10 },
      uOpen: { value: 0 },
      uSpin: { value: 1.2 },
      uIntensity: { value: 2 },
      uVoid: { value: 0.9 },
      uFade: { value: 1 }
    }),
    vertexShader: PORTAL_VERTEX,
    fragmentShader: PORTAL_FRAGMENT,
    side: DoubleSide,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: CustomBlending,
    blendEquation: AddEquation,
    blendSrc: OneFactor,
    blendDst: OneMinusSrcAlphaFactor,
    blendSrcAlpha: OneFactor,
    blendDstAlpha: OneMinusSrcAlphaFactor,
    toneMapped: false
  });
}

/* ------------------------------------------------------------------ */
/* 3 · the breath                                                      */
/* ------------------------------------------------------------------ */

/**
 * Two nested tubes, unit everything: `aT` runs 0 at the mouth to 1 at the
 * floor, `aPhi` round the tube, `aLayer` 0 for the outer gas and 1 for the
 * white core inside it. The vertex stage bends it onto the breath's curve.
 */
export function createBreathGeometry(along = 48, around = 20) {
  const geometry = new BufferGeometry();
  const rows = along + 1;
  const cols = around + 1;
  const count = rows * cols * 2;
  const t = new Float32Array(count);
  const phi = new Float32Array(count);
  const layer = new Float32Array(count);
  const position = new Float32Array(count * 3);
  const index = [];
  let v = 0;
  for (let l = 0; l < 2; l++) {
    const base = v;
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        t[v] = i / along;
        phi[v] = (j / around) * Math.PI * 2;
        layer[v] = l;
        v++;
      }
    }
    for (let i = 0; i < along; i++) {
      for (let j = 0; j < around; j++) {
        const a = base + i * cols + j;
        const b = a + cols;
        index.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
  }
  geometry.setAttribute('position', new BufferAttribute(position, 3));
  geometry.setAttribute('aT', new BufferAttribute(t, 1));
  geometry.setAttribute('aPhi', new BufferAttribute(phi, 1));
  geometry.setAttribute('aLayer', new BufferAttribute(layer, 1));
  geometry.setIndex(index);
  geometry.boundingSphere = new Sphere(new Vector3(), 1e4);
  return geometry;
}

const BREATH_VERTEX = /* glsl */ `
  uniform vec3  uFrom;
  uniform vec3  uBend;
  uniform vec3  uTo;
  uniform float uWidthMouth;
  uniform float uWidthEnd;
  uniform float uCore;
  uniform float uTime;

  attribute float aT;
  attribute float aPhi;
  attribute float aLayer;

  varying float vT;
  varying float vPhi;
  varying float vLayer;
  varying float vRadius;
  varying vec3  vWorld;
  varying vec3  vNormal;
  varying float vViewZ;

  void main() {
    float t = aT;
    float s = 1.0 - t;
    // A quadratic bezier: out of the mouth along the head, bent down onto
    // the floor by the gas' own momentum.
    vec3 p = s * s * uFrom + 2.0 * s * t * uBend + t * t * uTo;
    vec3 T = normalize(2.0 * s * (uBend - uFrom) + 2.0 * t * (uTo - uBend) + vec3(1e-5));
    vec3 ref = abs(T.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 N = normalize(cross(T, ref));
    vec3 B = cross(T, N);

    // Pinched at the lips, blooming as it travels, and pulsing as the gas
    // is pushed out in gouts.
    float r = mix(uWidthMouth, uWidthEnd, pow(t, 0.75));
    r *= 1.0 + 0.16 * sin(t * 18.0 - uTime * 26.0 + aPhi * 2.0) * t;
    r *= aLayer > 0.5 ? uCore : 1.0;

    vec3 dir = N * cos(aPhi) + B * sin(aPhi);
    vec3 world = p + dir * r;
    vT = t;
    vPhi = aPhi;
    vLayer = aLayer;
    vRadius = r;
    vWorld = world;
    vNormal = dir;
    vec4 mv = viewMatrix * vec4(world, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const BREATH_FRAGMENT = /* glsl */ `
  ${FIRE_UNIFORMS_GLSL}
  uniform float uTime;
  uniform float uSeed;
  uniform float uLength;
  uniform float uFlow;
  uniform float uNoiseScale;
  uniform float uShred;
  uniform float uExtend;
  uniform float uCut;
  uniform float uIntensity;
  uniform float uOpacity;
  uniform float uGlobalGlow;
  uniform vec2  uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;

  varying float vT;
  varying float vPhi;
  varying float vLayer;
  varying float vRadius;
  varying vec3  vWorld;
  varying vec3  vNormal;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}
  ${FIRE_GLSL}

  void main() {
    // Only the stretch of tube the gas has reached, and nothing the mouth
    // has already stopped feeding.
    float live = smoothstep(uCut, uCut + 0.08, vT) * (1.0 - smoothstep(uExtend - 0.1, uExtend, vT));
    if (live < 0.002) discard;

    // The gas streams down the tube: the noise is laid out in metres along
    // it and round it, and scrolled at the breath's speed.
    float along = vT * uLength - uTime * uFlow;
    vec3 np = vec3(cos(vPhi) * vRadius * 1.6, sin(vPhi) * vRadius * 1.6, along) * uNoiseScale + uSeed + vLayer * 7.0;
    float ridge;
    float n = flameFbm(np, uTime * 0.6, 0.6, ridge);

    // A tube standing in for a volume: dense where it is seen face-on,
    // feathered where it turns edge-on, torn by the noise from there in.
    vec3 V = normalize(cameraPosition - vWorld);
    float facing = abs(dot(normalize(vNormal), V));
    float body = smoothstep(0.05, 0.75, facing);
    float tear = (n - 0.5) * uShred * (0.8 + vT) + (ridge - 0.5) * 0.5 * vT;
    float d = clamp(body * 1.1 + tear - vT * 0.35, 0.0, 1.0) * live;
    d *= d;
    d *= vLayer > 0.5 ? (1.0 - smoothstep(0.55, 0.95, vT)) : 1.0;

    vec2 screenUV = gl_FragCoord.xy / uResolution;
    d *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, 0.5);
    if (d < 0.003) discard;

    float heat = (1.0 - vT) * 0.4 + (n - 0.5) * 0.8 + 0.08 + vLayer * 0.4 + body * 0.1;
    vec3 col = fireColor(heat) * d * uIntensity * (vLayer > 0.5 ? 1.4 : 1.0);
    gl_FragColor = vec4(col * uGlobalGlow * uOpacity, d * uOpacity);
  }
`;

export function createBreathMaterial() {
  return new ShaderMaterial({
    uniforms: sharedUniforms({
      ...fireUniforms(),
      uSeed: { value: Math.random() * 10 },
      uFrom: { value: new Vector3() },
      uBend: { value: new Vector3() },
      uTo: { value: new Vector3() },
      uWidthMouth: { value: 0.12 },
      uWidthEnd: { value: 1.1 },
      uCore: { value: 0.42 },
      uLength: { value: 6 },
      uFlow: { value: 16 },
      uNoiseScale: { value: 1.1 },
      uShred: { value: 1.3 },
      uExtend: { value: 0 },
      uCut: { value: 0 },
      uIntensity: { value: 2.2 },
      uOpacity: { value: 1 }
    }),
    vertexShader: BREATH_VERTEX,
    fragmentShader: BREATH_FRAGMENT,
    side: DoubleSide,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    toneMapped: false
  });
}

/* ------------------------------------------------------------------ */
/* 4 · the ring of fire                                                */
/* ------------------------------------------------------------------ */

/**
 * Two open shells, a hand's width apart, so the wall has a front and a back
 * that drift against each other as the camera moves. `aShell` says which;
 * `position.xz` is the unit circle and `position.y` 0..1 up the wall.
 */
export function createRingGeometry(around = 256, up = 12) {
  const geometry = new BufferGeometry();
  const cols = around + 1;
  const rows = up + 1;
  const count = cols * rows * 2;
  const position = new Float32Array(count * 3);
  const shell = new Float32Array(count);
  const index = [];
  let v = 0;
  for (let s = 0; s < 2; s++) {
    const base = v;
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        const a = (j / around) * Math.PI * 2;
        position[v * 3] = Math.cos(a);
        position[v * 3 + 1] = i / up;
        position[v * 3 + 2] = Math.sin(a);
        shell[v] = s;
        v++;
      }
    }
    for (let i = 0; i < up; i++) {
      for (let j = 0; j < around; j++) {
        const a = base + i * cols + j;
        const b = a + cols;
        index.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
  }
  geometry.setAttribute('position', new BufferAttribute(position, 3));
  geometry.setAttribute('aShell', new BufferAttribute(shell, 1));
  geometry.setIndex(index);
  geometry.boundingSphere = new Sphere(new Vector3(), 1e4);
  return geometry;
}

const RING_VERTEX = /* glsl */ `
  uniform vec3  uCentre;
  uniform float uRadius;
  uniform float uHeight;
  uniform float uThick;
  uniform float uWobble;
  uniform float uSeed;

  attribute float aShell;

  varying vec3  vWorld;
  varying vec3  vNormal;
  varying float vY;
  varying float vTheta;
  varying float vShell;

  ${noiseGLSL}
  ${FRONT_GLSL}

  void main() {
    float th = atan(position.z, position.x);
    // Wobble only for the front, which stands on the floor's ragged edge.
    float r = uRadius + frontWobble(th, uSeed) * uWobble + (aShell - 0.5) * uThick;
    r = max(r, 0.02);
    vec3 p = uCentre + vec3(position.x * r, position.y * uHeight, position.z * r);
    vWorld = p;
    vNormal = vec3(position.x, 0.0, position.z);
    vY = position.y;
    vTheta = th;
    vShell = aShell;
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }
`;

const RING_FRAGMENT = /* glsl */ `
  #define TAU 6.283185307179586
  ${FIRE_UNIFORMS_GLSL}
  uniform float uTime;
  uniform float uSeed;
  uniform float uHeight;
  uniform float uStart;
  uniform float uDir;
  uniform float uTraced;
  uniform float uGrow;
  uniform float uFlare;
  uniform float uNoiseScale;
  uniform float uRise;
  uniform float uShred;
  uniform float uIntensity;
  uniform float uOpacity;
  uniform float uLife;
  uniform float uGlobalGlow;

  varying vec3  vWorld;
  varying vec3  vNormal;
  varying float vY;
  varying float vTheta;
  varying float vShell;

  ${noiseGLSL}
  ${commonGLSL}
  ${FIRE_GLSL}

  void main() {
    // How far round from where the breath started, in the way it went, and
    // so how long this stretch of ring has been alight.
    float arc = mod((vTheta - uStart) * uDir + TAU * 4.0, TAU);
    float behind = uTraced - arc;
    if (behind <= 0.0) discard;
    // Tapered at both ends: where it is catching, and where it started —
    // until the lap comes round and the seam catches too.
    float lit = smoothstep(0.0, uGrow, behind) * smoothstep(0.0, uGrow * 0.6, arc + max(uTraced - TAU, 0.0));
    // Fire that has just caught leaps, then settles into the wall.
    float fresh = exp(-behind / max(uGrow * 0.8, 1e-3));

    // The local flame height, in the wall's own 0..1.
    float y = vY * uHeight;
    vec3 np = vWorld * uNoiseScale + vec3(uSeed + vShell * 13.0, 0.0, uSeed);
    np.y -= uTime * uRise * uNoiseScale;
    float ridge;
    float n = flameFbm(np, uTime * 0.35, 0.45, ridge);
    float tall = (0.45 + 0.55 * snoise01(vec3(vWorld.xz * 0.6, uSeed + uTime * 0.2)))
               * lit * (1.0 + fresh * uFlare) * uLife;
    float h = max(tall, 1e-3);
    float yy = vY / h;

    float field = (1.0 - yy) * 0.95 - 0.38
                + (n - 0.5) * uShred * (0.7 + yy)
                + (ridge - 0.5) * 0.6 * (0.3 + yy);
    float d = smoothstep(0.0, 0.2, field) * smoothstep(0.0, 0.05, vY) * step(yy, 1.4);

    vec3 V = normalize(cameraPosition - vWorld);
    float facing = abs(dot(normalize(vNormal), V));
    // Feathered hard where the wall turns edge-on, or its silhouette draws as a seam.
    d *= smoothstep(0.03, 0.45, facing) * (vShell > 0.5 ? 0.75 : 1.0);
    if (d < 0.003) discard;

    float heat = (1.0 - yy) * 0.55 + (n - 0.5) * 0.6 + 0.2 + fresh * 0.4;
    vec3 col = fireColor(heat) * uIntensity * d;
    gl_FragColor = vec4(col * uGlobalGlow * uOpacity, d * uOpacity);
  }
`;

/**
 * A wall of flame on a circle. Used twice: as the ring the breath draws, lit
 * by angle, and as the front running inward, lit all round and standing on
 * the floor's ragged edge (`uWobble`).
 */
export function createRingMaterial() {
  return new ShaderMaterial({
    uniforms: sharedUniforms({
      ...fireUniforms(),
      uSeed: { value: Math.random() * 10 },
      uCentre: { value: new Vector3() },
      uRadius: { value: 5 },
      uHeight: { value: 2.4 },
      uThick: { value: 0.25 },
      uWobble: { value: 0 },
      uStart: { value: 0 },
      uDir: { value: 1 },
      uTraced: { value: 0 },
      uGrow: { value: 0.5 },
      uFlare: { value: 0.8 },
      uNoiseScale: { value: 1.3 },
      uRise: { value: 1.6 },
      uShred: { value: 1.3 },
      uIntensity: { value: 1.6 },
      uOpacity: { value: 1 },
      uLife: { value: 1 }
    }),
    vertexShader: RING_VERTEX,
    fragmentShader: RING_FRAGMENT,
    side: DoubleSide,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    toneMapped: false
  });
}

/* ------------------------------------------------------------------ */
/* 5 · the ground                                                      */
/* ------------------------------------------------------------------ */

const GROUND_VERTEX = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const GROUND_FRAGMENT = /* glsl */ `
  #define TAU 6.283185307179586
  uniform float uTime;
  uniform float uSeed;
  uniform vec3  uCentre;
  uniform float uRadius;
  uniform float uStart;
  uniform float uDir;
  uniform float uTraced;
  uniform float uBand;
  uniform float uFront;
  uniform float uWobble;
  uniform float uFrontWidth;
  uniform float uFrontGlow;
  uniform float uHeatReach;
  uniform float uHeat;
  uniform float uChar;
  uniform float uCharFade;
  uniform float uCrackScale;
  uniform float uCrackWidth;
  uniform float uCrackGlow;
  uniform float uEmberGlow;
  uniform float uAsh;
  uniform float uFlash;
  uniform float uGlobalGlow;
  uniform vec3  uColorChar;
  uniform vec3  uColorAsh;
  uniform vec3  uColorHot;
  uniform vec3  uColorCrack;
  uniform vec3  uColorEmber;

  varying vec3 vWorld;

  ${noiseGLSL}
  ${FRONT_GLSL}

  /* Voronoi with the second-nearest cell kept: plates, and the cracks between. */
  vec2 plates(vec2 p) {
    vec2 n = floor(p);
    vec2 f = fract(p);
    float f1 = 8.0;
    float f2 = 8.0;
    float id = 0.0;
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 g = vec2(float(i), float(j));
        vec2 o = hash21(dot(n + g, vec2(7.13, 113.17)));
        vec2 r = g + o - f;
        float d = dot(r, r);
        if (d < f1) { f2 = f1; f1 = d; id = hash11(dot(n + g, vec2(31.7, 57.1))); }
        else if (d < f2) { f2 = d; }
      }
    }
    return vec2(sqrt(f2) - sqrt(f1), id);
  }

  void main() {
    vec2 p = vWorld.xz - uCentre.xz;
    float r = length(p);
    float th = atan(p.y, p.x);
    float R = uRadius;
    if (r > R * 1.35) discard;

    float grain = snoise01(vec3(p * 2.7, uSeed));
    float mottle = snoise01(vec3(p * 0.55, uSeed + 5.0));

    /* ---- the ring the breath drew ---- */
    float arc = mod((th - uStart) * uDir + TAU * 4.0, TAU);
    float behind = uTraced - arc;
    float traced = smoothstep(0.0, 0.25, behind);
    float ringD = (r - R) / max(uBand, 1e-3);
    float ring = exp(-ringD * ringD) * traced;
    // Hottest where it has just caught; once the lap has closed it settles
    // to one heat all round, or the seam where it started would show.
    float ringHot = ring * mix(exp(-max(behind, 0.0) * 0.35), 0.22, smoothstep(TAU, TAU + 1.2, uTraced));

    /* ---- the front, and what is behind it ---- */
    float edgeR = uFront + frontWobble(th, uSeed) * uWobble + (grain - 0.5) * uWobble * 0.35;
    float d = r - edgeR;                       // > 0: already burnt
    float burnt = smoothstep(-0.05, 0.25, d) * step(r, R + uBand * 0.6);
    float fd = d / max(uFrontWidth, 1e-3);
    float front = exp(-fd * fd) * step(-uWobble * 1.5, uFront) * step(r, R);
    float preheat = exp(min(d, 0.0) / 0.7) * (1.0 - burnt) * step(r, R) * step(-uWobble, uFront) * step(uFront, R);
    // Hottest just behind the front, cooling back toward the ring.
    float hot = burnt * (0.3 + 0.7 * exp(-max(d, 0.0) / max(uHeatReach, 1e-3))) * uHeat;

    /* ---- char: the burnt disc and the ring's band ---- */
    float soot = smoothstep(R * 1.25, R * 0.98, r) * traced * 0.35 * mottle;
    float charA = max(max(burnt, ring * 0.9), soot) * uChar * (0.72 + 0.28 * grain);
    // It goes the way it came: patchily, from the outside in.
    float keep = smoothstep(0.0, 0.25, uCharFade * 1.3 - mottle * 0.6 - (r / R) * 0.4);
    charA *= keep;

    /* ---- the crust: plates split by the heat, glowing at the seams ---- */
    vec2 cp = p * uCrackScale + vec2(uSeed * 10.0, uSeed * 7.0);
    cp += (snoise01(vec3(p * 1.3, uSeed + 9.0)) - 0.5) * 0.8;
    vec2 vor = plates(cp);
    float crack = (1.0 - smoothstep(0.0, uCrackWidth, vor.x)) * burnt;
    float pulse = 0.75 + 0.25 * sin(uTime * 2.3 + vor.y * 9.0 - r * 1.3);
    crack *= (0.25 + hot) * pulse;

    /* ---- embers in the crust, ash once it has cooled ---- */
    float specks = snoise01(vec3(p * 9.0, uSeed + uTime * 0.2));
    float ember = smoothstep(0.82, 0.95, specks) * burnt * (0.2 + hot) * uEmberGlow
                * (0.6 + 0.4 * sin(uTime * 7.0 + specks * 50.0));
    float ash = smoothstep(0.62, 0.9, snoise01(vec3(p * 5.5, uSeed + 2.0))) * burnt * (1.0 - clamp(hot * 1.5, 0.0, 1.0)) * uAsh;

    vec3 col = uColorChar * charA
             + uColorAsh * ash * charA
             + uColorCrack * crack * uCrackGlow
             + uColorEmber * ember
             + uColorHot * (front * uFrontGlow + preheat * 0.35 * uFrontGlow + ringHot * 1.6 + ring * 0.35 * uHeat)
             + uColorHot * hot * 0.08 * (0.4 + 0.6 * mottle)
             + uColorHot * uFlash * (burnt + ring);
    col *= uGlobalGlow;

    float alpha = clamp(charA, 0.0, 1.0);
    if (alpha < 0.002 && max(col.r, max(col.g, col.b)) < 0.002) discard;
    gl_FragColor = vec4(col, alpha);
  }
`;

/** The floor as it burns. Premultiplied, so it darkens the stone *and* glows. */
export function createDragonGroundMaterial() {
  return new ShaderMaterial({
    uniforms: sharedUniforms({
      uSeed: { value: Math.random() * 10 },
      uCentre: { value: new Vector3() },
      uRadius: { value: 5 },
      uStart: { value: 0 },
      uDir: { value: 1 },
      uTraced: { value: 0 },
      uBand: { value: 0.5 },
      uFront: { value: 10 },
      uWobble: { value: 0.5 },
      uFrontWidth: { value: 0.35 },
      uFrontGlow: { value: 2 },
      uHeatReach: { value: 1.5 },
      uHeat: { value: 1 },
      uChar: { value: 0.9 },
      uCharFade: { value: 1 },
      uCrackScale: { value: 1.2 },
      uCrackWidth: { value: 0.06 },
      uCrackGlow: { value: 2 },
      uEmberGlow: { value: 1.5 },
      uAsh: { value: 0.5 },
      uFlash: { value: 0 },
      uColorChar: { value: new Color(0.02, 0.012, 0.008) },
      uColorAsh: { value: new Color(0.3, 0.28, 0.26) },
      uColorHot: { value: new Color(1, 0.4, 0.08) },
      uColorCrack: { value: new Color(1, 0.5, 0.12) },
      uColorEmber: { value: new Color(1, 0.6, 0.2) }
    }),
    vertexShader: GROUND_VERTEX,
    fragmentShader: GROUND_FRAGMENT,
    side: DoubleSide,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: CustomBlending,
    blendEquation: AddEquation,
    blendSrc: OneFactor,
    blendDst: OneMinusSrcAlphaFactor,
    blendSrcAlpha: OneFactor,
    blendDstAlpha: OneMinusSrcAlphaFactor,
    toneMapped: false
  });
}

/* ------------------------------------------------------------------ */
/* 6 · the blaze                                                       */
/* ------------------------------------------------------------------ */

/**
 * One quad per tongue, instanced. Each is planted in the unit disc —
 * `aSpot = (r 0..1, angle, seed, size)` with r drawn as a square root so the
 * field is evenly covered — and the vertex stage turns it to the camera
 * about its own upright and sizes it off the front's clock.
 */
export function createBlazeGeometry(count = DRAGON_BLAZE_COUNT) {
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute(
    'position',
    new BufferAttribute(new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0]), 3)
  );
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  geometry.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));

  const spot = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    // Stratified in radius, so no ring of the field comes up bare.
    const u = (i + Math.random()) / count;
    spot[i * 4] = Math.sqrt(u) * 0.97;
    spot[i * 4 + 1] = Math.random() * Math.PI * 2;
    spot[i * 4 + 2] = Math.random();
    spot[i * 4 + 3] = 0.55 + Math.random() * 0.75;
  }
  geometry.setAttribute('aSpot', new InstancedBufferAttribute(spot, 4));
  geometry.instanceCount = count;
  geometry.boundingSphere = new Sphere(new Vector3(), 1e4);
  return geometry;
}

const BLAZE_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform vec3  uCentre;
  uniform float uRadius;
  uniform float uClock;
  uniform float uSpreadTime;
  uniform float uHeight;
  uniform float uWidth;
  uniform float uBurnTime;
  uniform float uSustain;
  uniform float uLeap;
  uniform float uLife;
  uniform float uSeed;
  uniform float uWobble;

  attribute vec4 aSpot;

  varying vec2  vUv;
  varying vec2  vSize;
  varying float vSeed;
  varying float vFresh;
  varying float vViewZ;

  ${noiseGLSL}
  ${FRONT_GLSL}

  void main() {
    vUv = uv;
    vSeed = aSpot.z;
    float r = aSpot.x * uRadius;
    float th = aSpot.y;
    vec3 base = uCentre + vec3(cos(th) * r, 0.0, sin(th) * r);

    // Lit when the front gets to it: the same ragged edge the floor burns along.
    float reach = aSpot.x + frontWobble(th, uSeed) * uWobble / max(uRadius, 0.1);
    float ignite = (1.0 - clamp(reach, 0.0, 1.0)) * uSpreadTime;
    float age = uClock - ignite;
    float grow = smoothstep(0.0, 0.3, age);
    // Once the front has gone by, the field settles: most of its tongues go
    // out and a share of them (uSustain) burn on, lower. A field of tongues
    // that all shrank in step would read as a field of little cones.
    float settle = smoothstep(0.25, max(uBurnTime, 0.3), age);
    float burn = mix(1.0, step(aSpot.z, uSustain) * 0.7, settle);
    float fresh = exp(-max(age, 0.0) * 3.0) * step(0.0, age);
    // Each tongue gutters on its own clock, and goes out on its own: as the
    // field dies the tongues drop out one by one rather than all shrinking.
    float gutter = 0.72 + 0.28 * sin(uTime * (2.3 + aSpot.z * 3.1) + aSpot.z * 40.0);
    float alive = smoothstep(0.0, 0.35, uLife - aSpot.z * 0.6);
    float h = uHeight * aSpot.w * grow * burn * (1.0 + fresh * uLeap) * gutter * alive;
    vFresh = fresh;

    if (h < 0.02) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    // Turned to the camera about its own upright, so a tongue never shows
    // its edge and never leans.
    vec3 toCam = cameraPosition - base;
    vec3 side = normalize(vec3(toCam.z, 0.0, -toCam.x) + vec3(1e-5, 0.0, 0.0));
    // A tongue keeps its proportions as it settles: a short one is a narrow one.
    float w = uWidth * aSpot.w * (0.3 + 0.7 * clamp(h / max(uHeight * aSpot.w, 1e-3), 0.0, 1.0));
    vSize = vec2(w, h);
    // Pushed a little toward the camera, so it does not cut into the floor.
    vec3 p = base + side * position.x * w + vec3(0.0, position.y * h, 0.0) + normalize(vec3(toCam.x, 0.0, toCam.z)) * 0.05;
    vec4 mv = viewMatrix * vec4(p, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const BLAZE_FRAGMENT = /* glsl */ `
  ${FIRE_UNIFORMS_GLSL}
  uniform float uTime;
  uniform float uNoiseScale;
  uniform float uRise;
  uniform float uShred;
  uniform float uIntensity;
  uniform float uOpacity;
  uniform float uGlobalGlow;
  uniform vec2  uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;

  varying vec2  vUv;
  varying vec2  vSize;
  varying float vSeed;
  varying float vFresh;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}
  ${FIRE_GLSL}

  void main() {
    float x = vUv.x - 0.5;
    float y = vUv.y;
    // In the tongue's own proportions rather than in metres, so a low flame
    // is torn as finely as a tall one and never settles into a clean cone.
    vec3 np = vec3(x * 1.4, y * 1.8, vSeed * 17.0) * uNoiseScale;
    np.y -= uTime * uRise * 0.9;
    float ridge;
    float n = flameFbm(np, uTime * 0.4, 0.5, ridge);

    // A teardrop, but never a clean one: the flame field pushes the tongue's
    // own coordinate sideways more the higher it climbs, so its sides wander
    // and lick, its top is torn ragged, and holes open through it. A profile
    // cut straight would read, at any size, as a cone.
    float lean = sin(uTime * 1.7 + vSeed * 30.0 + y * 2.0) * 0.06 * y;
    float xx = x - lean + (n - 0.5) * 0.7 * uShred * (0.15 + y);
    float halfWidth = 0.4 * pow(max(1.0 - y, 0.0), 0.55) * (0.7 + 0.6 * n);
    float body = 1.0 - smoothstep(halfWidth * 0.45, halfWidth, abs(xx));
    float top = 1.0 - smoothstep(0.35 + 0.4 * n, 0.95, y);
    float holes = smoothstep(0.18, 0.42, n + (1.0 - y) * 0.45 + (ridge - 0.5) * 0.2);
    // Windowed to the quad, or a lick that reaches its side is cut off straight.
    float d = body * top * holes * smoothstep(0.0, 0.07, y) * smoothstep(0.5, 0.34, abs(x));
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    d *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, 0.25);
    if (d < 0.003) discard;

    // Fresh fire at the front runs white; the field behind it settles to orange.
    float heat = (1.0 - y) * 0.5 + (n - 0.5) * 0.6 + 0.02 + vFresh * 0.5;
    vec3 col = fireColor(heat) * uIntensity * d;
    gl_FragColor = vec4(col * uGlobalGlow * uOpacity, d * uOpacity);
  }
`;

export function createBlazeMaterial() {
  return new ShaderMaterial({
    uniforms: sharedUniforms({
      ...fireUniforms(),
      uSeed: { value: Math.random() * 10 },
      uCentre: { value: new Vector3() },
      uRadius: { value: 5 },
      uClock: { value: -10 },
      uSpreadTime: { value: 3 },
      uHeight: { value: 1.4 },
      uWidth: { value: 0.9 },
      uBurnTime: { value: 2.4 },
      uSustain: { value: 0.45 },
      uLeap: { value: 0.7 },
      uLife: { value: 1 },
      uWobble: { value: 0.5 },
      uNoiseScale: { value: 1.6 },
      uRise: { value: 1.8 },
      uShred: { value: 1.3 },
      uIntensity: { value: 1.6 },
      uOpacity: { value: 1 }
    }),
    vertexShader: BLAZE_VERTEX,
    fragmentShader: BLAZE_FRAGMENT,
    side: DoubleSide,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    toneMapped: false
  });
}
