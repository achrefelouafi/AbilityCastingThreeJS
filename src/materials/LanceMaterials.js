import { AdditiveBlending, Color, DoubleSide, ShaderMaterial, Vector3 } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';

/**
 * Every shader the Starbreaker Lance brings with it.
 *
 *   - the **beam**: an open cylinder laid along the shot and shaded by how
 *     squarely it faces the eye, so three nested ones — a white core, a cyan
 *     sheath full of striations racing downrange, a wide violet glow — read as
 *     one volume of light from any angle but straight down its axis;
 *   - the **ribbons**: an instanced strip per streamer, wound round the beam
 *     as a helix *in the vertex shader* and turned to the camera there, so the
 *     whole tornado is one draw call and the CPU never touches a vertex;
 *   - the **flare**: a camera-facing star — hot core, ragged rays, a ring
 *     thrown out — used both at the hands and where the beam lands;
 *   - the **sigil**: a procedural magic circle (rings, an octagram, a band of
 *     runes) that writes itself in a sweep, for the floor and for the hands.
 */

const ADDITIVE = {
  transparent: true,
  depthWrite: false,
  blending: AdditiveBlending,
  toneMapped: false
};

/* ---------------------------------------------------------------------- */
/* The beam                                                                 */
/* ---------------------------------------------------------------------- */

const BEAM_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uLength;
  uniform float uRadius;
  uniform float uStartScale;
  uniform float uTaper;
  uniform float uBulge;
  uniform float uWobble;
  uniform float uSeed;

  varying vec3 vNormalW;
  varying vec3 vViewDir;
  varying float vAlong;
  varying float vAround;

  ${noiseGLSL}

  void main() {
    float t = position.y;               // 0 at the hands, 1 at the mark
    float s = t * uLength;              // metres
    vAlong = t;
    vAround = uv.x;

    // Narrow where it leaves the hands, swelling into the mark.
    float r = uRadius * mix(uStartScale, 1.0, smoothstep(0.0, max(0.01, uTaper), s));
    r *= 1.0 + uBulge * smoothstep(uLength - 2.2, uLength, s);
    // A beam this hot does not hold a ruler line: the skin boils.
    float n = snoise(vec3(uv.x * 6.0, s * 0.9 - uTime * 7.0, uSeed));
    r *= 1.0 + uWobble * n;

    vec3 radial = normalize(vec3(position.x, 0.0, position.z));
    vec3 local = vec3(radial.x * r, s, radial.z * r);
    vec4 world = modelMatrix * vec4(local, 1.0);
    vNormalW = normalize(mat3(modelMatrix) * radial);
    vViewDir = normalize(cameraPosition - world.xyz);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const BEAM_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uLength;
  uniform float uHead;
  uniform float uTail;
  uniform float uIntensity;
  uniform float uPower;
  uniform float uStreaks;
  uniform float uStreakFreq;
  uniform float uStreakSpeed;
  uniform float uOpacity;
  uniform float uSeed;
  uniform float uGlobalGlow;
  uniform vec3 uColorA;
  uniform vec3 uColorB;

  varying vec3 vNormalW;
  varying vec3 vViewDir;
  varying float vAlong;
  varying float vAround;

  ${noiseGLSL}

  void main() {
    if (vAlong > uHead || vAlong < uTail) discard;
    float s = vAlong * uLength;

    float facing = abs(dot(normalize(vNormalW), normalize(vViewDir)));
    float body = pow(facing, uPower);

    // Striations streaming downrange — stretched along the axis, so they read
    // as energy moving rather than as a texture on a tube.
    float streak = snoise01(vec3(vAround * 9.0, s * uStreakFreq - uTime * uStreakSpeed, uSeed));
    streak = mix(1.0, 0.35 + 1.3 * streak * streak, uStreaks);

    // The head burns hottest; the tail, as it is pulled in, too.
    float head = exp(-(uHead - vAlong) * uLength * 1.6) * step(uHead, 0.999);
    float tail = exp(-(vAlong - uTail) * uLength * 2.5) * step(0.001, uTail);
    // Feather the ends so the open cylinder never shows its rim. Once it has
    // landed the last metre and a half melts into the star over the mark;
    // while it travels the head stays crisp.
    float toHead = (uHead - vAlong) * uLength;
    float feather = uHead >= 0.999 ? 1.6 : 0.15;
    float ends = smoothstep(0.0, 0.3, (vAlong - uTail) * uLength) * smoothstep(0.0, feather, toHead);

    vec3 col = mix(uColorB, uColorA, body);
    float a = body * streak * (1.0 + head * 1.5 + tail * 1.0) * ends;
    gl_FragColor = vec4(col * a * uIntensity * uOpacity * uGlobalGlow, 1.0);
  }
`;

/**
 * One layer of the beam. The geometry is a unit open cylinder on +Y from 0 to
 * 1 (see `LanceAbility`); the shader scales it to `uLength` × `uRadius`.
 */
export function createBeamMaterial({ power = 2, streaks = 1 } = {}) {
  return new ShaderMaterial({
    uniforms: sharedUniforms({
      uLength: { value: 1 },
      uRadius: { value: 0.3 },
      uStartScale: { value: 0.4 },
      uTaper: { value: 1.5 },
      uBulge: { value: 0.5 },
      uWobble: { value: 0.05 },
      uHead: { value: 1 },
      uTail: { value: 0 },
      uIntensity: { value: 1 },
      uPower: { value: power },
      uStreaks: { value: streaks },
      uStreakFreq: { value: 0.6 },
      uStreakSpeed: { value: 30 },
      uOpacity: { value: 1 },
      uSeed: { value: Math.random() * 10 },
      uColorA: { value: new Color('#ffffff') },
      uColorB: { value: new Color('#3d8bff') }
    }),
    vertexShader: BEAM_VERTEX,
    fragmentShader: BEAM_FRAGMENT,
    side: DoubleSide,
    ...ADDITIVE
  });
}

/* ---------------------------------------------------------------------- */
/* The ribbons                                                              */
/* ---------------------------------------------------------------------- */

const RIBBON_VERTEX = /* glsl */ `
  #define TAU 6.283185307179586
  uniform float uTime;
  uniform vec3 uStart;
  uniform vec3 uDir;
  uniform vec3 uRight;
  uniform vec3 uUp;
  uniform float uLength;
  uniform float uBehind;
  uniform float uRadius;
  uniform float uFlare;
  uniform float uFlareLength;
  uniform float uBulge;
  uniform float uTwist;
  uniform float uSpin;
  uniform float uWidth;
  uniform float uSpread;

  attribute float aPhase;
  attribute float aRadius;
  attribute float aTwist;
  attribute float aWidth;
  attribute float aHue;
  attribute float aSpeed;

  varying float vSide;
  varying float vS;
  varying float vHue;
  varying float vSeed;

  float radiusAt(float s) {
    // Wide where it leaves the caster — the tornado round the hands — tight
    // down the length of the shot, and opening again into the blast.
    float near = 1.0 - smoothstep(0.0, max(0.1, uFlareLength), s);
    float behind = smoothstep(0.0, uBehind + 0.001, -s);
    float r = uRadius * aRadius * (1.0 + uFlare * near * near + uFlare * 0.6 * behind);
    r *= 1.0 + uBulge * smoothstep(uLength - 2.5, uLength, s);
    return r * uSpread;
  }

  vec3 centreAt(float s) {
    float th = aPhase + s * uTwist * aTwist * TAU - uTime * uSpin * aSpeed;
    // Behind the caster the strands sweep back out round it, not straight on.
    vec3 axis = uStart + uDir * max(s, -uBehind * 0.35);
    return axis + (uRight * cos(th) + uUp * sin(th)) * radiusAt(s);
  }

  void main() {
    float t = position.x;
    float side = position.y;
    float s = mix(-uBehind, uLength, t);
    vSide = side;
    vS = s;
    vHue = aHue;
    vSeed = aPhase;

    vec3 c = centreAt(s);
    vec3 tangent = normalize(centreAt(s + 0.05) - c);
    vec3 view = normalize(cameraPosition - c);
    vec3 across = normalize(cross(tangent, view));

    // Thin at both ends, fullest just past the hands.
    float taper = smoothstep(-uBehind, -uBehind + 1.2, s) * (1.0 - 0.6 * smoothstep(uLength * 0.6, uLength, s));
    float w = uWidth * aWidth * (0.25 + taper);
    vec3 p = c + across * side * w;
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }
`;

const RIBBON_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uLength;
  uniform float uBehind;
  uniform float uHead;
  uniform float uTail;
  uniform float uIntensity;
  uniform float uOpacity;
  uniform float uGlobalGlow;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform vec3 uColorC;

  varying float vSide;
  varying float vS;
  varying float vHue;
  varying float vSeed;

  ${noiseGLSL}

  void main() {
    // Strands are drawn out with the head and pulled in with the tail.
    if (vS > uHead * uLength || vS < mix(-uBehind, uLength, uTail)) discard;

    float edge = 1.0 - vSide * vSide;
    float core = pow(edge, 6.0);
    float soft = pow(edge, 1.5);

    // Broken into flowing dashes so a strand reads as moving, not painted.
    float flow = snoise01(vec3(vS * 0.55 - uTime * 6.0, vSeed * 3.1, 0.0));
    flow = smoothstep(0.15, 0.85, flow);

    float ends = smoothstep(-uBehind, -uBehind + 1.4, vS) * (1.0 - smoothstep(uLength - 0.4, uLength + 0.4, vS));
    vec3 hue = vHue < 0.5 ? mix(uColorA, uColorB, vHue * 2.0) : mix(uColorB, uColorC, vHue * 2.0 - 1.0);
    vec3 col = hue * soft * 0.8 + vec3(1.0) * core * 0.3;
    float a = (0.35 + 0.65 * flow) * ends;
    gl_FragColor = vec4(col * a * uIntensity * uOpacity * uGlobalGlow, 1.0);
  }
`;

export function createRibbonMaterial() {
  return new ShaderMaterial({
    uniforms: sharedUniforms({
      uStart: { value: new Vector3() },
      uDir: { value: new Vector3(0, 0, 1) },
      uRight: { value: new Vector3(1, 0, 0) },
      uUp: { value: new Vector3(0, 1, 0) },
      uLength: { value: 10 },
      uBehind: { value: 2 },
      uRadius: { value: 0.5 },
      uFlare: { value: 2 },
      uFlareLength: { value: 4 },
      uBulge: { value: 1 },
      uTwist: { value: 0.3 },
      uSpin: { value: 6 },
      uWidth: { value: 0.1 },
      uSpread: { value: 1 },
      uHead: { value: 1 },
      uTail: { value: 0 },
      uIntensity: { value: 2 },
      uOpacity: { value: 1 },
      uColorA: { value: new Color('#c86bff') },
      uColorB: { value: new Color('#5fd0ff') },
      uColorC: { value: new Color('#ff7ad9') }
    }),
    vertexShader: RIBBON_VERTEX,
    fragmentShader: RIBBON_FRAGMENT,
    side: DoubleSide,
    ...ADDITIVE
  });
}

/* ---------------------------------------------------------------------- */
/* The flare                                                                */
/* ---------------------------------------------------------------------- */

const BILLBOARD_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    // Turned to the camera here: the quad's own corners, laid along the view's
    // right and up, round the object's world position and scale.
    vec3 centre = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    float size = length(modelMatrix[0].xyz);
    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    vec3 p = centre + (right * position.x + up * position.y) * size;
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }
`;

const FLARE_FRAGMENT = /* glsl */ `
  #define TAU 6.283185307179586
  uniform float uTime;
  uniform float uIntensity;
  uniform float uCore;
  uniform float uRays;
  uniform float uRayCount;
  uniform float uRing;
  uniform float uRingWidth;
  uniform float uSeed;
  uniform float uOpacity;
  uniform float uGlobalGlow;
  uniform vec3 uColorCore;
  uniform vec3 uColorGlow;
  uniform vec3 uColorRing;
  varying vec2 vUv;
  ${noiseGLSL}

  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    if (r > 1.0) discard;
    float a = atan(p.y, p.x);

    float core = exp(-r * r * mix(120.0, 14.0, uCore));
    float halo = exp(-r * mix(10.0, 3.6, uCore)) * 0.6;

    // Ragged rays that never sit still.
    float ray = snoise(vec3(cos(a) * uRayCount * 0.35, sin(a) * uRayCount * 0.35, uTime * 3.0 + uSeed));
    ray = pow(max(0.0, ray), 3.0) * 3.0;
    float spikes = pow(abs(cos(a * 2.0 + uSeed)), 60.0) * 1.2;
    float rays = (ray + spikes) * exp(-r * 3.2) * uRays;

    // The ring it throws out, 0..1 across the quad.
    float ring = 0.0;
    if (uRing > 0.001 && uRing < 0.999) {
      float d = abs(r - uRing * 0.95);
      ring = exp(-d * d / max(1e-4, uRingWidth * uRingWidth)) * (1.0 - uRing);
    }

    float edge = 1.0 - smoothstep(0.75, 1.0, r);
    vec3 col = uColorCore * core * 1.6 + uColorGlow * (halo * 0.7 + rays * 0.6) + uColorRing * ring * 0.8;
    gl_FragColor = vec4(col * edge * uIntensity * uOpacity * uGlobalGlow, 1.0);
  }
`;

export function createFlareMaterial() {
  return new ShaderMaterial({
    uniforms: sharedUniforms({
      uIntensity: { value: 1 },
      uCore: { value: 0.5 },
      uRays: { value: 1 },
      uRayCount: { value: 9 },
      uRing: { value: 0 },
      uRingWidth: { value: 0.05 },
      uSeed: { value: Math.random() * 10 },
      uOpacity: { value: 1 },
      uColorCore: { value: new Color('#ffffff') },
      uColorGlow: { value: new Color('#5fb8ff') },
      uColorRing: { value: new Color('#c8a0ff') }
    }),
    vertexShader: BILLBOARD_VERTEX,
    fragmentShader: FLARE_FRAGMENT,
    depthTest: true,
    ...ADDITIVE
  });
}

/* ---------------------------------------------------------------------- */
/* The sigil                                                                */
/* ---------------------------------------------------------------------- */

const QUAD_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SIGIL_FRAGMENT = /* glsl */ `
  #define TAU 6.283185307179586
  #define PI 3.141592653589793
  uniform float uTime;
  uniform float uDraw;
  uniform float uSpin;
  uniform float uFlare;
  uniform float uFade;
  uniform float uIntensity;
  uniform float uLine;
  uniform float uSeed;
  uniform float uGlobalGlow;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  varying vec2 vUv;

  float hash(float n) { return fract(sin(n * 127.1 + uSeed) * 43758.5453); }

  float segment(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * h);
  }

  float stroke(float d, float w) {
    float aa = fwidth(d) * 1.2;
    return 1.0 - smoothstep(w - aa, w + aa, d);
  }

  mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    if (r > 1.0) discard;
    float w = uLine;

    // The circle writes itself as a sweep round from the top.
    float ang = fract(atan(p.x, p.y) / TAU + 1.0);
    float written = step(ang, uDraw) + step(0.999, uDraw);
    float drawn = clamp(written, 0.0, 1.0);

    /* --- gold: the frame --- */
    float gold = 0.0;
    gold += stroke(abs(r - 0.96), w * 1.3);
    gold += stroke(abs(r - 0.88), w * 0.8);
    gold += stroke(abs(r - 0.42), w);

    // An octagram {8/3}, turning slowly one way.
    vec2 q = rot(uTime * uSpin) * p;
    float star = 1e3;
    for (int i = 0; i < 8; i++) {
      float a0 = float(i) / 8.0 * TAU;
      float a1 = float(i + 3) / 8.0 * TAU;
      star = min(star, segment(q, 0.88 * vec2(sin(a0), cos(a0)), 0.88 * vec2(sin(a1), cos(a1))));
    }
    gold += stroke(star, w * 0.9);

    /* --- blue: the runes, turning the other way --- */
    float blue = 0.0;
    vec2 k = rot(-uTime * uSpin * 1.6) * p;
    float rk = length(k);
    blue += stroke(abs(rk - 0.62), w * 0.7);
    blue += stroke(abs(rk - 0.78), w * 0.7);
    float ak = fract(atan(k.x, k.y) / TAU + 1.0);
    float cells = 28.0;
    float cell = floor(ak * cells);
    vec2 g = vec2(fract(ak * cells) * 2.0 - 1.0, (rk - 0.70) / 0.07);
    if (abs(g.y) < 1.0) {
      // A rune is three strokes on a 3×3 lattice, chosen by the cell's hash.
      float rune = 1e3;
      for (int j = 0; j < 3; j++) {
        float h0 = hash(cell * 7.0 + float(j) * 3.1);
        float h1 = hash(cell * 5.0 + float(j) * 1.7 + 11.0);
        vec2 a = vec2(floor(h0 * 3.0) - 1.0, floor(fract(h0 * 7.0) * 3.0) - 1.0) * 0.6;
        vec2 b = vec2(floor(h1 * 3.0) - 1.0, floor(fract(h1 * 7.0) * 3.0) - 1.0) * 0.6;
        rune = min(rune, segment(g, a, b));
      }
      blue += stroke(rune * 0.07, w * 0.55);
    }
    // Inner disc of fine concentric light.
    blue += stroke(abs(r - 0.22), w * 0.6) + exp(-r * r * 40.0) * 0.6;
    blue += smoothstep(0.42, 0.0, r) * 0.08 * (0.6 + 0.4 * sin(r * 60.0 - uTime * 6.0));

    // Ticks round the rim.
    float ta = fract(atan(p.x, p.y) / TAU * 72.0 + 1.0);
    blue += stroke(abs(ta - 0.5) * 0.05, w * 0.35) * step(0.885, r) * step(r, 0.955);

    float glow = (1.0 + uFlare * 1.0);
    vec3 col = uColorA * min(gold, 1.5) * 1.1 + uColorB * min(blue, 1.5) * 1.4;
    gl_FragColor = vec4(col * drawn * glow * uFade * uIntensity * uGlobalGlow, 1.0);
  }
`;

export function createSigilMaterial() {
  return new ShaderMaterial({
    uniforms: sharedUniforms({
      uDraw: { value: 0 },
      uSpin: { value: 0.3 },
      uFlare: { value: 0 },
      uFade: { value: 1 },
      uIntensity: { value: 1 },
      uLine: { value: 0.008 },
      uSeed: { value: Math.random() * 10 },
      uColorA: { value: new Color('#e8c27a') },
      uColorB: { value: new Color('#8fd4ff') }
    }),
    vertexShader: QUAD_VERTEX,
    fragmentShader: SIGIL_FRAGMENT,
    side: DoubleSide,
    ...ADDITIVE
  });
}
