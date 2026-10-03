import { AdditiveBlending, Color, MeshStandardMaterial, ShaderMaterial, Vector4 } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { frame, sharedUniforms } from '../core/FrameUniforms.js';
import { patchOnBeforeCompile } from '../utils/shaderPatch.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * Every shader the Amethyst Verdict brings with it.
 *
 *   - the **crystal**: the stones themselves, a real `MeshStandardMaterial`
 *     so they take the sun, the hall's probe and their own shadow, with the
 *     look of the reference amethyst patched in — deep violet at the foot,
 *     milky lilac cloud toward the point, white fracture veins inside it, and
 *     a light that wakes up in them as they charge;
 *   - the **circle**: the rite on the floor round the target — rune bands, a
 *     star strung between the sockets on its edge, a socket circle at every
 *     point of the star that each stone rises out of, and chevrons that run
 *     down the spokes toward the body when the stones are about to fall on it.
 */

const ADDITIVE = {
  transparent: true,
  depthWrite: false,
  blending: AdditiveBlending,
  toneMapped: false
};

/** Sockets the circle can draw. The settings clamp to this. */
export const MAX_SOCKETS = 8;

/* ---------------------------------------------------------------------- */
/* The crystal                                                              */
/* ---------------------------------------------------------------------- */

/**
 * @param {object} [options]
 * @param {boolean} [options.shard] the broken pieces: no charge of their own,
 *   only the afterglow of the blow
 */
export function createCrystalMaterial({ shard = false } = {}) {
  const material = new MeshStandardMaterial({
    name: shard ? 'AmethystShard' : 'Amethyst',
    color: 0xffffff,
    metalness: 0,
    roughness: 0.2,
    flatShading: false
  });

  const uniforms = {
    uGlobalGlow: frame.uGlobalGlow,
    uTime: frame.uTime,
    uColorDeep: { value: new Color() },
    uColorMid: { value: new Color() },
    uColorPale: { value: new Color() },
    uColorGlow: { value: new Color() },
    uColorVein: { value: new Color() },
    uCloud: { value: 1 },
    uVeins: { value: 1 },
    uInner: { value: 0.3 },
    uRim: { value: 0.5 },
    uCharge: { value: 0 },
    uFlash: { value: 0 },
    uSeed: { value: 0 }
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
           attribute vec3 aCrystal;
           varying vec3 vCrystal;
           varying vec3 vStone;`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           vCrystal = aCrystal;
           vStone = position;`
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           uniform float uGlobalGlow;
           uniform float uTime;
           uniform vec3 uColorDeep;
           uniform vec3 uColorMid;
           uniform vec3 uColorPale;
           uniform vec3 uColorGlow;
           uniform vec3 uColorVein;
           uniform float uCloud;
           uniform float uVeins;
           uniform float uInner;
           uniform float uRim;
           uniform float uCharge;
           uniform float uFlash;
           uniform float uSeed;
           varying vec3 vCrystal;
           varying vec3 vStone;
           ${noiseGLSL}`
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
           // The stone: violet at the foot, clouding to lilac toward the point,
           // every facet a shade off its neighbour.
           float cloud = clamp(vCrystal.x * uCloud, 0.0, 1.0);
           float facet = vCrystal.y;
           float height = vCrystal.z;
           vec3 sP = vStone * 3.0 + uSeed * 13.7;
           float mottle = snoise(sP * 1.7) * 0.5 + 0.5;
           // Dark inclusions, blotched through it at a finer grain.
           float blotch = smoothstep(0.15, 0.65, snoise(sP * 2.4 + 4.0) * 0.5 + 0.5 - cloud * 0.35);
           vec3 stone = mix(uColorDeep, uColorMid, smoothstep(0.1, 0.7, cloud * 0.6 + height * 0.5));
           stone = mix(stone, uColorDeep * 0.6, blotch * 0.7);
           stone = mix(stone, uColorPale, smoothstep(0.62, 0.95, cloud * 0.55 + mottle * 0.45 + height * 0.12) * 0.85);
           stone *= 0.62 + 0.6 * facet;
           diffuseColor.rgb = stone;`
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
           // Polished facets, frosted where it clouds.
           roughnessFactor = mix(0.08, 0.42, smoothstep(0.3, 0.9, cloud * 0.7 + mottle * 0.3));`
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
           {
             vec3 V = normalize(vViewPosition);
             float facing = abs(dot(normal, V));
             // Light held inside: strongest looking straight into a facet,
             // which is where a real point shows you its depth.
             float inner = pow(facing, 2.0) * (0.25 + 0.75 * mottle * mottle);
             // Fracture planes inside the stone, bright white seams.
             // Few of them, and only where the stone is milky.
             float vein = pow(max(0.0, 1.0 - abs(snoise(sP * 0.55 + vec3(0.0, uSeed, 0.0)))), 28.0);
             vein *= smoothstep(0.35, 0.8, cloud * 0.6 + mottle * 0.5);
             float rim = pow(1.0 - facing, 3.0);
             // As it charges the light comes up through it from the foot.
             float rise = smoothstep(0.0, 1.0, uCharge * 1.4 - (1.0 - height) * 0.4);
             float pulse = 0.85 + 0.15 * sin(uTime * 9.0 + uSeed * 6.0 + height * 5.0);
             float clear = 1.0 - blotch * 0.6;
             vec3 glow = uColorGlow * (inner * clear * (uInner + uCharge * 0.9 * rise) + rim * uRim * (0.35 + 0.6 * uCharge)) * pulse
                       + uColorVein * vein * uVeins * (0.15 + uCharge * 0.7)
                       + vec3(1.0) * uFlash * (0.6 + rim);
             totalEmissiveRadiance += glow * uGlobalGlow;
             // A lit stone stops looking like a dull one.
             diffuseColor.rgb *= 1.0 - 0.2 * clamp(uCharge, 0.0, 1.0);
           }`
        );
    },
    shard ? 'amethyst-shard' : 'amethyst'
  );

  material.userData.sync = () => {
    const c = settings.amethyst;
    uniforms.uColorDeep.value.copy(getColor(c.colorDeep));
    uniforms.uColorMid.value.copy(getColor(c.colorStone));
    uniforms.uColorPale.value.copy(getColor(c.colorPale));
    uniforms.uColorGlow.value.copy(getColor(c.colorGlow));
    uniforms.uColorVein.value.copy(getColor(c.colorVein));
    uniforms.uCloud.value = c.stoneCloud;
    uniforms.uVeins.value = c.stoneVeins;
    uniforms.uInner.value = c.stoneInner;
    uniforms.uRim.value = c.stoneRim;
    material.envMapIntensity = c.stoneEnv;
  };

  return material;
}

/* ---------------------------------------------------------------------- */
/* The circle                                                               */
/* ---------------------------------------------------------------------- */

const CIRCLE_VERTEX = /* glsl */ `
  uniform float uQuadSize;
  varying vec2 vP;
  void main() {
    vP = (uv - 0.5) * uQuadSize;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const CIRCLE_FRAGMENT = /* glsl */ `
  #define TAU 6.283185307179586
  #define PI 3.141592653589793
  #define MAX_SOCKETS ${MAX_SOCKETS}
  uniform float uTime;
  uniform float uRadius;
  uniform float uSocketR;
  uniform float uCount;
  uniform float uYaw;
  uniform float uDraw;
  uniform float uSpin;
  uniform float uConverge;
  uniform float uLock;
  uniform float uPulse;
  uniform float uFlare;
  uniform float uFade;
  uniform float uIntensity;
  uniform float uGlobalGlow;
  uniform vec4 uSockets[MAX_SOCKETS]; // x open, y flare, z spent, w unused
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform vec3 uColorC;
  varying vec2 vP;

  float band(float d, float w) { return 1.0 - smoothstep(w, w + 0.03, abs(d)); }
  float h11(float x) { return fract(sin(x * 127.1) * 43758.5453); }
  vec2 rot(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }

  float segment(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * h);
  }

  vec2 socketAt(float i) {
    float a = uYaw + i / uCount * TAU;
    return vec2(cos(a), sin(a)) * uRadius;
  }

  void main() {
    float R = max(0.3, uRadius);
    float r = length(vP);
    if (r > R + uSocketR * 1.6 + 0.3) discard;
    float a = atan(vP.y, vP.x);
    float a01 = fract((a - uYaw) / TAU);
    float t = uTime;

    // It writes itself round from the first socket.
    float drawn = 1.0 - smoothstep(uDraw * 1.05 - 0.03, uDraw * 1.05, a01);
    float writing = exp(-abs(a01 - uDraw * 1.05) * 50.0) * step(uDraw, 0.999);
    float grow = smoothstep(0.0, 0.35, uDraw);

    /* ---- the outer bands, and the runes between them ---- */
    float outer = band(r - R, 0.022) + band(r - (R - 0.36), 0.014) * 0.8 + band(r - (R + 0.12), 0.008) * 0.5;
    float aRune = a01 + t * uSpin * 0.04;
    float cell = floor(aRune * 72.0);
    float within = fract(aRune * 72.0);
    float runeH = mix(0.35, 1.0, h11(cell));
    float rune = step(R - 0.3, r) * step(r, R - 0.06)
               * step(0.2, within) * step(within, 0.8)
               * step(abs(r - (R - 0.18)), 0.1 * runeH) * step(0.3, h11(cell + 3.0));

    /* ---- the star strung between the sockets, and the polygon round them ---- */
    float star = 1e3;
    float ring = 1e3;
    float spokeD = 1e3;
    float chevron = 0.0;
    float sockets = 0.0;
    float socketFill = 0.0;
    float socketWrite = 0.0;
    vec2 dirIn = vec2(0.0);
    for (int k = 0; k < MAX_SOCKETS; k++) {
      float fk = float(k);
      if (fk >= uCount) break;
      vec2 s0 = socketAt(fk);
      vec2 s1 = socketAt(mod(fk + 1.0, uCount));
      vec2 s2 = socketAt(mod(fk + 2.0, uCount));
      ring = min(ring, segment(vP, s0, s1));
      star = min(star, segment(vP, s0, s2));

      // The spoke from the socket to the body, and the chevrons that run
      // down it when the stone is about to come.
      float sd = segment(vP, s0 * (1.0 - (uSocketR + 0.1) / R), vec2(0.0));
      spokeD = min(spokeD, sd);
      vec2 dir = normalize(-s0);
      float along = dot(vP - s0, dir);
      float across = dot(vP - s0, vec2(-dir.y, dir.x));
      float sAlong = along / R;
      if (sAlong > 0.12 && sAlong < 0.82) {
        float ph = fract(along * 1.6 - t * (1.2 + 3.5 * uConverge));
        // A V pointing inward.
        float v = abs(ph - 0.5 - abs(across) * 1.3);
        float chev = (1.0 - smoothstep(0.04, 0.09, v)) * step(abs(across), 0.32);
        chevron += chev * uConverge * (1.0 - uSockets[k].z) * smoothstep(0.12, 0.25, sAlong) * (1.0 - smoothstep(0.65, 0.82, sAlong));
      }

      /* the socket itself */
      vec4 S = uSockets[k];
      vec2 q = vP - s0;
      float rq = length(q);
      float aq = atan(q.y, q.x);
      float sr = uSocketR * (0.6 + 0.4 * smoothstep(0.0, 0.6, S.x));
      float open = S.x;
      float wq = smoothstep(open * 1.1 - 0.05, open * 1.1, fract(aq / TAU + 0.25 + fk * 0.13));
      float sRing = band(rq - sr, 0.02) * (1.0 - wq);
      float sInner = band(rq - sr * 0.72, 0.012) * open;
      float sTicks = band(rq - sr * 0.86, 0.035) * step(0.55, fract((aq + t * uSpin * (mod(fk, 2.0) * 2.0 - 1.0)) / TAU * 16.0)) * open;
      float sOuter = band(rq - sr * 1.25, 0.008) * open * 0.6;
      // A hex inside, turning against its neighbours.
      vec2 hq = rot(q, t * uSpin * 0.7 * (mod(fk, 2.0) * 2.0 - 1.0));
      float hex = 0.0;
      for (int e = 0; e < 6; e++) {
        float ang = float(e) * TAU / 6.0;
        hex = max(hex, dot(hq, vec2(cos(ang), sin(ang))));
      }
      float sHex = band(hex - sr * 0.5, 0.01) * open;
      float lit = 1.0 + S.y * 2.5;
      sockets += (sRing + sInner + sTicks + sOuter + sHex * 0.8) * lit * (1.0 - S.z * 0.7);
      // The well of light the stone comes up through.
      socketFill += exp(-rq * rq / (sr * sr) * 2.5) * (open * 0.35 + S.y * 1.2) * (1.0 - S.z);
      socketWrite += exp(-abs(rq - sr) * 25.0) * exp(-abs(fract(aq / TAU + 0.25 + fk * 0.13) - open * 1.1) * 40.0) * step(open, 0.999) * step(0.001, open);
    }

    float inside = 1.0 - smoothstep(R - 0.05, R, r);
    float starL = band(star, 0.012) * inside;
    float ringL = band(ring, 0.01) * 0.7;
    float spoke = band(spokeD, 0.006) * step(0.45, r) * 0.6;

    /* ---- the lock: a reticle round the body ---- */
    float Rl = 0.75 + 0.15 * (1.0 - uLock);
    float aL = a + t * uSpin * 1.6;
    float lockRing = band(r - Rl, 0.015) * step(0.35, fract(aL / TAU * 4.0));
    float lockTicks = band(r - Rl * 1.28, 0.05) * step(0.85, fract(aL / TAU * 24.0));
    float lockIn = band(r - Rl * 0.55, 0.01);
    float lockL = (lockRing + lockTicks * 0.8 + lockIn * 0.7) * uLock;

    /* ---- the wash, and the pulse of the blow ---- */
    float fill = pow(clamp(r / R, 0.0, 1.0), 5.0) * inside * 0.18;
    float pulseR = uPulse * (R + 0.5);
    float pulse = exp(-abs(r - pulseR) * 5.0) * (1.0 - uPulse) * step(0.001, uPulse);

    float lines = (outer + rune * 0.7 + starL + ringL + spoke) * drawn * grow;
    float glow = 0.8 + uFlare * 1.6 + uConverge * 0.6;
    vec3 col = uColorA * lines * glow
             + uColorB * (rune * 0.4 * drawn + sockets * 0.9 + lockL)
             + uColorC * (chevron * 1.6 + socketFill + pulse * 1.8 + writing * 2.5 * step(abs(r - R), 0.3) + socketWrite * 2.0)
             + uColorA * fill * drawn * (0.6 + uFlare);
    float k = uIntensity * uFade * uGlobalGlow;
    gl_FragColor = vec4(col * k, 1.0);
  }
`;

export function createCircleMaterial() {
  const material = new ShaderMaterial({
    uniforms: sharedUniforms({
      uQuadSize: { value: 10 },
      uRadius: { value: 3 },
      uSocketR: { value: 0.6 },
      uCount: { value: 6 },
      uYaw: { value: 0 },
      uDraw: { value: 0 },
      uSpin: { value: 0.4 },
      uConverge: { value: 0 },
      uLock: { value: 0 },
      uPulse: { value: 0 },
      uFlare: { value: 0 },
      uFade: { value: 1 },
      uIntensity: { value: 1 },
      uSockets: { value: Array.from({ length: MAX_SOCKETS }, () => new Vector4()) },
      uColorA: { value: new Color() },
      uColorB: { value: new Color() },
      uColorC: { value: new Color() }
    }),
    vertexShader: CIRCLE_VERTEX,
    fragmentShader: CIRCLE_FRAGMENT,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    ...ADDITIVE
  });

  material.userData.sync = (s) => {
    const c = settings.amethyst;
    const u = material.uniforms;
    u.uQuadSize.value = s.quad;
    u.uRadius.value = s.radius;
    u.uSocketR.value = s.socketRadius;
    u.uCount.value = s.count;
    u.uYaw.value = s.yaw;
    u.uDraw.value = s.draw;
    u.uSpin.value = c.circleSpin;
    u.uConverge.value = s.converge;
    u.uLock.value = s.lock;
    u.uPulse.value = s.pulse;
    u.uFlare.value = s.flare;
    u.uFade.value = s.fade;
    u.uIntensity.value = c.circleIntensity;
    for (let i = 0; i < MAX_SOCKETS; i++) {
      const socket = s.sockets[i];
      u.uSockets.value[i].set(socket?.open ?? 0, socket?.flare ?? 0, socket?.spent ?? 0, 0);
    }
    u.uColorA.value.copy(getColor(c.colorCircle));
    u.uColorB.value.copy(getColor(c.colorSocket));
    u.uColorC.value.copy(getColor(c.colorCharge));
  };

  return material;
}
