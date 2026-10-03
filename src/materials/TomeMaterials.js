import { AdditiveBlending, Color, DoubleSide, ShaderMaterial } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { patchOnBeforeCompile, replaceChunk } from '../utils/shaderPatch.js';

/**
 * Every shader the Astral Tome brings with it.
 *
 * The book itself is the modeller's — seven PBR materials cut in Blender. What
 * is built here is what turns it into an orrery:
 *
 *   - a **patch on the book** so it can *materialise*: it burns in out of
 *     nothing along a noisy front edged in blue fire, and its glyphs, gems and
 *     dial core flare as it charges;
 *   - a **sigil** on the floor, the circle the cast claims — a zodiac band of
 *     twelve houses, a star chart inside it, an octagram turning in the middle;
 *   - the **fan** of light that pours up out of the dial;
 *   - the **orbs**: one billboard for the star at the heart of the hologram,
 *     its planets, and the lights it throws — a hot core, a halo and, for the
 *     bodies that are *orbited*, a few thin rings round them;
 *   - and the **orbits**: thin lines of light, drawn round, with sparks of
 *     brightness running along them.
 */

const ADDITIVE = {
  transparent: true,
  depthWrite: false,
  blending: AdditiveBlending,
  toneMapped: false
};

const QUAD_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/* ---------------------------------------------------------------------- */
/* The orbs                                                                 */
/* ---------------------------------------------------------------------- */

const ORB_FRAGMENT = /* glsl */ `
  #define TAU 6.283185307179586
  uniform float uTime;
  uniform float uIntensity;
  uniform float uRings;
  uniform float uRingAmt;
  uniform float uFlare;
  uniform float uSeed;
  uniform float uOpacity;
  uniform float uGlobalGlow;
  uniform vec3 uColorCore;
  uniform vec3 uColorGlow;
  varying vec2 vUv;

  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    float a = atan(p.y, p.x);
    float t = uTime;

    float core = exp(-r * r * 60.0);
    float body = exp(-r * r * 14.0) * 0.8;
    float halo = exp(-r * 4.5) * 0.45;

    // Rings round it: thin, each turning its own way, each broken into arcs.
    float rings = 0.0;
    for (int k = 0; k < 4; k++) {
      float fk = float(k);
      if (fk >= uRings) break;
      float R = 0.34 + fk * 0.16;
      float line = exp(-pow((r - R) / 0.012, 2.0));
      float dir = mod(fk, 2.0) * 2.0 - 1.0;
      float arcs = smoothstep(0.15, 0.4, sin(a * (2.0 + fk) + t * dir * (0.8 + fk * 0.4) + uSeed + fk));
      rings += line * mix(0.35, 1.0, arcs);
    }

    // A four-point glint across it, the shape of a star seen through a lens.
    float flare = (exp(-abs(p.y) * 70.0) + exp(-abs(p.x) * 70.0)) * exp(-r * 3.5) * uFlare;

    vec3 col = uColorCore * (core * 3.0 + flare)
             + mix(uColorGlow, uColorCore, 0.45) * body
             + uColorGlow * halo
             + mix(uColorGlow, uColorCore, 0.6) * rings * uRingAmt * 1.4;
    float edge = 1.0 - smoothstep(0.85, 1.0, r);
    gl_FragColor = vec4(col * uIntensity * uOpacity * uGlobalGlow * edge, 1.0);
  }
`;

export function createOrbMaterial() {
  return new ShaderMaterial({
    uniforms: sharedUniforms({
      uIntensity: { value: 1 },
      uRings: { value: 0 },
      uRingAmt: { value: 0 },
      uFlare: { value: 0.5 },
      uSeed: { value: Math.random() * 10 },
      uOpacity: { value: 1 },
      uColorCore: { value: new Color('#ffffff') },
      uColorGlow: { value: new Color('#2f8bff') }
    }),
    vertexShader: QUAD_VERTEX,
    fragmentShader: ORB_FRAGMENT,
    ...ADDITIVE
  });
}

/* ---------------------------------------------------------------------- */
/* The orbits                                                               */
/* ---------------------------------------------------------------------- */

const ORBIT_FRAGMENT = /* glsl */ `
  #define TAU 6.283185307179586
  uniform float uTime;
  uniform float uIntensity;
  uniform float uWidth;
  uniform float uReveal;
  uniform float uSpeed;
  uniform float uSeed;
  uniform float uOpacity;
  uniform float uGlobalGlow;
  uniform vec3 uColorLine;
  uniform vec3 uColorSpark;
  varying vec2 vUv;

  void main() {
    vec2 p = (vUv * 2.0 - 1.0) * 1.15;
    float r = length(p);
    float a01 = atan(p.y, p.x) / TAU + 0.5;

    // Drawn round from where it starts, with a hot tip where it is being drawn.
    float u = fract(a01 + uSeed);
    float drawn = 1.0 - smoothstep(uReveal - 0.02, uReveal, u);
    float tip = exp(-abs(u - uReveal) * 80.0) * step(uReveal, 0.999);

    float d = abs(r - 1.0);
    float line = exp(-pow(d / uWidth, 2.0));
    float glow = exp(-d / (uWidth * 6.0)) * 0.25;

    // Fine ticks, and bright pulses running round it.
    float ticks = 0.75 + 0.25 * step(0.5, fract(u * 90.0));
    float run = fract(u * 3.0 - uTime * uSpeed);
    float pulse = pow(run, 18.0) * 2.5;

    vec3 col = uColorLine * (line * ticks + glow) * drawn
             + uColorSpark * (line * pulse * drawn + tip * line * 3.0);
    gl_FragColor = vec4(col * uIntensity * uOpacity * uGlobalGlow, 1.0);
  }
`;

export function createOrbitMaterial() {
  return new ShaderMaterial({
    uniforms: sharedUniforms({
      uIntensity: { value: 1 },
      uWidth: { value: 0.01 },
      uReveal: { value: 1 },
      uSpeed: { value: 0.3 },
      uSeed: { value: Math.random() },
      uOpacity: { value: 1 },
      uColorLine: { value: new Color('#59b8ff') },
      uColorSpark: { value: new Color('#e6f6ff') }
    }),
    vertexShader: QUAD_VERTEX,
    fragmentShader: ORBIT_FRAGMENT,
    side: DoubleSide,
    ...ADDITIVE
  });
}

/* ---------------------------------------------------------------------- */
/* The fan                                                                  */
/* ---------------------------------------------------------------------- */

const FAN_VERTEX = /* glsl */ `
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

const FAN_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uIntensity;
  uniform float uRise;
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
    float y = vUv.y;
    if (y > uRise) discard;

    // Rays fanning up out of the dial, each flickering on its own.
    float ray = snoise(vec3(vUv.x * 46.0, t * 1.3, 0.0)) * 0.5 + 0.5;
    ray = pow(ray, 4.0) * 1.6 + 0.15;
    // Scanlines climbing it, so it reads as projected rather than poured.
    float scan = 0.75 + 0.25 * sin((y - t * 0.45) * 70.0);

    float facing = abs(dot(normalize(vNormalV), normalize(vViewV)));
    float shell = pow(1.0 - facing, 1.4) * 0.7 + 0.3;
    float fade = pow(1.0 - y, 1.6) * smoothstep(0.0, 0.04, y);
    float front = exp(-(uRise - y) * 30.0) * step(uRise, 0.999);

    vec3 col = mix(uColor, uColorCore, ray * 0.4 + front) * (ray * scan * shell + front * 2.0);
    gl_FragColor = vec4(col * fade * uIntensity * uOpacity * uGlobalGlow, 1.0);
  }
`;

export function createFanMaterial() {
  return new ShaderMaterial({
    uniforms: sharedUniforms({
      uIntensity: { value: 0 },
      uRise: { value: 1 },
      uOpacity: { value: 1 },
      uColor: { value: new Color('#2a7bff') },
      uColorCore: { value: new Color('#e8f7ff') }
    }),
    vertexShader: FAN_VERTEX,
    fragmentShader: FAN_FRAGMENT,
    side: DoubleSide,
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
  uniform float uIntensity;
  uniform float uOpacity;
  uniform float uGlobalGlow;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  varying vec2 vP;

  float band(float d, float w) { return 1.0 - smoothstep(w, w + 0.03, abs(d)); }
  float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  vec2 rot(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }

  // Distance to the outline of a square of half-size h.
  float square(vec2 p, float h) { vec2 d = abs(p) - h; return max(d.x, d.y); }

  void main() {
    float R = max(0.5, uRadius);
    float r = length(vP);
    if (r > R + 0.8) discard;
    float a = atan(vP.y, vP.x);
    float a01 = a / TAU + 0.5;
    float t = uTime;

    float sweep = uReveal * 1.06;
    float drawn = 1.0 - smoothstep(sweep - 0.03, sweep, a01);
    float writing = exp(-abs(a01 - sweep) * 70.0) * step(uReveal, 0.999);

    /* the zodiac band: two rings, twelve houses, a mark in every house */
    float Rb = R - 0.42;
    float rings = band(r - R, 0.025) + band(r - Rb, 0.018) + band(r - (R + 0.12), 0.008) * 0.6;
    float az = a01 + t * uSpin * 0.03;
    float house = floor(az * 12.0);
    float within = fract(az * 12.0);
    float divide = step(0.985, abs(within - 0.5) * 2.0) * step(Rb, r) * step(r, R);
    // A small sign in each: a circle of a size, and a stroke off it.
    vec2 cellC = vec2(cos((house + 0.5) / 12.0 * TAU - t * uSpin * 0.03 * TAU - PI),
                      sin((house + 0.5) / 12.0 * TAU - t * uSpin * 0.03 * TAU - PI)) * (R - 0.21);
    vec2 q = vP - cellC;
    float hs = h21(vec2(house, 3.1));
    float mark = band(length(q) - mix(0.06, 0.11, hs), 0.012);
    vec2 qd = rot(q, hs * TAU);
    mark += band(qd.y, 0.01) * step(abs(qd.x), 0.15) * step(0.4, h21(vec2(house, 7.7)));
    mark *= step(Rb, r) * step(r, R);

    /* the star chart inside it: points of light on a jittered grid */
    vec2 g = vP * 2.2;
    vec2 cell = floor(g);
    vec2 jitter = vec2(h21(cell), h21(cell + 11.0)) - 0.5;
    float star = exp(-length(fract(g) - 0.5 - jitter * 0.6) * 26.0) * step(0.55, h21(cell + 4.0));
    star *= step(r, Rb - 0.1) * (0.6 + 0.4 * sin(t * 3.0 + h21(cell) * 30.0));

    /* an octagram turning in the middle, and a ring round it */
    float Ri = R * 0.42;
    vec2 o = rot(vP, t * uSpin * 0.25);
    float oct = band(square(o, Ri * 0.7), 0.014) + band(square(rot(o, PI * 0.25), Ri * 0.7), 0.014);
    oct *= step(r, Ri + 0.05);
    float inner = band(r - Ri, 0.016) + band(r - Ri * 0.35, 0.012);

    /* charge running out from the middle to the rim on every throw */
    float pulseR = mix(R, R * 0.1, uPulse);
    float inside = 1.0 - smoothstep(R - 0.04, R, r);
    float pulse = exp(-abs(r - pulseR) * 5.0) * uPulse * inside;
    float wash = pow(clamp(r / R, 0.0, 1.0), 5.0) * inside * 0.18;

    float lines = (rings + divide * 0.7 + mark * 0.85 + oct * 0.8 + inner) * drawn;
    float glow = 0.7 + 0.6 * uCharge;
    vec3 col = uColorA * (lines * glow + wash * (0.5 + uCharge))
             + uColorB * (star * drawn * (0.5 + uCharge) + mark * drawn * 0.4 * uCharge + pulse * 1.3)
             + uColorB * writing * 3.0 * step(abs(r - R), 0.5);
    gl_FragColor = vec4(col * uIntensity * uOpacity * uGlobalGlow, 1.0);
  }
`;

export function createTomeSigilMaterial() {
  return new ShaderMaterial({
    uniforms: sharedUniforms({
      uQuadSize: { value: 14 },
      uRadius: { value: 6 },
      uReveal: { value: 0 },
      uCharge: { value: 0 },
      uPulse: { value: 0 },
      uSpin: { value: 0.3 },
      uIntensity: { value: 1 },
      uOpacity: { value: 1 },
      uColorA: { value: new Color('#3d8bff') },
      uColorB: { value: new Color('#d8f1ff') }
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
/* The book                                                                 */
/* ---------------------------------------------------------------------- */

/**
 * The uniforms one tome's materials share, so a single write dresses the whole
 * book. Hand the same object to `patchTomeBody` for every material on it.
 */
export function createTomeBodyUniforms() {
  return {
    uMaterialise: { value: 1 },
    uEdgeWidth: { value: 0.08 },
    uEdgeColor: { value: new Color('#5fb4ff') },
    uEdgeGlow: { value: 6 },
    uEmissiveBoost: { value: 1 },
    uRimColor: { value: new Color('#3d8bff') },
    uRimStrength: { value: 0.2 }
  };
}

/**
 * Materialising, a blue rim, and a charge that lights the glyphs.
 *
 * `uMaterialise` runs 0 → 1: at 0 nothing of the book is there, at 1 all of
 * it, and in between a front pushed about by noise burns across it in the
 * book's own frame — so the book materialises the same way at any size.
 * Run it backwards to unmake it.
 */
export function patchTomeBody(material, uniforms) {
  patchOnBeforeCompile(
    material,
    (shader) => {
      Object.assign(shader.uniforms, uniforms);

      shader.vertexShader = replaceChunk(
        shader.vertexShader,
        '#include <common>',
        /* glsl */ `
          #include <common>
          varying vec3 vTomeLocal;
        `
      );
      shader.vertexShader = replaceChunk(
        shader.vertexShader,
        '#include <begin_vertex>',
        /* glsl */ `
          #include <begin_vertex>
          vTomeLocal = transformed;
        `
      );

      shader.fragmentShader = replaceChunk(
        shader.fragmentShader,
        '#include <common>',
        /* glsl */ `
          #include <common>
          uniform float uMaterialise;
          uniform float uEdgeWidth;
          uniform vec3 uEdgeColor;
          uniform float uEdgeGlow;
          uniform float uEmissiveBoost;
          uniform vec3 uRimColor;
          uniform float uRimStrength;
          varying vec3 vTomeLocal;
          float tomeHash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
          float tomeNoise(vec3 p) {
            vec3 i = floor(p);
            vec3 f = fract(p);
            f = f * f * (3.0 - 2.0 * f);
            return mix(
              mix(mix(tomeHash(i), tomeHash(i + vec3(1, 0, 0)), f.x),
                  mix(tomeHash(i + vec3(0, 1, 0)), tomeHash(i + vec3(1, 1, 0)), f.x), f.y),
              mix(mix(tomeHash(i + vec3(0, 0, 1)), tomeHash(i + vec3(1, 0, 1)), f.x),
                  mix(tomeHash(i + vec3(0, 1, 1)), tomeHash(i + vec3(1, 1, 1)), f.x), f.y),
              f.z);
          }
        `
      );
      shader.fragmentShader = replaceChunk(
        shader.fragmentShader,
        '#include <clipping_planes_fragment>',
        /* glsl */ `
          #include <clipping_planes_fragment>
          // Noise in the book's own metre, leaning the front so it sweeps up
          // from the foot rather than appearing in confetti.
          float tomeN = tomeNoise(vTomeLocal * 9.0) * 0.6 + tomeNoise(vTomeLocal * 23.0) * 0.4;
          tomeN = mix(tomeN, clamp(vTomeLocal.y * 1.4 + 0.5, 0.0, 1.0), 0.3);
          float tomeLeft = uMaterialise * (1.0 + uEdgeWidth * 2.0) - uEdgeWidth - tomeN;
          if (tomeLeft < 0.0) discard;
        `
      );
      shader.fragmentShader = replaceChunk(
        shader.fragmentShader,
        '#include <emissivemap_fragment>',
        /* glsl */ `
          #include <emissivemap_fragment>
          {
            totalEmissiveRadiance *= uEmissiveBoost;
            float edge = 1.0 - smoothstep(0.0, uEdgeWidth, tomeLeft);
            float rim = pow(1.0 - clamp(abs(dot(normalize(vNormal), normalize(vViewPosition))), 0.0, 1.0), 3.0);
            totalEmissiveRadiance += uEdgeColor * edge * uEdgeGlow;
            totalEmissiveRadiance += uRimColor * rim * uRimStrength;
          }
        `
      );
    },
    'tome-body'
  );
  return material;
}
