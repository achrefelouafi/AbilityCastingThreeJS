import { Color, DoubleSide, MeshStandardMaterial, NormalBlending, ShaderMaterial, Vector3, Vector4 } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { frame, sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { patchOnBeforeCompile } from '../utils/shaderPatch.js';
import { STONE_PARS, stoneUniforms, syncStone } from './MonolithStoneMaterial.js';

/**
 * Everything the Abyssal Maw draws that is not a particle.
 *
 * The ability is two holes of deep water torn in the floor, a rock, and a
 * shark, and the materials are built around the one decision that makes the
 * holes read as holes: **the floor is actually cut** (`world/FloorHoles.js`).
 * Under each opening there is a well of water with the shark in it, so the
 * surface is drawn the way water is — mostly see-through head-on, a mirror at
 * a graze — and what is under it is really there, fogged by depth.
 *
 *   - **the portal**: one floor quad per opening carrying the whole surface —
 *     the water, its foam, the torn lip of stone, the wet stain around it, the
 *     cracks it opened along and the rune ring the summons is drawn with — so
 *     none of it can sort against the rest;
 *   - **the well**: the inside of the hole, under the floor, lit by the light
 *     coming down through the surface and by the abyss glowing up from below;
 *   - **the crown**: the wall of water thrown up when the shark breaks the
 *     surface, and again when it goes back through it;
 *   - **the shark**: its own textures, patched with the water line — wet and
 *     glossy above it, fogged and lit by caustics below it;
 *   - **the rock**: the stage's own stone (`MonolithStoneMaterial`), so the
 *     spike reads as the floor coming up rather than as a prop.
 *
 * Everything is in metres. Colours and strengths are read from
 * `settings.shark` every frame through each material's `userData.sync`.
 */

/* ==================================================================== */
/* The shared water                                                      */
/* ==================================================================== */

/**
 * The water's surface, shared by the portal and its refraction proxy so the
 * highlights and the bend can never drift apart.
 *
 * `splash` is (x, z, age, strength): a ring launched from where the shark
 * crossed the surface, travelling out and dying.
 */
const WATER_GLSL = /* glsl */ `
  #define SW_TAU 6.283185307179586

  /* The vortex: sampling turned harder toward the middle, so it shears. */
  vec2 swWind(vec2 p, float rad, float radius, float spin) {
    float rn = clamp(rad / max(radius, 1e-3), 0.0, 1.0);
    return rot2(spin * (0.3 + 0.7 / (0.2 + rn))) * p;
  }

  float swHeight(vec2 p, float rad, float radius, float spin, float churn, vec4 splash,
                 float time, float speed, float scale, float seed, float detail) {
    vec2 sp = swWind(p, rad, radius, spin);
    float h = snoise(vec3(sp * scale, time * speed + seed)) * 0.6;
    h += snoise(vec3(sp * scale * 2.7 + 7.0, time * speed * 1.6 + seed)) * 0.3 * detail;
    // White water: the surface torn up where something has just gone through it.
    h += snoise(vec3(p * scale * 4.0, time * 3.2 + seed * 2.0)) * churn * 1.1 * detail;

    // The ring the crossing throws out.
    float sd = length(p - splash.xy);
    float ringR = splash.z * 3.4;
    float ring = sin((sd - ringR) * 10.0) * exp(-pow((sd - ringR) * 2.4, 2.0));
    h += ring * exp(-splash.z * 1.4) * splash.w * 1.6;
    return h;
  }

  vec2 swEquirect(vec3 d) {
    float u = atan(d.z, d.x) * 0.15915494309 + 0.5;
    float v = asin(clamp(d.y, -1.0, 1.0)) * 0.31830988618 + 0.5;
    return vec2(u, v);
  }
`;

const PORTAL_VERTEX = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vViewDir;

  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vViewDir = cameraPosition - world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const PORTAL_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uQuad;        // metres the quad spans
  uniform float uRadius;      // the water, now — the hole in the floor is exactly this
  uniform float uFull;        // the water when fully open: the stain and the rune are sized off it
  uniform float uOpen;        // 0..1 how far the summons is drawn
  uniform float uSpin;        // accumulated vortex turn, radians
  uniform float uChurn;       // 0..1 white water
  uniform vec4  uSplash;      // x, z (local metres), age (s), strength
  uniform float uDry;         // 0..1 the stain drying off the stone
  uniform float uFade;
  uniform float uSeed;

  uniform float uRipple;
  uniform float uRippleScale;
  uniform float uRippleSpeed;
  uniform float uClarity;
  uniform float uSheen;
  uniform float uGloss;
  uniform float uEnvStrength;
  uniform float uCaustic;
  uniform float uFoam;
  uniform float uFoamWidth;
  uniform float uAbyssGlow;
  uniform float uLip;
  uniform float uWetReach;
  uniform float uWetDark;
  uniform float uCracks;
  uniform float uCrackReach;
  uniform float uCrackGlow;
  uniform float uRune;
  uniform float uRuneRadius;
  uniform float uRuneSpin;

  uniform vec3 uColorShallow;
  uniform vec3 uColorDeep;
  uniform vec3 uColorFoam;
  uniform vec3 uColorGlow;
  uniform vec3 uColorRune;
  uniform vec3 uColorWet;

  uniform sampler2D uEnvMap;
  uniform vec3  uLightDir;
  uniform float uGlobalGlow;

  varying vec2 vUv;
  varying vec3 vViewDir;

  ${noiseGLSL}
  ${WATER_GLSL}

  void main() {
    vec2 p = vec2(vUv.x - 0.5, 0.5 - vUv.y) * uQuad;
    float rad = length(p);
    vec2 dir = rad > 1e-4 ? p / rad : vec2(1.0, 0.0);
    float ang = atan(p.y, p.x);

    float full = max(uFull, 1e-3);
    float R = uRadius;
    float outer = full * max(uWetReach, uRuneRadius + 0.12);
    if (rad > outer) discard;

    float footprint = max(fwidth(p.x), fwidth(p.y));
    float detail = 1.0 - smoothstep(0.02, 0.13, footprint);
    vec3 V = normalize(vViewDir);
    vec3 L = normalize(uLightDir);

    vec3 color = vec3(0.0);
    float alpha = 0.0;
    vec3 glow = vec3(0.0);

    /* ---------------------------------------------------------------- */
    /* the water                                                         */
    /* ---------------------------------------------------------------- */
    if (rad < R) {
      float h = swHeight(p, rad, R, uSpin, uChurn, uSplash, uTime, uRippleSpeed, uRippleScale, uSeed, detail) * uRipple;
      // Calm at the wall, where the stone holds it.
      h *= smoothstep(0.0, 0.35, R - rad);

      // World-space gradient off the screen derivatives (see InkPoolMaterial).
      vec2 dpx = dFdx(p);
      vec2 dpy = dFdy(p);
      float det = dpx.x * dpy.y - dpx.y * dpy.x;
      vec2 grad = vec2(0.0);
      if (abs(det) > 1e-9) {
        float hx = dFdx(h);
        float hy = dFdy(h);
        grad = vec2(hx * dpy.y - hy * dpx.y, -hx * dpy.x + hy * dpx.x) / det;
      }
      // p is (world x, world z), so the gradient is (dh/dx, dh/dz).
      vec3 N = normalize(vec3(-grad.x, 1.0, -grad.y));
      float NdotV = clamp(dot(N, V), 0.0, 1.0);
      float fres = 0.02 + 0.98 * pow(1.0 - NdotV, 5.0);

      // Looking down into it: lit shallows at the wall, the abyss in the middle.
      float depthK = smoothstep(0.0, R * 0.9, R - rad);
      vec3 body = mix(uColorShallow, uColorDeep, depthK);

      // Light coming up out of the abyss, turned with the vortex.
      vec2 wp = swWind(p, rad, R, uSpin * 1.6);
      float veins = pow(1.0 - abs(snoise(vec3(wp * 0.9, uTime * 0.25 + uSeed))), 4.0);
      float abyss = (0.35 + 0.65 * veins) * (1.0 - smoothstep(0.0, R, rad) * 0.6) * uAbyssGlow * uOpen;

      // Caustics in the lit shallows.
      vec2 cp = wp * 2.3;
      float c1 = snoise(vec3(cp, uTime * 0.55 + uSeed));
      float c2 = snoise(vec3(cp * 1.47 + 13.0, -uTime * 0.44 + uSeed));
      float caustic = pow(clamp(1.0 - abs(c1 + c2) * 0.9, 0.0, 1.0), 6.0) * uCaustic * detail;

      vec3 refl = texture2D(uEnvMap, swEquirect(reflect(-V, N))).rgb * uEnvStrength;
      vec3 H = normalize(L + V);
      float spec = pow(clamp(dot(N, H), 0.0, 1.0), mix(20.0, 260.0, uGloss)) * uSheen;

      // Foam on the wall, and the white water the crossing tore up.
      float foamBand = smoothstep(uFoamWidth, 0.0, R - rad);
      float foamBreak = snoise01(vec3(dir * 6.0, uTime * 0.6 + uSeed)) * 0.6 + 0.4;
      float churnFoam = smoothstep(0.6, 0.86, snoise01(vec3(p * 2.6, uTime * 1.7 + uSeed * 3.0))) * uChurn;
      float foam = clamp(foamBand * foamBreak * uFoam + churnFoam * 0.75, 0.0, 1.0);

      color = mix(body, refl, fres);
      color = mix(color, uColorFoam, foam * 0.7);
      glow = uColorGlow * (abyss * 0.6 + caustic * 0.5 * (1.0 - depthK * 0.6)) + vec3(1.0) * spec;
      alpha = mix(uClarity, 1.0, fres);
      alpha = max(alpha, foam);
    }

    /* ---------------------------------------------------------------- */
    /* the lip: the cut edge of the stone, and the meniscus on it         */
    /* ---------------------------------------------------------------- */
    float rim = rad - R;
    if (rim >= 0.0 && R > 0.002) {
      // Torn, not cut: the edge wanders off the circle by a few centimetres.
      float torn = (snoise(vec3(dir * 5.0, uSeed)) * 0.5 + 0.5) * uLip;
      float lip = 1.0 - smoothstep(torn * 0.4, torn, rim);
      float meniscus = exp(-rim * rim / 0.0004) * (0.3 + 0.7 * snoise01(vec3(dir * 9.0, uTime * 0.8))) * 0.6;
      color = mix(uColorWet * 0.35, uColorFoam, meniscus * 0.8);
      alpha = max(lip * 0.95, meniscus);
      glow += uColorGlow * lip * 0.08 * uOpen + uColorFoam * meniscus * 0.25;
    }

    /* ---------------------------------------------------------------- */
    /* the stone around it: wet, cracked, written on                      */
    /* ---------------------------------------------------------------- */
    if (rad >= R) {
      float t = rad / full;

      // The stain, ragged, darkest at the lip and drying from its edge in.
      float edge = uWetReach * (0.85 + 0.3 * fbm3(vec3(dir * 2.2, uSeed * 3.0)));
      float wet = (1.0 - smoothstep(edge - 0.35 - uDry * 0.6, edge - uDry * 0.6, t)) * uWetDark;
      wet *= smoothstep(0.0, 0.2, uOpen + (1.0 - uDry) * 0.5);
      wet *= 1.0 - uDry;

      // Cracks run out from the hole along the bearing it tore the floor on.
      float f = ang / SW_TAU * 11.0 + snoise(vec3(rad * 0.9, uSeed, 0.0)) * 0.45;
      float line = abs(fract(f) - 0.5) / 11.0 * SW_TAU * rad;
      float keep = step(0.45, hash11(floor(f) + uSeed * 31.0));
      float reach = 1.0 - smoothstep(uCrackReach * 0.5, uCrackReach, t);
      float crack = (1.0 - smoothstep(0.0, 0.02 + 0.015 * reach, line)) * keep * reach * uCracks;
      crack *= smoothstep(0.0, 0.3, uOpen + (1.0 - uDry) * 0.2);

      // The rune the portal is drawn with: two rings, a band of glyph marks
      // between them turning one way and an outer tick ring the other.
      float rr = uRuneRadius;
      float ringA = exp(-pow((t - rr) * full / 0.035, 2.0));
      float ringB = exp(-pow((t - rr + 0.13) * full / 0.022, 2.0));
      float band = smoothstep(rr - 0.11, rr - 0.1, t) * (1.0 - smoothstep(rr - 0.025, rr - 0.015, t));
      float ga = ang + uTime * uRuneSpin;
      float slot = floor(ga / SW_TAU * 28.0);
      float cell = fract(ga / SW_TAU * 28.0);
      float glyph = step(0.3, hash11(slot + uSeed)) * (step(0.15, cell) - step(0.85, cell))
                  * step(0.5, fract(t * full * 9.0 + hash11(slot * 3.1) * 2.0));
      float ticks = step(0.92, fract((ang - uTime * uRuneSpin * 0.6) / SW_TAU * 64.0))
                  * smoothstep(rr + 0.02, rr + 0.025, t) * (1.0 - smoothstep(rr + 0.07, rr + 0.075, t));
      float rune = (ringA + ringB * 0.7 + glyph * band * 0.8 + ticks * 0.6) * uRune;
      float pulse = 0.75 + 0.25 * sin(uTime * 4.0 - t * 6.0);

      vec3 stone = uColorWet;
      // A wet floor is a mirror at a graze: the sky lies on it.
      float graze = pow(1.0 - clamp(V.y, 0.0, 1.0), 3.0);
      vec3 sky = texture2D(uEnvMap, swEquirect(reflect(-V, vec3(0.0, 1.0, 0.0)))).rgb * uEnvStrength;
      vec3 wetColor = mix(stone, sky, graze * 0.35);

      float a = max(wet, crack * 0.9);
      if (rad > R) {
        color = mix(color, wetColor, wet);
        color = mix(color, vec3(0.0), crack * 0.6);
        alpha = max(alpha, a);
      }
      glow += uColorGlow * crack * uCrackGlow * pulse + uColorRune * rune * pulse * 1.6;
      alpha = max(alpha, clamp(rune * 0.9, 0.0, 1.0));
    }

    color += glow * uGlobalGlow;
    alpha = clamp(alpha, 0.0, 1.0) * uFade;
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(color, alpha);
  }
`;

/** One floor quad per portal: the water, the lip, the stain, the cracks and the rune. */
export function createPortalMaterial() {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: NormalBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uQuad: { value: 8 },
      uRadius: { value: 0 },
      uFull: { value: 1.6 },
      uOpen: { value: 0 },
      uSpin: { value: 0 },
      uChurn: { value: 0 },
      uSplash: { value: new Vector4(0, 0, 10, 0) },
      uDry: { value: 0 },
      uFade: { value: 1 },
      uSeed: { value: 0 },
      uRipple: { value: 0.06 },
      uRippleScale: { value: 1.2 },
      uRippleSpeed: { value: 0.9 },
      uClarity: { value: 0.62 },
      uSheen: { value: 1 },
      uGloss: { value: 0.7 },
      uEnvStrength: { value: 0.7 },
      uCaustic: { value: 0.6 },
      uFoam: { value: 0.8 },
      uFoamWidth: { value: 0.25 },
      uAbyssGlow: { value: 0.5 },
      uLip: { value: 0.14 },
      uWetReach: { value: 1.7 },
      uWetDark: { value: 0.7 },
      uCracks: { value: 1 },
      uCrackReach: { value: 1.9 },
      uCrackGlow: { value: 1.2 },
      uRune: { value: 1 },
      uRuneRadius: { value: 1.3 },
      uRuneSpin: { value: 0.3 },
      uColorShallow: { value: new Color() },
      uColorDeep: { value: new Color() },
      uColorFoam: { value: new Color() },
      uColorGlow: { value: new Color() },
      uColorRune: { value: new Color() },
      uColorWet: { value: new Color() },
      uEnvMap: frame.uEnvMap
    }),
    vertexShader: PORTAL_VERTEX,
    fragmentShader: PORTAL_FRAGMENT
  });

  /**
   * @param {object} state { quad, radius, full, open, spin, churn, splash: Vector4, dry, fade, seed }
   */
  material.userData.sync = (state) => {
    const c = settings.shark;
    const g = settings.global;
    const u = material.uniforms;
    u.uQuad.value = state.quad;
    u.uRadius.value = state.radius;
    u.uFull.value = state.full;
    u.uOpen.value = state.open;
    u.uSpin.value = state.spin;
    u.uChurn.value = state.churn;
    u.uSplash.value.copy(state.splash);
    u.uDry.value = state.dry;
    u.uFade.value = state.fade * g.opacity;
    u.uSeed.value = state.seed;

    u.uRipple.value = c.ripple * g.noiseStrength;
    u.uRippleScale.value = c.rippleScale * g.noiseFrequency;
    u.uRippleSpeed.value = c.rippleSpeed * g.noiseSpeed;
    u.uClarity.value = c.clarity;
    u.uSheen.value = c.sheen * g.shaderIntensity;
    u.uGloss.value = c.gloss;
    u.uEnvStrength.value = c.reflection * g.fresnel;
    u.uCaustic.value = c.caustic * g.shaderIntensity;
    u.uFoam.value = c.foam;
    u.uFoamWidth.value = c.foamWidth;
    u.uAbyssGlow.value = c.abyssGlow * g.shaderIntensity;
    u.uLip.value = c.lip;
    u.uWetReach.value = c.wetReach;
    u.uWetDark.value = c.wetDark;
    u.uCracks.value = c.cracks;
    u.uCrackReach.value = c.crackReach;
    u.uCrackGlow.value = c.crackGlow * g.glow;
    u.uRune.value = c.rune * state.rune * g.shaderIntensity;
    u.uRuneRadius.value = c.runeRadius;
    u.uRuneSpin.value = c.runeSpin;
    u.uColorShallow.value.copy(getColor(c.colorShallow));
    u.uColorDeep.value.copy(getColor(c.colorDeep));
    u.uColorFoam.value.copy(getColor(c.colorFoam));
    u.uColorGlow.value.copy(getColor(c.colorGlow));
    u.uColorRune.value.copy(getColor(c.colorRune));
    u.uColorWet.value.copy(getColor(c.colorWet));
    u.uGlobalGlow.value = g.glow;
  };

  return material;
}

/* ==================================================================== */
/* The refraction                                                        */
/* ==================================================================== */

const WARP_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * Screen-space refraction offsets for the composite (`LAYER.DISTORTION`):
 * R,G the offset around 0.5, B the strength, A the coverage. A floor quad, not
 * a card, so it bends exactly the pixels the water covers, off the same field
 * the surface is shaded with.
 */
const WARP_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uQuad;
  uniform float uRadius;
  uniform float uSpin;
  uniform float uChurn;
  uniform vec4  uSplash;
  uniform float uScale;
  uniform float uSpeed;
  uniform float uStrength;
  uniform float uSeed;
  uniform float uShaderIntensity;
  varying vec2 vUv;

  ${noiseGLSL}
  ${WATER_GLSL}

  void main() {
    vec2 p = vec2(vUv.x - 0.5, 0.5 - vUv.y) * uQuad;
    float rad = length(p);
    float mask = smoothstep(uRadius * 1.04, uRadius * 0.8, rad);
    if (mask < 0.004 || uRadius < 0.01) discard;
    vec2 sp = swWind(p, rad, uRadius, uSpin);
    float nx = snoise(vec3(sp * uScale, uTime * uSpeed + uSeed));
    float ny = snoise(vec3(sp * uScale + vec2(23.1, 7.9), uTime * uSpeed + uSeed + 5.0));
    float sd = length(p - uSplash.xy);
    float ringR = uSplash.z * 3.4;
    float ring = exp(-pow((sd - ringR) * 2.4, 2.0)) * exp(-uSplash.z * 1.4) * uSplash.w;
    vec2 away = sd > 1e-3 ? (p - uSplash.xy) / sd : vec2(0.0);
    vec2 offset = clamp(vec2(nx, ny) * (0.6 + uChurn) + away * ring * 1.5, vec2(-1.0), vec2(1.0));
    gl_FragColor = vec4(offset * 0.5 + 0.5, uStrength * uShaderIntensity * mask, mask);
  }
`;

export function createPortalRefractionMaterial() {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: NormalBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uQuad: { value: 8 },
      uRadius: { value: 0 },
      uSpin: { value: 0 },
      uChurn: { value: 0 },
      uSplash: { value: new Vector4(0, 0, 10, 0) },
      uScale: { value: 1.5 },
      uSpeed: { value: 0.8 },
      uStrength: { value: 1 },
      uSeed: { value: 0 }
    }),
    vertexShader: WARP_VERTEX,
    fragmentShader: WARP_FRAGMENT
  });

  material.userData.sync = (state) => {
    const c = settings.shark;
    const g = settings.global;
    const u = material.uniforms;
    u.uQuad.value = state.quad;
    u.uRadius.value = state.radius;
    u.uSpin.value = state.spin;
    u.uChurn.value = state.churn;
    u.uSplash.value.copy(state.splash);
    u.uSeed.value = state.seed;
    u.uScale.value = c.warpScale * g.noiseFrequency;
    u.uSpeed.value = c.warpSpeed * g.noiseSpeed;
    u.uStrength.value = c.warpStrength * g.distortion * state.open;
  };

  return material;
}

/* ==================================================================== */
/* The well                                                              */
/* ==================================================================== */

const WELL_VERTEX = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

/**
 * The inside of the hole: an open cylinder going down from the floor, and the
 * disc closing it far below. Opaque — it is what you see *through* the water
 * — and lit by two things only: the daylight coming down through the surface
 * in shafts, fading with depth, and the abyss glowing up from the bottom.
 * Everything else is the colour of deep water.
 */
const WELL_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform vec3  uCentre;
  uniform float uRadius;
  uniform float uDensity;
  uniform float uRays;
  uniform float uAbyssGlow;
  uniform float uSeed;
  uniform vec3  uColorShallow;
  uniform vec3  uColorDeep;
  uniform vec3  uColorGlow;
  uniform float uGlobalGlow;
  varying vec3 vWorld;

  ${noiseGLSL}

  void main() {
    float d = max(0.0, -vWorld.y);
    vec2 q = vWorld.xz - uCentre.xz;
    float ang = atan(q.y, q.x);
    float fog = 1.0 - exp(-d * uDensity);

    vec3 color = mix(uColorShallow * 0.55, uColorDeep * 0.35, fog);

    // Shafts of daylight down the walls, drifting.
    float shaft = snoise01(vec3(ang * 3.0, d * 0.12 - uTime * 0.15, uSeed));
    shaft = pow(shaft, 4.0) * exp(-d * 0.55) * uRays;
    // The abyss, glowing up out of the bottom.
    float r = length(q) / max(uRadius, 1e-3);
    float abyss = smoothstep(2.5, 9.0, d) * (1.0 - r * 0.6) * uAbyssGlow;
    abyss *= 0.6 + 0.4 * snoise01(vec3(q * 1.2, uTime * 0.3 + uSeed));

    color += (uColorShallow * shaft + uColorGlow * abyss * 0.6) * uGlobalGlow;
    gl_FragColor = vec4(color, 1.0);
  }
`;

export function createWellMaterial() {
  const material = new ShaderMaterial({
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uCentre: { value: new Vector3() },
      uRadius: { value: 1 },
      uDensity: { value: 0.45 },
      uRays: { value: 1 },
      uAbyssGlow: { value: 0.5 },
      uSeed: { value: 0 },
      uColorShallow: { value: new Color() },
      uColorDeep: { value: new Color() },
      uColorGlow: { value: new Color() }
    }),
    vertexShader: WELL_VERTEX,
    fragmentShader: WELL_FRAGMENT
  });

  material.userData.sync = (state) => {
    const c = settings.shark;
    const g = settings.global;
    const u = material.uniforms;
    u.uCentre.value.set(state.x, 0, state.z);
    u.uRadius.value = Math.max(0.01, state.radius);
    u.uSeed.value = state.seed;
    u.uDensity.value = c.depthFog;
    u.uRays.value = c.wellRays * g.shaderIntensity;
    u.uAbyssGlow.value = c.abyssGlow * g.shaderIntensity;
    u.uColorShallow.value.copy(getColor(c.colorShallow));
    u.uColorDeep.value.copy(getColor(c.colorDeep));
    u.uColorGlow.value.copy(getColor(c.colorGlow));
  };

  return material;
}

/* ==================================================================== */
/* The crown                                                             */
/* ==================================================================== */

/**
 * The wall of water a breach throws up. An open cylinder of unit radius and
 * height, displaced in the vertex stage: it flares out as it rises, its top
 * is torn into fingers that lengthen and detach, and it falls back.
 * `uAge` is 0..1 over its life.
 */
const CROWN_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uAge;
  uniform float uRadius;
  uniform float uHeight;
  uniform float uSpread;
  uniform float uSeed;
  varying float vK;
  varying float vAng;
  varying vec3  vNormal;
  varying vec3  vViewDir;

  ${noiseGLSL}

  void main() {
    float k = position.y;
    float ang = atan(position.z, position.x);
    vec2 ring = vec2(cos(ang), sin(ang));

    float n = snoise(vec3(ring * 1.8, uSeed));
    float fingers = snoise01(vec3(ring * 5.5, uSeed * 2.0));
    float t = uAge;

    // Up fast, hang, fall back.
    float rise = sin(min(1.0, t * 1.8) * 1.5707963) * (1.0 - smoothstep(0.45, 1.0, t) * 0.75);
    float h = uHeight * rise * (0.7 + 0.45 * n) * (0.65 + 0.7 * pow(fingers, 2.0) * k);
    float r = uRadius * (1.0 + uSpread * t) + k * k * uRadius * (0.35 + 0.6 * t) * (0.8 + 0.4 * n);
    // The sheet wobbles as it climbs.
    r += snoise(vec3(ring * 3.0, k * 2.0 + uTime * 2.0 + uSeed)) * 0.06 * uRadius * k;

    vec3 p = vec3(ring.x * r, k * h, ring.y * r);
    vec4 world = modelMatrix * vec4(p, 1.0);
    vK = k;
    vAng = ang;
    vNormal = normalize(mat3(modelMatrix) * vec3(ring.x, 0.35, ring.y));
    vViewDir = cameraPosition - world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const CROWN_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uAge;
  uniform float uSeed;
  uniform float uOpacity;
  uniform vec3  uColorShallow;
  uniform vec3  uColorFoam;
  uniform vec3  uColorGlow;
  uniform float uGlobalGlow;
  varying float vK;
  varying float vAng;
  varying vec3  vNormal;
  varying vec3  vViewDir;

  ${noiseGLSL}

  void main() {
    vec2 ring = vec2(cos(vAng), sin(vAng));
    // Torn into fingers from the top down as it ages.
    float tear = snoise01(vec3(ring * 9.0, vK * 3.0 - uAge * 2.0 + uSeed));
    float cut = mix(1.15, 0.15, uAge);
    float body = smoothstep(cut + 0.05, cut - 0.15, vK + tear * 0.55);
    // Thinning sheet: streaks of foam running up it.
    float streak = snoise01(vec3(ring * 22.0, vK * 1.5 - uTime * 2.5 + uSeed));
    float fres = pow(1.0 - abs(dot(normalize(vNormal), normalize(vViewDir))), 2.0);

    float foam = smoothstep(0.55, 0.95, vK + streak * 0.35) + streak * 0.25;
    vec3 color = mix(uColorShallow * 1.4, uColorFoam, clamp(foam + fres * 0.4, 0.0, 1.0));
    color += uColorGlow * (1.0 - vK) * 0.25 * uGlobalGlow;

    float alpha = body * (0.12 + 0.5 * foam + 0.3 * fres) * (1.0 - smoothstep(0.55, 1.0, uAge)) * uOpacity;
    alpha *= smoothstep(0.0, 0.08, vK + 0.02);
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(color, alpha);
  }
`;

export function createCrownMaterial() {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: NormalBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uAge: { value: 1 },
      uRadius: { value: 1 },
      uHeight: { value: 2 },
      uSpread: { value: 0.5 },
      uSeed: { value: 0 },
      uOpacity: { value: 1 },
      uColorShallow: { value: new Color() },
      uColorFoam: { value: new Color() },
      uColorGlow: { value: new Color() }
    }),
    vertexShader: CROWN_VERTEX,
    fragmentShader: CROWN_FRAGMENT
  });

  material.userData.sync = (state) => {
    const c = settings.shark;
    const g = settings.global;
    const u = material.uniforms;
    u.uAge.value = state.age;
    u.uRadius.value = state.radius;
    u.uHeight.value = state.height;
    u.uSpread.value = c.crownSpread;
    u.uSeed.value = state.seed;
    u.uOpacity.value = c.crownOpacity * g.opacity;
    u.uColorShallow.value.copy(getColor(c.colorShallow));
    u.uColorFoam.value.copy(getColor(c.colorFoam));
    u.uColorGlow.value.copy(getColor(c.colorGlow));
  };

  return material;
}

/* ==================================================================== */
/* The shark                                                             */
/* ==================================================================== */

/**
 * Patch the shark's own (imported) material with the water line.
 *
 * Above y = 0 the skin is **wet**: its roughness pulled down so the sun runs
 * off it in a hard highlight, which is the whole difference between a shark
 * that came out of water and a model that was placed in the air. Below it the
 * skin is **under water**: fogged toward the deep colour with depth and dappled
 * by caustics. Plus a rim, because the stage is dark and a grey animal
 * against a dark floor needs its silhouette drawn.
 *
 * The uniforms are this instance's own, so two sharks on stage are wet on
 * their own clocks.
 */
export function patchSharkMaterial(material) {
  const uniforms = {
    uWet: { value: 1 },
    uFogDensity: { value: 0.6 },
    uCaustic: { value: 1 },
    uRim: { value: 0.6 },
    uRimPower: { value: 3 },
    uColorShallow: { value: new Color() },
    uColorDeep: { value: new Color() },
    uColorRim: { value: new Color() },
    uTime: frame.uTime
  };

  patchOnBeforeCompile(
    material,
    (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\nvarying vec3 vSharkWorld;`)
        .replace(
          '#include <skinning_vertex>',
          `#include <skinning_vertex>\nvSharkWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           varying vec3 vSharkWorld;
           uniform float uWet;
           uniform float uFogDensity;
           uniform float uCaustic;
           uniform float uRim;
           uniform float uRimPower;
           uniform vec3  uColorShallow;
           uniform vec3  uColorDeep;
           uniform vec3  uColorRim;
           uniform float uTime;
           ${noiseGLSL}`
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
           roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.3 + 0.04, uWet * step(0.0, vSharkWorld.y));`
        )
        .replace(
          '#include <opaque_fragment>',
          `{
             float rimK = pow(1.0 - clamp(abs(dot(normal, normalize(vViewPosition))), 0.0, 1.0), uRimPower);
             outgoingLight += uColorRim * rimK * uRim;
             float sub = -vSharkWorld.y;
             if (sub > 0.0) {
               float fog = 1.0 - exp(-sub * uFogDensity);
               vec3 water = mix(uColorShallow, uColorDeep, clamp(sub * 0.3, 0.0, 1.0));
               float c1 = snoise(vec3(vSharkWorld.xz * 1.7, uTime * 0.6));
               float c2 = snoise(vec3(vSharkWorld.xz * 2.5 + 11.0, -uTime * 0.5));
               float caustic = pow(clamp(1.0 - abs(c1 + c2) * 0.9, 0.0, 1.0), 6.0) * exp(-sub * 0.7) * uCaustic;
               outgoingLight = mix(outgoingLight * (1.0 + caustic * 2.0), water, fog);
             }
           }
           #include <opaque_fragment>`
        );
    },
    'shark-body'
  );

  material.userData.sync = (state) => {
    const c = settings.shark;
    const g = settings.global;
    uniforms.uWet.value = state.wet * c.wetness;
    uniforms.uFogDensity.value = c.depthFog;
    uniforms.uCaustic.value = c.caustic * g.shaderIntensity;
    uniforms.uRim.value = c.sharkRim * g.fresnel;
    uniforms.uRimPower.value = c.sharkRimPower;
    uniforms.uColorShallow.value.copy(getColor(c.colorShallow));
    uniforms.uColorDeep.value.copy(getColor(c.colorDeep));
    uniforms.uColorRim.value.copy(getColor(c.colorRim));
  };

  return material;
}

/* ==================================================================== */
/* The rock                                                              */
/* ==================================================================== */

/**
 * The spike that kicks the target, and the chips it throws: the stage's own
 * stone, projected triplanar in world metres, so it reads as the floor
 * coming up. Damp where it came out of the ground, dusted on top where the
 * cloud it raised settles on it.
 *
 * Works on a plain mesh and on an `InstancedMesh` alike — the world position
 * and normal are carried through the instance matrix when there is one.
 */
export function createSharkRockMaterial(environment) {
  const material = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 });
  const uniforms = {
    ...stoneUniforms(),
    uDamp: { value: 0.35 },
    uSeed: { value: Math.random() * 10 },
    uColorDamp: { value: new Color(0.03, 0.04, 0.045) }
  };

  const patch = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vRockWorld;\nvarying vec3 vRockNormal;`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         {
           vec4 rp = vec4(transformed, 1.0);
           vec3 rn = objectNormal;
           #ifdef USE_INSTANCING
             rp = instanceMatrix * rp;
             rn = mat3(instanceMatrix) * rn;
           #endif
           vRockWorld = (modelMatrix * rp).xyz;
           vRockNormal = normalize(mat3(modelMatrix) * rn);
         }`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vRockWorld;
         varying vec3 vRockNormal;
         uniform float uTime;
         uniform float uDamp;
         uniform float uSeed;
         uniform vec3  uColorDamp;
         ${noiseGLSL}
         ${STONE_PARS}`
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         {
           vec3 wn = normalize(vRockNormal);
           Stone st = sampleStone(vRockWorld, wn, uSeed);
           applyDust(st, dustCoverage(vRockWorld, wn));
           // Damp where it came up out of the ground.
           float damp = (1.0 - smoothstep(0.0, 0.45, vRockWorld.y)) * uDamp;
           st.albedo = mix(st.albedo, uColorDamp, damp);
           st.rough = mix(st.rough, 0.45, damp);
           diffuseColor.rgb *= st.albedo;
           gStoneAO = mix(1.0, st.ao, uStoneAO);
           gStoneNormal = st.normal;
           gRoughness = st.rough;
         }`
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
         roughnessFactor = clamp(gRoughness * uStoneRough, uStoneFloor, 1.0);`
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
         normal = normalize((viewMatrix * vec4(gStoneNormal, 0.0)).xyz) * faceDirection;`
      )
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
         reflectedLight.indirectDiffuse *= gStoneAO;
         reflectedLight.indirectSpecular *= mix(1.0, gStoneAO, 0.6);`
      );
  };
  environment.registerShadowCasterWithPatch(material, patch, 'shark-rock');

  material.userData.uniforms = uniforms;
  material.userData.sync = (state) => {
    const c = settings.shark;
    const g = settings.global;
    syncStone(uniforms, c, g);
    uniforms.uDustCoat.value = state.dust * c.dustCoat;
    uniforms.uDamp.value = c.rockDamp;
  };
  return material;
}
