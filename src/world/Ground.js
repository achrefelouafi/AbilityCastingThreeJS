import { Mesh, PlaneGeometry, MeshStandardMaterial } from 'three';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { LAYER } from '../core/Layers.js';
import { floorHoles, MAX_FLOOR_HOLES } from './FloorHoles.js';

/** Side length of the floor plane, metres. */
const PLANE_SIZE = 400;

/**
 * The stage floor.
 *
 * Kept perfectly flat (y = 0) on purpose: the path-drawing raycast, every
 * ability and the earth eruptions all assume a planar surface, and a flat plane
 * makes those interactions exact.
 *
 * The surface is procedural dark stone — broad, smooth variation in the cool
 * stage palette, no tiling — under a radial light pool that keeps the stage
 * centre readable and sinks the floor into the backdrop long before the
 * plane's edge.
 */
export class Ground {
  constructor(environment) {
    this.environment = environment;

    this.material = new MeshStandardMaterial({
      color: 0xffffff,
      roughness: settings.environment.floorRoughness,
      metalness: 0.0,
      dithering: true
    });

    this.uniforms = {
      uFloorColor: { value: getColor(settings.environment.floorColor).clone() },
      uFloorTint: { value: getColor(settings.environment.floorTint).clone() },
      uSheen: { value: settings.environment.floorSheen },
      uPool: { value: settings.environment.floorPool },
      uTime: { value: 0 },
      // Shared by reference with `FloorHoles`: the openings abilities cut.
      uFloorHoles: floorHoles.uniform
    };

    environment.registerShadowCasterWithPatch(this.material, (shader) => {
      shader.uniforms.uFloorColor = this.uniforms.uFloorColor;
      shader.uniforms.uFloorTint = this.uniforms.uFloorTint;
      shader.uniforms.uSheen = this.uniforms.uSheen;
      shader.uniforms.uPool = this.uniforms.uPool;
      shader.uniforms.uTime = this.uniforms.uTime;
      shader.uniforms.uFloorHoles = this.uniforms.uFloorHoles;

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\nvarying vec3 vGroundWorld;`)
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>\nvGroundWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           varying vec3 vGroundWorld;
           uniform vec3 uFloorColor;
           uniform vec3 uFloorTint;
           uniform float uSheen;
           uniform float uPool;
           uniform float uTime;
           #define MAX_FLOOR_HOLES ${MAX_FLOOR_HOLES}
           uniform vec4 uFloorHoles[MAX_FLOOR_HOLES];
           ${noiseGLSL}`
        )
        .replace(
          '#include <clipping_planes_fragment>',
          `#include <clipping_planes_fragment>
           // The openings abilities cut in the stage (world/FloorHoles.js).
           // Whatever they draw under the floor shows through here and only here.
           // Only while the plane *is* the stage: lowered under the duel hall's
           // floating platform (see DuelHall), it is the far ground and the
           // platform takes the holes.
           if (vGroundWorld.y > -0.5) {
             for (int i = 0; i < MAX_FLOOR_HOLES; i++) {
               vec4 hole = uFloorHoles[i];
               if (hole.z > 0.0 && distance(vGroundWorld.xz, hole.xy) < hole.z) discard;
             }
           }`
        )
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
           {
             vec3 wp = vGroundWorld;

             // Procedural dark stone: broad, smooth variation with a warmer wash
             // drifting through it — anything higher frequency reads as gravel
             // and fights the clean look.
             float macro = fbm3(wp * 0.018);
             float tintMask = smoothstep(-0.5, 0.6, macro);
             vec3 base = mix(uFloorColor, uFloorTint, tintMask * 0.5);
             base *= 1.0 + fbm3(wp * 0.09 + 11.0) * 0.05;
             base *= 1.0 + (snoise01(wp * 0.7) - 0.5) * 0.06;
             diffuseColor.rgb *= base;

             // Radial light pool: the stage centre stays readable and the floor
             // sinks toward the backdrop long before the plane's edge — it is
             // what welds the floor into the scene.
             float dist = length(wp.xz);
             float pool = mix(1.0, smoothstep(40.0, 5.0, dist), clamp(uPool, 0.0, 1.0));
             diffuseColor.rgb *= mix(0.18, 1.0, pool);
           }`
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
           {
             // Break the sheen up: broad patches of smoother stone catch the key
             // light and the elemental glows, the rest stays matte.
             float polish = smoothstep(0.3, 0.85, fbm3(vGroundWorld * 0.06 + 3.0) * 0.5 + 0.5);
             roughnessFactor *= mix(1.0, 0.45, polish * clamp(uSheen, 0.0, 1.0));
           }`
        );
    });

    this.mesh = new Mesh(new PlaneGeometry(PLANE_SIZE, PLANE_SIZE, 1, 1), this.material);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.name = 'Ground';
    this.mesh.layers.set(LAYER.WORLD);
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();

    this.group = this.mesh;
  }

  /**
   * Raise or lower the plane. It is the stage at y = 0; with the duel hall's
   * platform floating over it, it drops to become the ground far below.
   */
  setHeight(y) {
    if (this.mesh.position.y === y) return;
    this.mesh.position.y = y;
    this.mesh.updateMatrix();
  }

  update(elapsed) {
    const env = settings.environment;
    this.uniforms.uTime.value = elapsed;
    this.uniforms.uFloorColor.value.copy(getColor(env.floorColor));
    this.uniforms.uFloorTint.value.copy(getColor(env.floorTint));
    this.uniforms.uSheen.value = env.floorSheen;
    this.uniforms.uPool.value = env.floorPool;
    this.material.roughness = env.floorRoughness;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
