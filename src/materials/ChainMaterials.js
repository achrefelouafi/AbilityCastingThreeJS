import {
  Color,
  CustomBlending,
  DoubleSide,
  FrontSide,
  MeshStandardMaterial,
  NormalBlending,
  OneFactor,
  OneMinusSrcAlphaFactor,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { frame, sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { patchOnBeforeCompile } from '../utils/shaderPatch.js';

/**
 * Materials for the Chains of Penance.
 *
 * One idea runs through all four: **black and gold**. Lacquered black and
 * forged iron for every surface, and gold for every line that is lit — the
 * runes on the links, the filigree round the portals, the seal on the floor —
 * so the whole ability reads as one made object rather than as a stack of
 * effects. Crimson is kept back for the two places it means something: the
 * depth of a portal, and what comes out of the body.
 */

/** Premultiplied over: the colour carries its own alpha, so emission adds and the body darkens. */
const PREMULTIPLIED = {
  blending: CustomBlending,
  blendSrc: OneFactor,
  blendDst: OneMinusSrcAlphaFactor,
  blendSrcAlpha: OneFactor,
  blendDstAlpha: OneMinusSrcAlphaFactor
};

/* ==================================================================== */
/* The links and the hooks                                               */
/* ==================================================================== */

/**
 * Forged iron, instanced, with the heat and the runes injected.
 *
 * A real `MeshStandardMaterial`, so the chain takes the sun, the stage's HDR
 * probe and its own shadow like anything else on the floor — it is a solid
 * thing, and the ability depends on it reading as one: a chain that is only
 * light cannot be taut. What is added is all emissive:
 *
 *  - **Runes** etched down the outside of every link, lit gold. They are what
 *    makes it a spell rather than a winch, and they are on the *outside* faces
 *    only (`aSide`), where the eye sees them.
 *  - **Heat**, per instance (`aGlow`): the ability runs it up the chain from
 *    the portal as it hauls, and down the bearing faces where link grinds on
 *    link. Ramped through a black-body palette — deep red, then the heat
 *    colour, then white — with a crust of cracks breaking open as it climbs,
 *    so hot iron reads as hot *iron* and not as a lamp.
 */
export function createChainMaterial({ hook = false } = {}) {
  const material = new MeshStandardMaterial({
    name: hook ? 'ChainHook' : 'ChainLink',
    color: 0x2a2420,
    metalness: 0.85,
    roughness: 0.4,
    side: hook ? DoubleSide : FrontSide
  });

  const uniforms = {
    uGlobalGlow: frame.uGlobalGlow,
    uColorRune: { value: new Color() },
    uColorHeat: { value: new Color() },
    uColorCore: { value: new Color() },
    uColorDeep: { value: new Color() },
    uRuneGlow: { value: 1 },
    uHeatGlow: { value: 1 },
    uRuneScale: { value: 3.5 },
    uCrackScale: { value: 9 },
    uHook: { value: hook ? 1 : 0 }
  };

  patchOnBeforeCompile(
    material,
    (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           attribute float aGlow;
           attribute float aSeed;
           attribute float aSide;
           varying float vGlow;
           varying float vSeed;
           varying float vSide;
           varying vec3 vLinkPos;`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           vGlow = aGlow;
           vSeed = aSeed;
           vSide = aSide;
           vLinkPos = position;`
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           uniform float uGlobalGlow;
           uniform vec3 uColorRune;
           uniform vec3 uColorHeat;
           uniform vec3 uColorCore;
           uniform vec3 uColorDeep;
           uniform float uRuneGlow;
           uniform float uHeatGlow;
           uniform float uRuneScale;
           uniform float uCrackScale;
           uniform float uHook;
           varying float vGlow;
           varying float vSeed;
           varying float vSide;
           varying vec3 vLinkPos;
           ${noiseGLSL}

           // Black body, roughly: dull red, the heat colour, white.
           vec3 heatRamp(float h) {
             vec3 c = mix(uColorDeep, uColorHeat, smoothstep(0.0, 1.0, h));
             return mix(c, uColorCore, smoothstep(1.3, 2.8, h));
           }`
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
           {
             float heat = max(vGlow, 0.0);

             // Runes: short strokes down the outside of the link, a few to a
             // link, rolled per link so no two read the same. On the hook,
             // the fuller down the blade.
             float outer = smoothstep(0.25, 0.9, vSide);
             float along = vLinkPos.y * uRuneScale + vSeed * 17.0;
             float cell = floor(along);
             float f = fract(along);
             float h = fract(sin(cell * 78.233 + vSeed * 311.7) * 43758.5453);
             float stroke = step(0.38, h) * (1.0 - smoothstep(0.16 + 0.12 * h, 0.22 + 0.12 * h, abs(f - 0.5)));
             float rune = mix(outer * stroke, step(0.9, vSide) * step(0.36, vLinkPos.y) * step(vLinkPos.y, 0.9), uHook);

             // The crust breaking open as the iron heats.
             float cracks = pow(max(0.0, 1.0 - abs(snoise(vLinkPos * uCrackScale + vSeed * 7.0))), 9.0);
             float hot = smoothstep(0.5, 2.2, heat);
             float bearing = smoothstep(0.1, -0.9, vSide) * smoothstep(0.25, 1.4, heat);

             vec3 runeCol = mix(uColorRune, heatRamp(heat), smoothstep(0.6, 1.6, heat));
             totalEmissiveRadiance += (
               runeCol * rune * uRuneGlow * (0.4 + heat) +
               heatRamp(heat) * (hot * (0.15 + 1.4 * cracks) + bearing * 0.7) * uHeatGlow
             ) * uGlobalGlow;

             // Glowing metal stops reflecting like cold metal.
             diffuseColor.rgb *= 1.0 - 0.55 * hot;
           }`
        );
    },
    hook ? 'chain-hook' : 'chain-link'
  );

  material.userData.sync = () => {
    const c = settings.chains;
    material.color.copy(getColor(c.colorIron));
    material.metalness = c.metalness;
    material.roughness = c.roughness;
    material.envMapIntensity = c.ironEnv;
    uniforms.uColorRune.value.copy(getColor(c.colorGold));
    uniforms.uColorHeat.value.copy(getColor(c.colorHeat));
    uniforms.uColorCore.value.copy(getColor(c.colorCore));
    uniforms.uColorDeep.value.copy(getColor(c.colorDeep));
    uniforms.uRuneGlow.value = c.chainRuneGlow * settings.global.glow;
    uniforms.uHeatGlow.value = c.heatGlow * settings.global.glow;
    uniforms.uRuneScale.value = c.runeScale;
    uniforms.uCrackScale.value = c.crackScale;
  };

  return material;
}

/* ==================================================================== */
/* The portals                                                           */
/* ==================================================================== */

/**
 * A portal is a unit quad placed entirely in the vertex shader, off a centre
 * and two axes the ability hands in — so one material and one draw per
 * portal, and no matrix to keep in step with anything.
 *
 * Also hands the fragment stage the view ray in the portal's own frame,
 * which is what the tunnel inside it is parallaxed with.
 */
const PORTAL_VERTEX = /* glsl */ `
  uniform vec3 uCentre;
  uniform vec3 uAxisX;
  uniform vec3 uAxisY;
  uniform vec3 uNormal;
  uniform float uQuad;
  varying vec2 vP;
  varying vec3 vView;
  varying float vViewZ;

  void main() {
    vec3 world = uCentre + (uAxisX * position.x + uAxisY * position.y) * uQuad;
    vP = position.xy * uQuad;
    vec3 ray = world - cameraPosition;
    vView = vec3(dot(ray, uAxisX), dot(ray, uAxisY), dot(ray, uNormal));
    vec4 view = viewMatrix * vec4(world, 1.0);
    vViewZ = view.z;
    gl_Position = projectionMatrix * view;
  }
`;

/**
 * The aperture. Read from the outside in:
 *
 *  - **The filigree.** Two gold rings with a band of glyphs between them,
 *    turning, and two squares turning against each other whose corners break
 *    out past the rim as an eight-pointed star. It is *inscribed* rather than
 *    faded in: a stylus of white light runs round it once (`uDraw`) and the
 *    gold is left behind it.
 *  - **The iris.** Blades of black lacquer, their seams picked out in gold,
 *    that turn as they open (`uOpen`) the way a camera's do. Shut, the portal
 *    is a closed black seal; open, the blades stand back into a polygon of
 *    nothing.
 *  - **The void.** What is through the iris is a tunnel, not a disc: six
 *    rings of rune light at increasing depth, each found by sliding the view
 *    ray into the portal as far as its depth says, narrowing as they recede
 *    and streaming *outward* — toward whatever is about to come through — and
 *    an ember core at the vanishing point. Seen square the rings are
 *    concentric; seen at a graze they shear off to one side, which is the
 *    thing that makes it read as a hole from every angle.
 *
 * Premultiplied over: the void and the blades darken what is behind them,
 * and every lit line only adds.
 */
const PORTAL_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uRadius;
  uniform float uOpen;
  uniform float uDraw;
  uniform float uIgnite;
  uniform float uFlare;
  uniform float uSpin;
  uniform float uSeed;
  uniform float uFade;
  uniform float uCollapse;
  uniform float uBlades;
  uniform float uDepth;
  uniform float uTunnelSpeed;
  uniform float uRuneGlow;
  uniform float uLineGlow;
  uniform float uHalo;
  uniform float uVoid;
  uniform float uShaderIntensity;
  uniform float uGlobalGlow;
  uniform vec3 uColorGold;
  uniform vec3 uColorCore;
  uniform vec3 uColorDeep;
  uniform vec3 uColorVoid;
  uniform vec3 uColorLacquer;
  varying vec2 vP;
  varying vec3 vView;
  varying float vViewZ;

  ${noiseGLSL}

  #define TAU 6.28318530718
  // pow() of a negative base is NaN on D3D; one NaN texel is a black frame once bloom has it.
  float sq(float x) { return x * x; }

  /** Signed distance to a regular n-gon of inradius r, turned by rot. < 0 inside. */
  float irisDist(vec2 p, float r, float n, float rot) {
    float seg = TAU / n;
    float a = atan(p.y, p.x) - rot;
    float k = mod(a + seg * 0.5, seg) - seg * 0.5;
    return length(p) * cos(k) - r;
  }

  /** The seams between the blades: each edge of the opening carried on past its corner. */
  float irisSeams(vec2 p, float r, float n, float rot, float w) {
    float seg = TAU / n;
    float corner = r * tan(seg * 0.5);
    float s = 0.0;
    for (int i = 0; i < 12; i++) {
      if (float(i) >= n) break;
      float a = rot + float(i) * seg;
      vec2 nrm = vec2(cos(a), sin(a));
      vec2 tng = vec2(-nrm.y, nrm.x);
      float off = abs(dot(p, nrm) - r);
      float past = dot(p, tng) - corner;
      s = max(s, (1.0 - smoothstep(w * 0.5, w, off)) * step(0.0, past));
    }
    return s;
  }

  /** One glyph, uv across the cell and up the band, both 0..1. */
  float glyph(float id, vec2 uv) {
    float h = hash11(id * 7.31 + uSeed * 13.0);
    float h2 = hash11(id * 3.17 + 5.0 + uSeed);
    float w = 0.1;
    float s = 0.0;
    s = max(s, (1.0 - smoothstep(w, w + 0.06, abs(uv.x - 0.5))) * step(0.3, h) * step(0.12, uv.y) * step(uv.y, 0.88));
    float bar = mix(0.3, 0.7, step(0.5, fract(h2 * 3.1)));
    s = max(s, (1.0 - smoothstep(w, w + 0.06, abs(uv.y - bar))) * step(0.18, uv.x) * step(uv.x, 0.82) * step(0.45, h2));
    float slant = h > 0.6 ? 1.0 : -1.0;
    float dd = abs((uv.x - 0.5) - (uv.y - 0.5) * slant * 0.6);
    s = max(s, (1.0 - smoothstep(w * 0.8, w * 0.8 + 0.06, dd)) * step(0.55, fract(h * 7.0)) * step(0.15, uv.y) * step(uv.y, 0.85));
    s = max(s, (1.0 - smoothstep(0.07, 0.12, length(uv - vec2(0.5, 0.86)))) * step(0.7, h2));
    return s;
  }

  vec2 rot2(vec2 p, float a) {
    float c = cos(a);
    float s = sin(a);
    return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
  }

  void main() {
    float R = max(uRadius, 1e-3);
    // Collapsing: the whole figure is drawn in toward its centre.
    float scale = max(1.0 - uCollapse * 0.92, 0.04);
    vec2 p = vP / R / scale;
    float r = length(p);
    float a = atan(p.y, p.x);
    float aa = fwidth(r) * 1.25 + 1e-3;

    vec3 col = vec3(0.0);
    float alpha = 0.0;

    /* ---- the iris and what is through it ---- */
    float open = clamp(uOpen, 0.0, 1.25);
    float rot = uSpin * 0.35 + (1.0 - min(open, 1.0)) * 1.5 + uSeed;
    float ap = open * 0.84;
    float d = irisDist(p, ap, uBlades, rot);
    float inside = (1.0 - smoothstep(-aa, aa, d)) * step(0.004, ap);
    float written = smoothstep(0.0, 0.01, uDraw);
    float disc = (1.0 - smoothstep(1.0 - aa, 1.0 + aa, r)) * smoothstep(0.25, 0.75, uDraw);

    if (inside > 0.0) {
      vec3 v = vView;
      float facing = max(abs(v.z), 0.08 * length(v.xy) + 1e-3);
      vec2 slope = v.xy / facing / R;
      vec3 tunnel = vec3(0.0);
      for (int k = 0; k < 6; k++) {
        float fk = float(k);
        float ph = fract(fk / 6.0 - uTime * uTunnelSpeed);
        float depth = ph * uDepth;
        vec2 q = p + slope * depth * R;
        float taper = 1.0 / (1.0 + depth * 0.8);
        float rr = length(q) / max(ap * taper, 1e-3);
        float ring = exp(-sq((rr - 0.93) * 18.0));
        float ang = atan(q.y, q.x);
        float g = step(0.42, hash11(floor((ang / TAU + uSeed + fk * 0.137) * 30.0) + fk * 17.0));
        float life = smoothstep(0.0, 0.18, ph) * (1.0 - smoothstep(0.72, 1.0, ph));
        // Dimmer and redder the deeper it is: the light is coming from the far end.
        vec3 tint = mix(uColorGold, uColorDeep, smoothstep(0.0, 0.45, ph));
        tunnel += tint * ring * (0.15 + 0.85 * g) * life * mix(1.0, 0.35, ph);
      }
      vec2 far = p + slope * uDepth * 1.15 * R;
      float core = exp(-dot(far, far) * 30.0 / max(ap * ap, 1e-3));
      float smoke = snoise(vec3(r * 2.4 - uTime * 1.3, a * 1.6, uSeed * 3.0)) * 0.5 + 0.5;
      vec3 voidCol = uColorVoid
        + tunnel * uRuneGlow
        + uColorDeep * (core * (2.2 + 4.0 * uFlare) + smoke * smoke * 0.18)
        + uColorCore * core * core * (1.2 + 3.0 * uFlare);
      col += voidCol * inside;
      alpha = max(alpha, inside * uVoid);
    }

    /* ---- the blades ---- */
    float blades = disc * (1.0 - inside);
    if (blades > 0.0) {
      float seg = TAU / uBlades;
      float idx = floor(mod(a - rot, TAU) / seg);
      float sheen = 0.5 + 0.5 * sin(idx * 2.3 + uSeed * 5.0);
      vec3 lacquer = uColorLacquer * (0.55 + 0.9 * sheen * (1.0 - r * 0.6));
      float seams = irisSeams(p, ap, uBlades, rot, 0.03 + aa);
      // A sheen along each blade's leading edge, catching the gold.
      float edgeLit = exp(-max(d, 0.0) * 9.0) * 0.6;
      col += (lacquer + uColorGold * (seams * 0.9 + edgeLit * 0.25) * uLineGlow * 0.5) * blades;
      alpha = max(alpha, blades * 0.97);
    }

    // The lip of the opening, lit, brighter as something comes through.
    float lip = exp(-sq(d / 0.025)) * disc * step(0.004, ap);
    col += uColorGold * lip * uLineGlow * (0.7 + 2.5 * uFlare);

    /* ---- the filigree ---- */
    float start = fract(uSeed * 0.37);
    float sweep = fract(a / TAU + 0.5 - start);
    float inscribed = 1.0 - smoothstep(uDraw - 0.004, uDraw, sweep);
    float stylus = exp(-sq((sweep - uDraw) * 45.0)) * step(0.002, uDraw) * step(uDraw, 0.995);

    float line1 = 1.0 - smoothstep(0.0, 0.016 + aa, abs(r - 1.04));
    float line2 = 1.0 - smoothstep(0.0, 0.012 + aa, abs(r - 1.33));
    float band = step(1.1, r) * step(r, 1.27);
    float ga = a / TAU + uSpin * 0.05;
    float cells = 26.0;
    float cid = floor(ga * cells);
    vec2 cuv = vec2(fract(ga * cells), (r - 1.1) / 0.17);
    float glyphs = glyph(cid, cuv) * band * step(0.1, cuv.x) * step(cuv.x, 0.9);

    vec2 s1 = rot2(p, uSpin * 0.21);
    vec2 s2 = rot2(p, -uSpin * 0.21 + 0.7854);
    float side = 1.36 * 0.7071;
    float sq1 = abs(max(abs(s1.x), abs(s1.y)) - side);
    float sq2 = abs(max(abs(s2.x), abs(s2.y)) - side);
    float star = ((1.0 - smoothstep(0.0, 0.011 + aa, sq1)) + (1.0 - smoothstep(0.0, 0.011 + aa, sq2))) * step(1.04, r);

    float filigree = (line1 + line2 * 0.8 + glyphs + star * 0.85) * inscribed;
    col += uColorGold * filigree * uLineGlow * (1.0 + uFlare);
    col += uColorCore * stylus * 4.0 * smoothstep(0.9, 1.04, r) * (1.0 - smoothstep(1.33, 1.42, r));

    // Gone before the edge of the quad, or the quad's corners show.
    float halo = exp(-sq((r - 1.18) * 2.6)) * uHalo * (0.35 + 1.5 * uFlare) * written
      * (1.0 - smoothstep(1.3, 1.58, r));
    col += uColorGold * halo * 0.3;
    // The scorched backing behind the filigree, so the gold reads against sky.
    alpha = max(alpha, smoothstep(1.4, 1.3, r) * step(1.0, r) * 0.35 * inscribed);

    /* ---- the spark that lights it, and the snap that puts it out ---- */
    float flare = exp(-r * r * 10.0) * 2.5
      + (exp(-abs(p.y) * 28.0 - abs(p.x) * 1.6)
      + exp(-abs(p.x) * 28.0 - abs(p.y) * 1.6)) * (1.0 - smoothstep(1.1, 1.55, max(abs(p.x), abs(p.y))));
    col += uColorCore * flare * uIgnite * 2.0;

    float fade = uFade * uShaderIntensity;
    col *= fade * uGlobalGlow;
    alpha *= uFade;
    if (alpha < 0.002 && max(col.r, max(col.g, col.b)) < 0.002) discard;
    gl_FragColor = vec4(col, alpha);
  }
`;

export function createPortalMaterial() {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: DoubleSide,
    toneMapped: false,
    ...PREMULTIPLIED,
    uniforms: sharedUniforms({
      uCentre: { value: new Vector3() },
      uAxisX: { value: new Vector3(1, 0, 0) },
      uAxisY: { value: new Vector3(0, 1, 0) },
      uNormal: { value: new Vector3(0, 0, 1) },
      uQuad: { value: 1 },
      uRadius: { value: 0.4 },
      uOpen: { value: 0 },
      uDraw: { value: 0 },
      uIgnite: { value: 0 },
      uFlare: { value: 0 },
      uSpin: { value: 0 },
      uSeed: { value: 0 },
      uFade: { value: 1 },
      uCollapse: { value: 0 },
      uBlades: { value: 7 },
      uDepth: { value: 2 },
      uTunnelSpeed: { value: 0.5 },
      uRuneGlow: { value: 1 },
      uLineGlow: { value: 2 },
      uHalo: { value: 0.5 },
      uVoid: { value: 0.97 },
      uColorGold: { value: new Color() },
      uColorCore: { value: new Color() },
      uColorDeep: { value: new Color() },
      uColorVoid: { value: new Color() },
      uColorLacquer: { value: new Color() }
    }),
    vertexShader: PORTAL_VERTEX,
    fragmentShader: PORTAL_FRAGMENT
  });

  /** @param {object} s { centre, axisX, axisY, normal, radius, open, draw, ignite, flare, spin, seed, fade, collapse } */
  material.userData.sync = (s) => {
    const c = settings.chains;
    const u = material.uniforms;
    u.uCentre.value.copy(s.centre);
    u.uAxisX.value.copy(s.axisX);
    u.uAxisY.value.copy(s.axisY);
    u.uNormal.value.copy(s.normal);
    u.uRadius.value = s.radius;
    u.uQuad.value = s.radius * 3.2;
    u.uOpen.value = s.open * c.irisOpen;
    u.uDraw.value = s.draw;
    u.uIgnite.value = s.ignite * c.igniteFlash;
    u.uFlare.value = s.flare;
    u.uSpin.value = s.spin;
    u.uSeed.value = s.seed;
    u.uFade.value = s.fade;
    u.uCollapse.value = s.collapse;
    u.uBlades.value = Math.max(3, Math.round(c.blades));
    u.uDepth.value = c.tunnelDepth;
    u.uTunnelSpeed.value = c.tunnelSpeed * settings.global.noiseSpeed;
    u.uRuneGlow.value = c.runeGlow;
    u.uLineGlow.value = c.lineGlow;
    u.uHalo.value = c.halo;
    u.uVoid.value = c.voidOpacity * settings.global.opacity;
    u.uColorGold.value.copy(getColor(c.colorGold));
    u.uColorCore.value.copy(getColor(c.colorCore));
    u.uColorDeep.value.copy(getColor(c.colorDeep));
    u.uColorVoid.value.copy(getColor(c.colorVoid));
    u.uColorLacquer.value.copy(getColor(c.colorLacquer));
  };

  return material;
}

/**
 * The lens round a portal, on `LAYER.DISTORTION`: the frame drawn in toward
 * the aperture and wound about it, with a ring thrown off on every pulse.
 * Masked by the opaque prepass like the Maw's water, so the chain and the
 * body in front of it are not bent along with the air.
 */
const WARP_FRAGMENT = /* glsl */ `
  uniform float uRadius;
  uniform float uStrength;
  uniform float uSwirl;
  uniform float uPulse;
  uniform float uShaderIntensity;
  uniform sampler2D uSceneDepth;
  uniform vec2 uResolution;
  uniform float uCameraNear;
  uniform float uCameraFar;
  varying vec2 vP;
  varying vec3 vView;
  varying float vViewZ;

  ${commonGLSL}

  float sq(float x) { return x * x; }

  void main() {
    vec2 p = vP / max(uRadius, 1e-3);
    float r = length(p);
    float mask = (1.0 - smoothstep(1.2, 1.6, r)) * uStrength;
    float ringR = 0.9 + uPulse * 0.9;
    float ring = exp(-sq((r - ringR) * 5.0)) * (1.0 - uPulse) * step(0.001, uPulse);
    mask = max(mask, ring * uStrength * 1.5);
    if (mask < 0.004) discard;

    float packed = unpackRGBAToDepth(texture2D(uSceneDepth, gl_FragCoord.xy / uResolution));
    float sceneZ = perspectiveDepthToViewZ(packed, uCameraNear, uCameraFar);
    mask *= 1.0 - smoothstep(0.05, 0.2, sceneZ - vViewZ);
    if (mask < 0.004) discard;

    vec2 dir = r > 1e-4 ? p / r : vec2(0.0);
    vec2 tng = vec2(-dir.y, dir.x);
    float pull = -sin(clamp(r / 1.5, 0.0, 1.0) * 3.14159) * 0.7;
    vec2 offset = dir * (pull + ring * 1.2) + tng * uSwirl * exp(-r * 1.4);
    offset = clamp(offset, vec2(-1.0), vec2(1.0));
    gl_FragColor = vec4(offset * 0.5 + 0.5, mask * uShaderIntensity, mask);
  }
`;

export function createPortalWarpMaterial() {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: NormalBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uCentre: { value: new Vector3() },
      uAxisX: { value: new Vector3(1, 0, 0) },
      uAxisY: { value: new Vector3(0, 1, 0) },
      uNormal: { value: new Vector3(0, 0, 1) },
      uQuad: { value: 1 },
      uRadius: { value: 0.4 },
      uStrength: { value: 0 },
      uSwirl: { value: 0.4 },
      uPulse: { value: 0 }
    }),
    vertexShader: PORTAL_VERTEX,
    fragmentShader: WARP_FRAGMENT
  });

  material.userData.sync = (s) => {
    const c = settings.chains;
    const u = material.uniforms;
    u.uCentre.value.copy(s.centre);
    u.uAxisX.value.copy(s.axisX);
    u.uAxisY.value.copy(s.axisY);
    u.uNormal.value.copy(s.normal);
    u.uRadius.value = s.radius;
    u.uQuad.value = s.radius * 4;
    u.uStrength.value = c.warpStrength * settings.global.distortion * s.strength;
    u.uSwirl.value = c.warpSwirl;
    u.uPulse.value = s.pulse;
  };

  return material;
}

/* ==================================================================== */
/* The seal on the floor                                                 */
/* ==================================================================== */

const SEAL_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * The seal the rite is drawn on: a double ring and a band of glyphs, cut into
 * the stone under the body and lit gold, with a spoke run out from it toward
 * every portal — the lines the chains are laid along. Inscribed by a stylus
 * the way the portals are, and it flares on every haul.
 *
 * And what the rite leaves: a pool of blood spreading from under the body
 * once it comes apart, with spatter round it, dark and wet. Premultiplied
 * over, so the scorch and the blood darken the floor and only the gold adds.
 */
const SEAL_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uQuad;
  uniform float uRadius;
  uniform float uDraw;
  uniform float uGlow;
  uniform float uFlare;
  uniform float uSeed;
  uniform float uFade;
  uniform float uBlood;
  uniform float uBloodAmount;
  uniform vec2 uBloodCentre;
  uniform vec4 uSpokes[8];
  uniform vec3 uColorGold;
  uniform vec3 uColorCore;
  uniform vec3 uColorBlood;
  uniform vec3 uColorBloodDark;
  uniform vec3 uLightDir;
  uniform float uShaderIntensity;
  uniform float uGlobalGlow;
  varying vec2 vUv;

  ${noiseGLSL}

  #define TAU 6.28318530718
  float sq(float x) { return x * x; }

  void main() {
    vec2 m = vec2(vUv.x - 0.5, 0.5 - vUv.y) * uQuad;
    vec2 p = m / max(uRadius, 1e-3);
    float r = length(p);
    float a = atan(p.y, p.x);
    float aa = fwidth(r) * 1.25 + 1e-3;

    /* ---- the seal ---- */
    float sweep = fract(a / TAU + 0.25 - uSeed);
    float inscribed = 1.0 - smoothstep(uDraw - 0.004, uDraw, sweep);
    float rings = (1.0 - smoothstep(0.0, 0.012 + aa, abs(r - 1.0)))
      + (1.0 - smoothstep(0.0, 0.008 + aa, abs(r - 0.9)))
      + 0.7 * (1.0 - smoothstep(0.0, 0.008 + aa, abs(r - 0.42)));
    float cells = 40.0;
    float ga = a / TAU + uTime * 0.01;
    float cid = floor(ga * cells);
    float cu = fract(ga * cells);
    float cv = (r - 0.915) / 0.07;
    float h = hash11(cid * 3.71 + uSeed * 9.0);
    float tick = step(0.0, cv) * step(cv, 1.0) * step(0.15, cu) * step(cu, 0.85)
      * max(step(0.4, h) * (1.0 - smoothstep(0.08, 0.14, abs(cu - 0.5))),
            step(0.75, h) * (1.0 - smoothstep(0.1, 0.18, abs(cv - 0.5))));
    float seal = (rings + tick) * inscribed;

    // A spoke to every portal: from the inner ring, out past the rim, fading.
    float spokes = 0.0;
    for (int i = 0; i < 8; i++) {
      vec4 s = uSpokes[i];
      if (s.z <= 0.0) continue;
      float along = dot(p, s.xy);
      float across = abs(p.x * s.y - p.y * s.x);
      float reach = 0.42 + uDraw * 1.3;
      float lit = (1.0 - smoothstep(0.006, 0.006 + aa, across)) * step(0.42, along) * (1.0 - smoothstep(reach - 0.1, reach, along));
      lit *= 1.0 - smoothstep(1.0, 1.75, along);
      spokes = max(spokes, lit * s.z);
    }

    float lines = seal + spokes;
    float pulse = uGlow * (0.7 + uFlare * 2.0);
    vec3 col = uColorGold * lines * pulse;
    float alpha = clamp(lines, 0.0, 1.0) * 0.55;
    // Scorched under the gold, a little beyond it.
    float burn = (1.0 - smoothstep(0.85, 1.12, r)) * 0.18 * smoothstep(0.0, 0.3, uDraw);
    alpha = max(alpha, burn);

    /* ---- the blood ---- */
    if (uBloodAmount > 0.001 && uBlood > 0.001) {
      vec2 b = (m - uBloodCentre) / uBlood;
      float n = fbm3(vec3(m * 1.8, uSeed * 4.0));
      float br = length(b) + n * 0.35;
      float pool = 1.0 - smoothstep(0.82, 0.98, br);
      // Spatter: a few drops thrown clear, thinning out fast past the rim.
      float spatter = step(0.74, snoise(vec3(m * 7.5, uSeed * 2.0 + 3.0)))
        * (1.0 - smoothstep(0.95, 1.45, br)) * step(0.9, br);
      float blood = max(pool, spatter) * uBloodAmount;
      // A wet surface: dark in the body, a lighter meniscus, a glint off the sun.
      vec3 bc = mix(uColorBloodDark, uColorBlood, smoothstep(1.0, 0.5, br) * 0.6 + n * 0.3);
      float meniscus = exp(-sq((br - 0.86) * 14.0)) * pool;
      vec3 nrm = normalize(vec3(dFdx(n) * 40.0, 1.0, dFdy(n) * 40.0));
      float glint = pow(max(dot(reflect(-uLightDir, nrm), vec3(0.0, 1.0, 0.0)), 0.0), 40.0) * pool;
      bc += uColorBlood * meniscus * 0.6 + vec3(glint * 0.35);
      col = mix(col, bc, blood);
      alpha = max(alpha, blood * 0.94);
    }

    col *= uFade * uShaderIntensity;
    col *= mix(1.0, uGlobalGlow, step(0.001, lines));
    alpha *= uFade;
    if (alpha < 0.002 && max(col.r, max(col.g, col.b)) < 0.002) discard;
    gl_FragColor = vec4(col * 1.0, alpha);
  }
`;

export function createSealMaterial() {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    toneMapped: false,
    ...PREMULTIPLIED,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    uniforms: sharedUniforms({
      uQuad: { value: 6 },
      uRadius: { value: 2 },
      uDraw: { value: 0 },
      uGlow: { value: 1 },
      uFlare: { value: 0 },
      uSeed: { value: 0 },
      uFade: { value: 1 },
      uBlood: { value: 0 },
      uBloodAmount: { value: 0 },
      uBloodCentre: { value: new Vector2() },
      uSpokes: { value: Array.from({ length: 8 }, () => new Vector4()) },
      uColorGold: { value: new Color() },
      uColorCore: { value: new Color() },
      uColorBlood: { value: new Color() },
      uColorBloodDark: { value: new Color() }
    }),
    vertexShader: SEAL_VERTEX,
    fragmentShader: SEAL_FRAGMENT
  });

  /**
   * @param {object} s { quad, radius, draw, glow, flare, seed, fade, blood,
   *   bloodAmount, bloodX, bloodZ, spokes: Array<{x, z, w}> }
   */
  material.userData.sync = (s) => {
    const c = settings.chains;
    const u = material.uniforms;
    u.uQuad.value = s.quad;
    u.uRadius.value = s.radius;
    u.uDraw.value = s.draw;
    u.uGlow.value = s.glow * c.sealGlow;
    u.uFlare.value = s.flare;
    u.uSeed.value = s.seed;
    u.uFade.value = s.fade;
    u.uBlood.value = s.blood;
    u.uBloodAmount.value = s.bloodAmount;
    // The shader's frame is the floor's: x is world x, y is world z.
    u.uBloodCentre.value.set(s.bloodX, s.bloodZ);
    for (let i = 0; i < 8; i++) {
      const spoke = s.spokes[i];
      if (spoke) u.uSpokes.value[i].set(spoke.x, spoke.z, spoke.w, 0);
      else u.uSpokes.value[i].set(0, 0, 0, 0);
    }
    u.uColorGold.value.copy(getColor(c.colorGold));
    u.uColorCore.value.copy(getColor(c.colorCore));
    u.uColorBlood.value.copy(getColor(c.colorBlood));
    u.uColorBloodDark.value.copy(getColor(c.colorBloodDark));
  };

  return material;
}
