/**
 * Final look pass (runs after tone mapping, in display space).
 *
 * Combines the cheap-but-high-impact grading operations into one pass so the
 * frame is only resampled once: chromatic aberration, lift/gain/contrast/
 * saturation/temperature grading, vignette, film grain and the impact flash.
 *
 * In AR mode it is also where the camera frame goes *under* the stage. The
 * frame is composited here, after tone mapping, on purpose: it is a finished
 * sRGB picture already, and running it through the HDR chain would ACES-grade
 * a real table and bloom its highlights. The scene arrives premultiplied over
 * transparent black with its coverage in alpha — bloom adds to that alpha, so
 * a glow halo lands on the frame as light rather than as a cut-out — and the
 * composite is one `over`. `uVideoScale` is the cover-fit crop.
 */
export const GradeShader = {
  name: 'GradeShader',

  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uAberration: { value: 0.35 },
    uVignette: { value: 0.4 },
    uContrast: { value: 1.05 },
    uSaturation: { value: 1.1 },
    uTemperature: { value: 0.05 },
    uLift: { value: 0.0 },
    uGain: { value: 1.0 },
    uGrain: { value: 0.03 },
    uFlashColor: { value: null },
    uFlashStrength: { value: 0 },
    tVideo: { value: null },
    uVideoOn: { value: 0 },
    uVideoOnly: { value: 0 },
    uVideoScale: { value: null },
    tDistortion: { value: null },
    uVideoDistortion: { value: 0 }
  },

  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uAberration;
    uniform float uVignette;
    uniform float uContrast;
    uniform float uSaturation;
    uniform float uTemperature;
    uniform float uLift;
    uniform float uGain;
    uniform float uGrain;
    uniform vec3  uFlashColor;
    uniform float uFlashStrength;
    uniform sampler2D tVideo;
    uniform float uVideoOn;
    uniform float uVideoOnly;
    uniform vec2  uVideoScale;
    uniform sampler2D tDistortion;
    uniform float uVideoDistortion;

    varying vec2 vUv;

    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    void main() {
      vec2 uv = vUv;
      vec2 centered = uv - 0.5;
      float r2 = dot(centered, centered);

      // ---- chromatic aberration (radial, strongest at the corners) ------
      vec3 color;
      float coverage = 1.0;
      if (uAberration > 0.001) {
        vec2 offset = centered * r2 * uAberration * 0.02;
        color.r = texture2D(tDiffuse, uv + offset).r;
        vec4 centre = texture2D(tDiffuse, uv);
        color.g = centre.g;
        coverage = centre.a;
        color.b = texture2D(tDiffuse, uv - offset).b;
      } else {
        vec4 centre = texture2D(tDiffuse, uv);
        color = centre.rgb;
        coverage = centre.a;
      }

      // ---- the camera frame, under the stage (AR mode) -------------------
      if (uVideoOn > 0.5) {
        vec2 videoUv = uv;
        // The heat haze warps the scene in its own pass, upstream; the frame
        // is not in that pass, so it takes the same offset here — or the
        // table would sit dead still under a shimmering fireball.
        if (uVideoDistortion > 0.0) {
          vec4 d = texture2D(tDistortion, uv);
          videoUv += (d.rg - 0.5) * 2.0 * d.b * d.a * uVideoDistortion;
        }
        vec3 video = texture2D(tVideo, clamp(0.5 + (videoUv - 0.5) * uVideoScale, 0.0, 1.0)).rgb;
        // Premultiplied over: the scene is already scaled by its coverage.
        color = uVideoOnly > 0.5 ? video : color + video * (1.0 - clamp(coverage, 0.0, 1.0));
      }

      // ---- grading -------------------------------------------------------
      color = (color - 0.5) * uContrast + 0.5;          // contrast
      color = color * uGain + uLift;                     // lift / gain

      float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
      color = mix(vec3(luma), color, uSaturation);       // saturation

      // Temperature: push warm into R/B, cool the other way.
      color.r += uTemperature * 0.12;
      color.b -= uTemperature * 0.12;

      // ---- vignette ------------------------------------------------------
      // Falls off from the centre and reaches (1 - uVignette) in the corners,
      // so the control maps directly onto "how much darker the corners are".
      color *= 1.0 - uVignette * smoothstep(0.15, 0.72, r2 * 1.9);

      // ---- impact flash --------------------------------------------------
      if (uFlashStrength > 0.001) {
        color = mix(color, uFlashColor, clamp(uFlashStrength, 0.0, 1.0) * 0.75);
      }

      // ---- grain ---------------------------------------------------------
      if (uGrain > 0.0005) {
        float grain = hash12(uv * vec2(1920.0, 1080.0) + fract(uTime) * 137.0) - 0.5;
        color += grain * uGrain;
      }

      gl_FragColor = vec4(max(color, 0.0), 1.0);
    }
  `
};
