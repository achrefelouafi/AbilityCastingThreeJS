import { AdditiveBlending, Color, DoubleSide, ShaderMaterial, Vector3 } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { patchOnBeforeCompile, replaceChunk } from '../utils/shaderPatch.js';

/**
 * Every shader the Stormheart Gyroscope brings with it.
 *
 * The brass itself is the modeller's — a textured PBR body that keeps its own
 * material. What is built here is what turns an ornament into a storm engine:
 *
 *   - a **sigil** on the floor, the circle the cast claims: two rune bands
 *     turning against each other, a hexagram, spokes that carry charge inward
 *     to the point under the core — and it flares on every strike;
 *   - a **column** of light the construct is called down through;
 *   - the **core**: a star of light at the rune that swells while it charges,
 *     throws rays, and gutters like an arc lamp;
 *   - the **bolt**: a camera-facing ribbon drawn along a jagged path with a
 *     white-hot spine and a violet sheath, that propagates from the core to
 *     its mark over a few milliseconds and re-strikes before it fades;
 *   - and a **patch on the body** for the arrival: the gyroscope is not
 *     dropped in, it *condenses* — a sphere of violet fire grows out of the
 *     core and the brass appears inside it.
 */

const ADDITIVE = {
  transparent: true,
  depthWrite: false,
  blending: AdditiveBlending,
  toneMapped: false
};

/* ---------------------------------------------------------------------- */
/* The bolt                                                                 */
/* ---------------------------------------------------------------------- */

const BOLT_VERTEX = /* glsl */ `
  attribute vec2 aUv;
  attribute float aBright;
  varying vec2 vUv;
  varying float vBright;
  void main() {
    vUv = aUv;
    vBright = aBright;
    // The ribbon is already billboarded on the CPU, in world space.
    gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
  }
`;

const BOLT_FRAGMENT = /* glsl */ `
  uniform float uIntensity;
  uniform float uFade;
  uniform float uHead;
  uniform float uCoreWidth;
  uniform float uOpacity;
  uniform float uGlobalGlow;
  uniform vec3 uColorCore;
  uniform vec3 uColorBolt;
  uniform vec3 uColorGlow;
  varying vec2 vUv;
  varying float vBright;

  void main() {
    // The leader: nothing past the head, and the head itself burns hottest.
    float ahead = vUv.x - uHead;
    if (ahead > 0.0) discard;
    float tip = exp(ahead * 40.0) * step(uHead, 0.999);

    float d = abs(vUv.y);
    float spine = 1.0 - smoothstep(0.0, uCoreWidth, d);
    float sheath = exp(-d * d * 9.0);
    float halo = exp(-d * 3.2) * 0.35;

    vec3 col = uColorGlow * (halo + sheath * 0.6)
             + uColorBolt * sheath * 0.9
             + uColorCore * spine * 2.2;
    col *= vBright * (1.0 + tip * 2.5);
    float a = uIntensity * uFade * uOpacity * uGlobalGlow;
    gl_FragColor = vec4(col * a, 1.0);
  }
`;

export function createBoltMaterial() {
  return new ShaderMaterial({
    uniforms: sharedUniforms({
      uIntensity: { value: 3 },
      uFade: { value: 1 },
      uHead: { value: 1 },
      uCoreWidth: { value: 0.18 },
      uOpacity: { value: 1 },
      uColorCore: { value: new Color('#ffffff') },
      uColorBolt: { value: new Color('#d9c4ff') },
      uColorGlow: { value: new Color('#7a3cff') }
    }),
    vertexShader: BOLT_VERTEX,
    fragmentShader: BOLT_FRAGMENT,
    side: DoubleSide,
    ...ADDITIVE
  });
}

/* ---------------------------------------------------------------------- */
/* The core                                                                 */
/* ---------------------------------------------------------------------- */

const QUAD_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const CORE_FRAGMENT = /* glsl */ `
  #define TAU 6.283185307179586
  uniform float uTime;
  uniform float uIntensity;
  uniform float uCharge;
  uniform float uRays;
  uniform float uFlicker;
  uniform float uSeed;
  uniform float uOpacity;
  uniform float uGlobalGlow;
  uniform vec3 uColorCore;
  uniform vec3 uColorGlow;
  uniform vec3 uColorArc;
  varying vec2 vUv;
  ${noiseGLSL}

  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    float a = atan(p.y, p.x);
    float t = uTime;

    // An arc lamp gutters: fast, ragged, never quite out.
    float flick = 1.0 - uFlicker * (0.5 + 0.5 * snoise(vec3(t * 17.0, uSeed, 0.0)));

    float core = exp(-r * r * mix(90.0, 30.0, uCharge));
    float halo = exp(-r * mix(9.0, 4.2, uCharge)) * 0.55;

    // Rays: turning, uneven, each one breathing on its own.
    float n = max(1.0, uRays);
    float ray = 0.0;
    for (int k = 0; k < 2; k++) {
      float fk = float(k);
      float ang = a * n + t * (fk == 0.0 ? 0.7 : -1.1) + fk * 1.7;
      float len = 0.55 + 0.45 * snoise(vec3(floor((a / TAU + 0.5) * n + fk * 0.5), t * 2.0, fk + uSeed));
      ray += pow(abs(cos(ang * 0.5)), 60.0) * exp(-r / max(0.05, len * 0.55));
    }
    // And the four-point glint across it, the shape of a star on a lens.
    float cross = (exp(-abs(p.y) * 60.0) + exp(-abs(p.x) * 60.0)) * exp(-r * 3.0) * 0.6;

    // Electric skin on the halo — cells of brighter blue that crawl.
    float skin = smoothstep(0.55, 1.0, snoise(vec3(p * 6.0, t * 3.0))) * exp(-r * 5.0) * uCharge;

    vec3 col = uColorCore * core * 3.0
             + uColorGlow * halo
             + mix(uColorGlow, uColorCore, 0.5) * ray * uCharge * 1.4
             + uColorCore * cross * uCharge
             + uColorArc * skin * 1.5;
    float edge = 1.0 - smoothstep(0.8, 1.0, r);
    float k = uIntensity * flick * uOpacity * uGlobalGlow * edge;
    gl_FragColor = vec4(col * k, 1.0);
  }
`;

export function createCoreMaterial() {
  return new ShaderMaterial({
    uniforms: sharedUniforms({
      uIntensity: { value: 1 },
      uCharge: { value: 0 },
      uRays: { value: 6 },
      uFlicker: { value: 0.3 },
      uSeed: { value: Math.random() * 10 },
      uOpacity: { value: 1 },
      uColorCore: { value: new Color('#ffffff') },
      uColorGlow: { value: new Color('#8a4dff') },
      uColorArc: { value: new Color('#5fd8ff') }
    }),
    vertexShader: QUAD_VERTEX,
    fragmentShader: CORE_FRAGMENT,
    depthTest: false,
    ...ADDITIVE
  });
}

/* ---------------------------------------------------------------------- */
/* The sigil                                                                */
/* ---------------------------------------------------------------------- */

const SIGIL_VERTEX = /* glsl */ `
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
  uniform float uRadius;
  uniform float uReveal;
  uniform float uCharge;
  uniform float uPulse;
  uniform float uSpin;
  uniform float uFill;
  uniform float uIntensity;
  uniform float uOpacity;
  uniform float uGlobalGlow;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform vec3 uColorArc;
  varying vec2 vP;

  float band(float d, float w) { return 1.0 - smoothstep(w, w + 0.035, abs(d)); }
  float h11(float x) { return fract(sin(x * 127.1) * 43758.5453); }

  vec2 rot(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }

  // Distance to the outline of an equilateral triangle of circumradius R.
  float tri(vec2 p, float R) {
    float inr = R * 0.5;
    float d = -1e3;
    for (int k = 0; k < 3; k++) {
      float ang = PI * 0.5 + float(k) * TAU / 3.0;
      d = max(d, dot(p, vec2(cos(ang), sin(ang))) - inr);
    }
    return d;
  }

  void main() {
    float R = max(0.2, uRadius);
    float r = length(vP);
    if (r > R + 1.0) discard;
    float a = atan(vP.y, vP.x);
    float a01 = a / TAU + 0.5;
    float t = uTime;

    // It draws itself on: a sweep round from the cast's own side, with a hot
    // tip where the line is being written.
    float sweep = uReveal * 1.08;
    float drawn = 1.0 - smoothstep(sweep - 0.04, sweep, a01);
    float writing = exp(-abs(a01 - sweep) * 60.0) * step(uReveal, 0.999);

    /* the outer bands */
    float outer = band(r - R, 0.03) + band(r - (R - 0.34), 0.018) * 0.8;
    // Runes between them: dashes of uneven length, turning.
    float aRune = a01 + t * uSpin * 0.05;
    float cell = floor(aRune * 64.0);
    float within = fract(aRune * 64.0);
    float runeBand = step(R - 0.29, r) * step(r, R - 0.05);
    float runeH = mix(0.3, 1.0, h11(cell));
    float rune = runeBand * step(0.18, within) * step(within, 0.82)
               * step(abs(r - (R - 0.17)), 0.12 * runeH) * step(0.25, h11(cell + 7.0));

    /* the inner ring and its notches, turning the other way */
    float Ri = R * 0.58;
    float aIn = a + t * uSpin * -0.35;
    float inner = band(r - Ri, 0.022);
    float notch = band(r - (Ri - 0.18), 0.012) * step(0.6, fract(aIn / TAU * 12.0));

    /* the hexagram, slowly turning */
    vec2 q = rot(vP, t * uSpin * 0.2);
    float hex = band(tri(q, Ri), 0.02) + band(tri(-q, Ri), 0.02);
    hex *= step(r, Ri + 0.05);

    /* the heart: a small double ring under the core */
    float heart = band(r - R * 0.14, 0.02) + band(r - R * 0.09, 0.012);

    /* spokes, carrying charge inward on every strike and on the charge */
    float spokes = 12.0;
    float sa = abs(fract(a01 * spokes + 0.5) - 0.5) / spokes * TAU * r;
    float spoke = (1.0 - smoothstep(0.0, 0.03, sa)) * step(Ri, r) * step(r, R - 0.34);
    float runIn = fract(r / R * 1.5 + t * (0.6 + 2.0 * uCharge));
    float carry = spoke * (0.25 + smoothstep(0.75, 1.0, runIn) * (0.5 + uCharge));

    /* a faint wash crowded toward the rim, so the middle stays readable */
    float inside = 1.0 - smoothstep(R - 0.05, R, r);
    float fill = uFill * pow(clamp(r / R, 0.0, 1.0), 4.0) * inside;

    /* the strike pulse: a ring running out from the heart */
    float pulseR = (1.0 - uPulse) * R;
    float pulse = exp(-abs(r - pulseR) * 6.0) * uPulse * inside;

    float lines = (outer + rune * 0.75 + inner + notch + hex * 0.85 + heart) * drawn;
    float glow = 0.75 + 0.6 * uCharge + uPulse * 1.2;

    vec3 col = uColorA * lines * glow
             + uColorB * (rune * 0.5 + heart * 0.6) * drawn * (0.4 + uCharge)
             + uColorArc * (carry * drawn + pulse * 1.4)
             + uColorA * fill * (0.6 + uCharge)
             + uColorB * writing * 3.0 * step(abs(r - R), 0.4);
    float k = uIntensity * uOpacity * uGlobalGlow;
    gl_FragColor = vec4(col * k, 1.0);
  }
`;

export function createSigilMaterial() {
  return new ShaderMaterial({
    uniforms: sharedUniforms({
      uQuadSize: { value: 14 },
      uRadius: { value: 6 },
      uReveal: { value: 0 },
      uCharge: { value: 0 },
      uPulse: { value: 0 },
      uSpin: { value: 0.3 },
      uFill: { value: 0.15 },
      uIntensity: { value: 1 },
      uOpacity: { value: 1 },
      uColorA: { value: new Color('#9b6bff') },
      uColorB: { value: new Color('#ffcf7a') },
      uColorArc: { value: new Color('#5fd8ff') }
    }),
    vertexShader: SIGIL_VERTEX,
    fragmentShader: SIGIL_FRAGMENT,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    ...ADDITIVE
  });
}

/* ---------------------------------------------------------------------- */
/* The column                                                               */
/* ---------------------------------------------------------------------- */

const COLUMN_VERTEX = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalV;
  varying vec3 vViewV;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormalV = normalize(normalMatrix * normal);
    vViewV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const COLUMN_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uIntensity;
  uniform float uOpacity;
  uniform float uGlobalGlow;
  uniform vec3 uColor;
  uniform vec3 uColorCore;
  varying vec2 vUv;
  varying vec3 vNormalV;
  varying vec3 vViewV;
  ${noiseGLSL}

  void main() {
    float t = uTime;
    // Streaks pouring down it, the way light falls down a shaft of dust.
    float s = snoise(vec3(vUv.x * 18.0, vUv.y * 2.0 + t * 3.5, 0.0)) * 0.5 + 0.5;
    float streak = pow(s, 3.0);
    // A shell: bright where it is seen edge on, clear across the middle.
    float facing = abs(dot(normalize(vNormalV), normalize(vViewV)));
    float shell = pow(1.0 - facing, 1.6) * 0.8 + 0.2;
    float ends = smoothstep(0.0, 0.08, vUv.y) * (1.0 - smoothstep(0.55, 1.0, vUv.y));
    vec3 col = mix(uColor, uColorCore, streak * 0.6) * (shell + streak * 0.8);
    float k = uIntensity * ends * uOpacity * uGlobalGlow;
    gl_FragColor = vec4(col * k, 1.0);
  }
`;

export function createColumnMaterial() {
  return new ShaderMaterial({
    uniforms: sharedUniforms({
      uIntensity: { value: 0 },
      uOpacity: { value: 1 },
      uColor: { value: new Color('#8a4dff') },
      uColorCore: { value: new Color('#ffffff') }
    }),
    vertexShader: COLUMN_VERTEX,
    fragmentShader: COLUMN_FRAGMENT,
    side: DoubleSide,
    ...ADDITIVE
  });
}

/* ---------------------------------------------------------------------- */
/* The body                                                                 */
/* ---------------------------------------------------------------------- */

/**
 * The condensing reveal, a violet rim, and a charge that makes the brass hum.
 *
 * `uRevealR` is a radius about `uCore` in world metres: inside it the brass
 * is there, at it a band of fire, outside nothing. Run it backwards to leave.
 */
export function patchGyroscopeBody(material) {
  const uniforms = {
    uGyroCore: { value: new Vector3() },
    uRevealR: { value: 1e4 },
    uRevealWidth: { value: 0.2 },
    uRevealColor: { value: new Color('#c58bff') },
    uRevealGlow: { value: 8 },
    uRimColor: { value: new Color('#9a6bff') },
    uRimStrength: { value: 0.5 },
    uRimPower: { value: 2.5 },
    uEmissiveBoost: { value: 1 },
    uCharge: { value: 0 }
  };
  material.userData.gyroUniforms = uniforms;

  patchOnBeforeCompile(
    material,
    (shader) => {
      Object.assign(shader.uniforms, uniforms);

      shader.vertexShader = replaceChunk(
        shader.vertexShader,
        '#include <common>',
        /* glsl */ `
          #include <common>
          varying vec3 vGyroWorld;
        `
      );
      shader.vertexShader = replaceChunk(
        shader.vertexShader,
        '#include <worldpos_vertex>',
        /* glsl */ `
          #include <worldpos_vertex>
          vGyroWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
        `
      );

      shader.fragmentShader = replaceChunk(
        shader.fragmentShader,
        '#include <common>',
        /* glsl */ `
          #include <common>
          uniform vec3 uGyroCore;
          uniform float uRevealR;
          uniform float uRevealWidth;
          uniform vec3 uRevealColor;
          uniform float uRevealGlow;
          uniform vec3 uRimColor;
          uniform float uRimStrength;
          uniform float uRimPower;
          uniform float uEmissiveBoost;
          uniform float uCharge;
          varying vec3 vGyroWorld;
          float gyroHash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
          float gyroNoise(vec3 p) {
            vec3 i = floor(p);
            vec3 f = fract(p);
            f = f * f * (3.0 - 2.0 * f);
            return mix(
              mix(mix(gyroHash(i), gyroHash(i + vec3(1, 0, 0)), f.x),
                  mix(gyroHash(i + vec3(0, 1, 0)), gyroHash(i + vec3(1, 1, 0)), f.x), f.y),
              mix(mix(gyroHash(i + vec3(0, 0, 1)), gyroHash(i + vec3(1, 0, 1)), f.x),
                  mix(gyroHash(i + vec3(0, 1, 1)), gyroHash(i + vec3(1, 1, 1)), f.x), f.y),
              f.z);
          }
        `
      );
      shader.fragmentShader = replaceChunk(
        shader.fragmentShader,
        '#include <clipping_planes_fragment>',
        /* glsl */ `
          #include <clipping_planes_fragment>
          // Torn, not round: the front is pushed about by two octaves of noise.
          vec3 gyroRel = vGyroWorld - uGyroCore;
          float gyroN = gyroNoise(vGyroWorld * 7.0) * 0.65 + gyroNoise(vGyroWorld * 19.0) * 0.35;
          float gyroBeyond = length(gyroRel) - uRevealR + (gyroN - 0.5) * uRevealWidth * 2.0;
          if (gyroBeyond > 0.0) discard;
        `
      );
      shader.fragmentShader = replaceChunk(
        shader.fragmentShader,
        '#include <emissivemap_fragment>',
        /* glsl */ `
          #include <emissivemap_fragment>
          {
            totalEmissiveRadiance *= uEmissiveBoost;
            float edge = 1.0 - smoothstep(0.0, uRevealWidth, -gyroBeyond);
            float rim = pow(1.0 - clamp(abs(dot(normalize(vNormal), normalize(vViewPosition))), 0.0, 1.0), uRimPower);
            totalEmissiveRadiance += uRevealColor * edge * uRevealGlow;
            totalEmissiveRadiance += uRimColor * rim * (uRimStrength + uCharge * 1.5);
          }
        `
      );
    },
    'gyroscope-body'
  );

  return material;
}
