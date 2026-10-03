import {
  Group,
  Mesh,
  Points,
  InstancedMesh,
  BufferGeometry,
  BufferAttribute,
  Box3,
  Matrix4,
  Quaternion,
  Vector3,
  Color,
  PointLight,
  MeshStandardMaterial,
  MeshPhysicalMaterial,
  MeshBasicMaterial,
  ShaderMaterial,
  AdditiveBlending,
  DoubleSide,
  RepeatWrapping,
  SRGBColorSpace
} from 'three';
import { MeshSurfaceSampler } from 'three/addons/math/MeshSurfaceSampler.js';
import { settings } from '../config/settings.js';
import { LAYER } from '../core/Layers.js';
import { getStoneTextures, STONE_TILE_METRES } from '../loaders/StoneTextures.js';
import { floorHoles, MAX_FLOOR_HOLES } from './FloorHoles.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { getColor } from '../utils/color.js';

const MODEL_URL = './models/duel_hall.glb';
const TEX = './textures/duelhall/';

/** The Blender export lays stone UVs out at one unit per this many metres. */
const UV_METRES = 4;

const _m = new Matrix4();
const _q = new Quaternion();
const _p = new Vector3();
const _s = new Vector3();
const _axisY = new Vector3(0, 1, 0);
const _level = new Quaternion();
const _tilt = new Quaternion();

/**
 * The export's top-level nodes that make up the floating platform. Everything
 * else at the top level is the castle around it, and goes when it is switched
 * off. The floor sigil stays: it drops onto the stone plane under the platform.
 */
const PLATFORM_NODES = new Set([
  'DuelCloth',
  'PlatformDisc',
  'PlatformRockUnderside',
  'GoldUnderRing_A',
  'GoldUnderRing_B',
  'RuneRing_A',
  'RuneRing_B',
  'RuneRing_C',
  'DebrisRocks',
  'FloorSigil'
]);

/** Castle surfaces the embers are scattered over as it burns. */
const EMBER_SOURCES = ['HallWall', 'Dome', 'Pillars', 'WindowGlass', 'WindowFrames', 'DomeRibs', 'Balcony', 'Cornice'];
const EMBER_COUNT = 4000;

/**
 * Width of the burning band, in units of the dissolve field. The sweep runs
 * from -W to 1 + W so the band enters and leaves the castle completely.
 */
const BURN_WIDTH = 0.06;

/** The hall's own floor, world y, metres — the bottom of the castle. */
const HALL_FLOOR = -16;

/** How far the rubble under the platform sinks with the castle gone, metres. */
const DEBRIS_SINK = 14;

/**
 * Where the top rune ring goes with the castle gone. In the hall it hangs 3 m
 * under the stage and only a metre or two past the cloth, so the platform
 * hides most of it: the near side tucks under the edge from above, the far
 * side goes behind it from a tilted camera — under half of it ever shows, and
 * widening it alone does not fix the far side. Lifted to just under the stage
 * plane and opened out a little, it circles the dais in full from any angle.
 */
const OPEN_RING_Y = -0.05;
const OPEN_RING_SCALE = 1.12;

/**
 * Where on the castle the burn has reached: 0 goes first, 1 last. Mostly
 * height — the dome lifts off and the walls burn down to the floor, and the
 * rebuild runs the other way, floor up — broken up by noise so the front
 * eats through the stone in tongues rather than as a level line. Shared by
 * the castle's materials and the embers, so an ember leaves the wall at the
 * exact moment the stone under it goes.
 */
const DISSOLVE_GLSL = /* glsl */ `
#define BURN_WIDTH ${BURN_WIDTH.toFixed(3)}
${noiseGLSL}
float castleField(vec3 p) {
  float h = clamp((p.y - (${HALL_FLOOR.toFixed(1)})) / 70.0, 0.0, 1.0);
  float n = clamp(fbm3(p * 0.09) * 0.6 + 0.5, 0.0, 1.0);
  return clamp(1.0 - (h * 0.68 + n * 0.32), 0.0, 1.0);
}
float castleSweep(float amount) {
  return amount * (1.0 + 2.0 * BURN_WIDTH) - BURN_WIDTH;
}
`;

/**
 * The Duel Hall: a floating, cloth-draped duelling platform inside a round
 * gothic hall (authored in Blender — `art/duel_hall/duel_hall.blend`).
 *
 * The platform's cloth *is* the stage floor while the hall is up. Its top sits
 * exactly on y = 0 and spans 16.3 m, so the targets' spawn ring (13 m) stays on
 * it, and it carries the same floor-hole discard as `Ground` so an ability that
 * opens the floor still opens this one. `Ground` is hidden instead of removed —
 * AR mode needs it back as the shadow catcher, and the hall steps out there.
 *
 * Everything in the export is rebuilt here by material name rather than taken
 * from the glTF: the Blender look is procedural node work that does not export,
 * so stone borrows the shared photographic scan (`StoneTextures`), the cloth and
 * glass use maps baked out of the same scene, and the glows are additive
 * materials on LAYER.VFX so they stay out of the depth prepass.
 *
 * Repeated props (256 bookshelves, ~250 floating candles) arrive as hundreds of
 * nodes sharing a mesh and are folded into InstancedMeshes, so the whole hall
 * draws in well under a hundred calls.
 *
 * The hall's lights are created once, before the boot warm-up, and never
 * removed: switching it off zeroes their intensity instead, because a change in
 * light count would recompile every lit material in the scene.
 */
export class DuelHall {
  /**
   * @param {import('./Environment.js').Environment} environment
   * @param {import('./Ground.js').Ground} ground
   */
  constructor(environment, ground) {
    this.environment = environment;
    this.ground = ground;
    this.group = new Group();
    this.group.name = 'DuelHall';
    this.loaded = false;
    this._ar = false;

    /** Spinning parts: { object, base quaternion, turns per second, local? }. */
    this._spinners = [];
    /** Bobbing parts: { object, base y, amplitude, speed, phase }. */
    this._bobbers = [];
    this._materials = [];
    this._textures = [];

    /**
     * The castle burn, shared by every castle material: 0 standing, 1 gone.
     * A uniform rather than visibility so the switch never recompiles, and so
     * the walls can burn away instead of popping.
     */
    this._burn = {
      uDissolve: { value: 0 },
      uDissolveColor: { value: new Color() }
    };
    /** 1 while the castle is burning away, -1 while it rebuilds. */
    this._burnDir = settings.hall.castle ? -1 : 1;
    /** Seconds into the current burn; parked far past the end at boot. */
    this._burnClock = 1e4;
    this._burnShown = settings.hall.castle ? 0 : 1;
    this._debrisSink = 0;

    // Night: the hall is lit by its candles and the orrery, with the scene's cool
    // key standing in for moonlight. One warm light over the platform (the
    // orrery's sun) and a ring of candle-height fills. No shadows — the key owns
    // the shadow map.
    this.lights = [];
    const orrery = new PointLight(0xffb066, 0, 0, 2);
    orrery.position.set(0, 23, 0);
    // `open`: what each light keeps once the castle is gone. The orrery and
    // the hall's warm fills are mostly bounce off the walls; the levitation
    // glow belongs to the platform.
    this.lights.push({ light: orrery, base: 600, open: 0.35 });
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const fill = new PointLight(0xff8a3d, 0, 0, 2);
      fill.position.set(Math.cos(a) * 24, 11, Math.sin(a) * 24);
      this.lights.push({ light: fill, base: 240, open: 0.55 });
    }
    // Violet levitation glow from under the platform.
    const under = new PointLight(0x8a55ff, 0, 0, 2);
    under.position.set(0, -9, 0);
    this.lights.push({ light: under, base: 420, open: 1.0 });
    for (const { light } of this.lights) this.group.add(light);
  }

  /** @param {import('../loaders/AssetLoader.js').AssetLoader} assets */
  async load(assets) {
    const [gltf, tex] = await Promise.all([
      assets.loadGLTF(MODEL_URL),
      this._loadTextures(assets)
    ]);
    this._tex = tex;
    const mats = this._buildMaterials(tex);

    const root = gltf.scene;
    root.updateMatrixWorld(true);
    // The export's cloth top sits 12 mm proud of y = 0 — right where abilities
    // draw their floor quads (decals, portals), which then z-fight it. Drop the
    // whole hall so the top of the cloth is the stage plane exactly.
    const clothNode = root.getObjectByName('DuelCloth');
    if (clothNode) {
      root.position.y -= new Box3().setFromObject(clothNode).max.y;
      root.updateMatrixWorld(true);
    }

    const instanced = { shelf: [], candle: [], flame: [] };
    root.traverse((node) => {
      const name = node.name ?? '';
      if (name.startsWith('Shelf_')) instanced.shelf.push(node);
      else if (name.startsWith('CandleFlame_')) instanced.flame.push(node);
      else if (name.startsWith('Candle_')) instanced.candle.push(node);
    });
    // Strip the instanced nodes out before anything else touches the tree.
    for (const list of Object.values(instanced)) for (const node of list) node.removeFromParent();

    const onPlatform = (node) => {
      while (node.parent && node.parent !== root) node = node.parent;
      return PLATFORM_NODES.has(node.name);
    };
    root.traverse((node) => {
      if (!node.isMesh) return;
      const key = node.material?.name ?? '';
      // The stone under the cloth shares the trim look but has to open with it,
      // and the platform's gold has to stay when the castle's burns.
      const material =
        node.name === 'PlatformDisc'
          ? this._disc
          : node.name === 'Oculus'
            ? this._nightSky
            : key === 'M_Gold' && onPlatform(node)
              ? this._platformGold
              : mats[key];
      if (material) node.material = material;
      node.castShadow = false;
      node.receiveShadow = key === 'M_DuelCloth';
      if (material?.userData.vfx) node.layers.set(LAYER.VFX);
    });

    this.group.add(root);
    this._root = root;
    // The castle gets a group of its own so it can be hidden in one go once it
    // has burned away. `attach` keeps each node where it stands.
    this.castle = new Group();
    this.castle.name = 'DuelHallCastle';
    this.group.add(this.castle);
    for (const node of [...root.children]) {
      if (!PLATFORM_NODES.has(node.name)) this.castle.attach(node);
    }
    this._buildInstances(instanced, mats);
    // The orrery and the light shafts have moved into the castle group.
    this._collectAnimated(this.group);
    this._buildCandleGlow(instanced.flame);
    this._buildEmbers();

    this.loaded = true;
    this.setVisible(settings.hall.enabled);
  }

  async _loadTextures(assets) {
    const load = async (file, srgb) => {
      const texture = await assets.loadTexture(TEX + file);
      if (srgb) texture.colorSpace = SRGBColorSpace;
      texture.anisotropy = 8;
      this._textures.push(texture);
      return texture;
    };
    const [clothColor, clothOrm, clothEmissive, runeGlow, glass, ...banners] = await Promise.all([
      load('cloth_color.jpg', true),
      load('cloth_orm.png', false),
      load('cloth_emissive.jpg', true),
      load('rune_glow.jpg', true),
      load('stained_glass.jpg', true),
      load('banner_crimson.jpg', true),
      load('banner_sapphire.jpg', true),
      load('banner_emerald.jpg', true),
      load('banner_amber.jpg', true)
    ]);
    // glTF UVs have v pointing down the image; these maps were written for it.
    for (const t of [clothColor, clothOrm, clothEmissive, runeGlow, glass, ...banners]) t.flipY = false;

    // The shared rock scan, tiled for the export's metre-based UVs. Clones so
    // the repeat here never leaks into the abilities that borrow the same maps.
    const stoneSrc = getStoneTextures();
    const stone = {};
    for (const slot of ['map', 'normalMap', 'roughnessMap', 'aoMap']) {
      const t = stoneSrc[slot].clone();
      t.wrapS = t.wrapT = RepeatWrapping;
      t.repeat.set(UV_METRES / STONE_TILE_METRES, UV_METRES / STONE_TILE_METRES);
      t.needsUpdate = true;
      this._textures.push(t);
      stone[slot] = t;
    }
    return { clothColor, clothOrm, clothEmissive, runeGlow, glass, banners, stone };
  }

  _buildMaterials(tex) {
    const track = (m) => (this._materials.push(m), m);
    // Castle materials burn away with it (see `_patchDissolve`).
    const castle = (m) => (this._patchDissolve(m), m);
    const stone = (color, roughness = 0.9) =>
      track(
        new MeshStandardMaterial({
          color,
          roughness,
          metalness: 0,
          map: tex.stone.map,
          normalMap: tex.stone.normalMap,
          roughnessMap: tex.stone.roughnessMap,
          aoMap: tex.stone.aoMap
        })
      );
    const glow = (map, color, opacity = 1) => {
      const m = track(
        new MeshBasicMaterial({
          map,
          color,
          transparent: true,
          opacity,
          blending: AdditiveBlending,
          depthWrite: false,
          side: DoubleSide,
          fog: false
        })
      );
      m.userData.vfx = true;
      return m;
    };

    const cloth = track(
      new MeshPhysicalMaterial({
        map: tex.clothColor,
        roughnessMap: tex.clothOrm,
        metalnessMap: tex.clothOrm,
        roughness: 1,
        metalness: 1,
        // Dark midnight velvet. The stage's HDR probe is a bright sunrise, and
        // its reflection is what turned the cloth royal blue — so the velvet
        // keeps little of it, a weak specular and only a faint deep-blue sheen.
        sheen: 0.15,
        sheenColor: new Color(0x141e55),
        sheenRoughness: 0.4,
        specularIntensity: 0.35,
        envMapIntensity: 0.15,
        emissiveMap: tex.clothEmissive,
        emissive: new Color(0xffffff),
        emissiveIntensity: 1.6
      })
    );
    this._patchFloorHoles(cloth);
    this._patchVelvet(cloth);
    const disc = stone(new Color(0.95, 0.85, 0.72), 0.85);
    this._patchFloorHoles(disc);

    this.runeMaterial = glow(tex.runeGlow, new Color(2.2, 2.2, 2.2));
    this.godRayMaterial = this._godRayMaterial();

    const bannerMats = tex.banners.map((map) =>
      castle(track(new MeshStandardMaterial({ map, roughness: 0.75, side: DoubleSide })))
    );

    // The platform's own gold, so the castle's can burn without it.
    this._platformGold = track(new MeshStandardMaterial({ color: 0xf2a84a, metalness: 1, roughness: 0.3 }));

    const mats = {
      M_DuelCloth: cloth,
      M_StoneWall: castle(stone(new Color(0.62, 0.53, 0.44))),
      M_StoneTrim: castle(stone(new Color(0.95, 0.85, 0.72), 0.85)),
      M_StoneFloor: castle(stone(new Color(0.42, 0.37, 0.33))),
      M_PlatformRock: stone(new Color(0.32, 0.29, 0.31)),
      M_DarkWood: castle(track(new MeshStandardMaterial({ color: 0x2a140b, roughness: 0.5 }))),
      M_Gold: castle(track(new MeshStandardMaterial({ color: 0xf2a84a, metalness: 1, roughness: 0.3 }))),
      M_GoldGlow: castle(track(new MeshBasicMaterial({ color: new Color(3.2, 2.1, 1.0), fog: false }))),
      // Moonlit from outside: dim and blue-shifted.
      M_StainedGlass: castle(track(new MeshBasicMaterial({ map: tex.glass, color: new Color(0.5, 0.62, 1.15) }))),
      M_Wax: track(
        new MeshStandardMaterial({ color: 0xeadcb8, roughness: 0.5, emissive: 0xff9a40, emissiveIntensity: 0.6 })
      ),
      M_Flame: track(new MeshBasicMaterial({ color: new Color(5.0, 2.6, 0.9), fog: false })),
      M_Books: castle(track(new MeshStandardMaterial({ vertexColors: true, roughness: 0.6 }))),
      M_RuneRingGlow: this.runeMaterial,
      M_BannerCrimson: bannerMats[0],
      M_BannerSapphire: bannerMats[1],
      M_BannerEmerald: bannerMats[2],
      M_BannerAmber: bannerMats[3]
    };
    // The shaft mesh has no material slot; `_collectAnimated` finds it by name.
    this._disc = disc;
    this._nightSky = castle(track(new MeshBasicMaterial({ color: new Color(0.35, 0.5, 1.0), fog: false })));
    return mats;
  }

  /**
   * Let a castle material burn away. Fragments the sweep has passed are
   * discarded; just ahead of it the stone chars, and right at the front it
   * glows white-hot into `castleEdge`. Compiled in from the start, so the
   * castle switch is a uniform change and never a recompile.
   */
  _patchDissolve(material) {
    const burn = this._burn;
    this.environment.registerShadowCasterWithPatch(
      material,
      (shader) => {
        shader.uniforms.uDissolve = burn.uDissolve;
        shader.uniforms.uDissolveColor = burn.uDissolveColor;
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', `#include <common>\nvarying vec3 vDissolveWorld;`)
          .replace(
            '#include <project_vertex>',
            `#include <project_vertex>
             vec4 dissolveWorld = vec4(transformed, 1.0);
             #ifdef USE_INSTANCING
               dissolveWorld = instanceMatrix * dissolveWorld;
             #endif
             vDissolveWorld = (modelMatrix * dissolveWorld).xyz;`
          );
        shader.fragmentShader = shader.fragmentShader
          .replace(
            '#include <common>',
            `#include <common>
             varying vec3 vDissolveWorld;
             uniform float uDissolve;
             uniform vec3 uDissolveColor;
             ${DISSOLVE_GLSL}`
          )
          .replace(
            '#include <clipping_planes_fragment>',
            `#include <clipping_planes_fragment>
             float burnAhead = castleField(vDissolveWorld) - castleSweep(uDissolve);
             if (burnAhead < 0.0) discard;
             float burning = step(1e-4, uDissolve);
             float burnGlow = burning * (1.0 - smoothstep(0.0, BURN_WIDTH, burnAhead));
             float burnChar = burning * (1.0 - smoothstep(0.0, BURN_WIDTH * 3.5, burnAhead));`
          )
          .replace(
            '#include <tonemapping_fragment>',
            `gl_FragColor.rgb *= 1.0 - 0.85 * burnChar;
             gl_FragColor.rgb += uDissolveColor * (burnGlow * burnGlow * 6.0)
                               + vec3(1.0, 0.9, 0.75) * pow(burnGlow, 7.0) * 5.0;
             #include <tonemapping_fragment>`
          );
      },
      'duelhall-dissolve'
    );
  }

  /**
   * Embers thrown off the burning front. Each one is pinned to a point on the
   * castle's surface and computes, from the same field as the stone, the
   * moment the front passes it: from then it drifts up and in on the heat and
   * fades. Nothing is simulated — position is a function of the burn clock —
   * so the rebuild is the same film run backwards: the embers stream back in
   * and land on the wall just as the stone under them reforms.
   */
  _buildEmbers() {
    const meshes = EMBER_SOURCES.map((name) => this.castle.getObjectByName(name)).filter((m) => m?.isMesh);
    if (!meshes.length) return;
    this.castle.updateMatrixWorld(true);
    const samplers = meshes.map((mesh) => new MeshSurfaceSampler(mesh).build());
    const areas = samplers.map((s) => s.distribution[s.distribution.length - 1]);
    const total = areas.reduce((a, b) => a + b, 0);

    const positions = new Float32Array(EMBER_COUNT * 3);
    const seeds = new Float32Array(EMBER_COUNT * 4);
    let i = 0;
    samplers.forEach((sampler, m) => {
      const count = m === samplers.length - 1 ? EMBER_COUNT - i : Math.round((areas[m] / total) * EMBER_COUNT);
      for (let k = 0; k < count && i < EMBER_COUNT; k++, i++) {
        sampler.sample(_p);
        _p.applyMatrix4(meshes[m].matrixWorld);
        positions.set([_p.x, _p.y, _p.z], i * 3);
        seeds.set([Math.random(), Math.random(), Math.random(), Math.random()], i * 4);
      }
    });

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('aSeed', new BufferAttribute(seeds, 4));

    this.emberMaterial = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      fog: false,
      uniforms: {
        uClock: { value: this._burnClock },
        uDir: { value: this._burnDir },
        uDuration: { value: settings.hall.castleFade },
        uLife: { value: 2.6 },
        uSize: { value: 0.32 },
        uAmount: { value: 1 },
        uColor: this._burn.uDissolveColor,
        uPixelRatio: { value: this.environment.renderer?.gl.getPixelRatio() ?? 1 }
      },
      vertexShader: /* glsl */ `
        uniform float uClock;
        uniform float uDir;
        uniform float uDuration;
        uniform float uLife;
        uniform float uSize;
        uniform float uPixelRatio;
        attribute vec4 aSeed;
        varying float vAlpha;
        varying float vHeat;
        ${DISSOLVE_GLSL}
        void main() {
          // When the front reaches this point, in seconds into the burn — and
          // for a rebuild, which runs the sweep backwards, the same moment seen
          // from the other end. Either way 'age' is how far along its path the
          // ember is, so a rebuild flies the path in reverse.
          float at = (castleField(position) + BURN_WIDTH) / (1.0 + 2.0 * BURN_WIDTH);
          float released = uDir > 0.0 ? at * uDuration : (1.0 - at) * uDuration;
          float age = uDir > 0.0 ? uClock - released : released - uClock;
          float life = uLife * (0.55 + 0.9 * aSeed.w);
          float k = age / life;

          float t = max(age, 0.0);
          vec3 inward = normalize(vec3(-position.x, 0.0, -position.z) + vec3(1e-4));
          vec3 velocity = inward * (0.5 + 1.8 * aSeed.x)
                        + vec3(0.0, 0.8 + 1.8 * aSeed.y, 0.0)
                        + (aSeed.xzy - 0.5) * 1.6;
          vec3 p = position + velocity * t + vec3(0.0, 0.7, 0.0) * t * t;
          // Caught in the hot air: a lazy corkscrew that widens as it rises.
          float swirl = t * (1.4 + aSeed.z * 1.6) + aSeed.w * 30.0;
          p += vec3(sin(swirl), 0.0, cos(swirl)) * (0.25 + 0.5 * aSeed.y) * t;

          float alive = step(0.0, age) * step(k, 1.0);
          vAlpha = alive * smoothstep(0.0, 0.06, k) * pow(1.0 - clamp(k, 0.0, 1.0), 1.4);
          vHeat = 1.0 - clamp(k, 0.0, 1.0);

          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float size = uSize * (0.45 + aSeed.z) * mix(0.35, 1.0, vHeat);
          gl_PointSize = alive * size * uPixelRatio * (projectionMatrix[1][1] * 300.0) / -mv.z;
          gl_Position = alive > 0.5 ? projectionMatrix * mv : vec4(2.0, 2.0, 2.0, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uAmount;
        uniform vec3 uColor;
        varying float vAlpha;
        varying float vHeat;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float core = exp(-d * d * 14.0);
          float halo = exp(-d * d * 3.0) * 0.4;
          // White-hot as they leave the stone, cooling to the edge colour.
          vec3 color = mix(uColor * 1.6, vec3(1.0, 0.92, 0.8) * 3.0, vHeat * vHeat * vHeat);
          float a = (core + halo) * smoothstep(1.0, 0.75, d) * vAlpha * uAmount;
          gl_FragColor = vec4(color * a, 1.0);
        }`
    });
    this._materials.push(this.emberMaterial);
    this.embers = new Points(geometry, this.emberMaterial);
    this.embers.name = 'CastleEmbers';
    this.embers.frustumCulled = false;
    this.embers.layers.set(LAYER.VFX);
    this.embers.visible = false;
    this.group.add(this.embers);
  }

  /**
   * Darken the velvet without touching the embroidery: the gold is the
   * metallic part of the cloth's ORM map, so everything that is not metal is
   * scaled by `settings.hall.carpetBrightness`. The stage key lights the cloth
   * head-on, so the albedo alone cannot keep it a dark midnight blue.
   */
  _patchVelvet(material) {
    this._velvet = { value: settings.hall.carpetBrightness };
    this.environment.registerShadowCasterWithPatch(
      material,
      (shader) => {
        shader.uniforms.uVelvet = this._velvet;
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>
uniform float uVelvet;`)
          .replace(
            '#include <map_fragment>',
            `#include <map_fragment>
             #ifdef USE_METALNESSMAP
               float goldMask = smoothstep(0.05, 0.5, texture2D(metalnessMap, vMetalnessMapUv).b);
               diffuseColor.rgb *= mix(uVelvet, 1.0, goldMask);
             #endif`
          );
      },
      'duelhall-velvet'
    );
  }

  /** The same openings `Ground` cuts (see world/FloorHoles.js). */
  _patchFloorHoles(material) {
    this.environment.registerShadowCasterWithPatch(
      material,
      (shader) => {
        shader.uniforms.uFloorHoles = floorHoles.uniform;
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', `#include <common>\nvarying vec3 vHallWorld;`)
          .replace(
            '#include <begin_vertex>',
            `#include <begin_vertex>\nvHallWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`
          );
        shader.fragmentShader = shader.fragmentShader
          .replace(
            '#include <common>',
            `#include <common>
             varying vec3 vHallWorld;
             #define MAX_FLOOR_HOLES ${MAX_FLOOR_HOLES}
             uniform vec4 uFloorHoles[MAX_FLOOR_HOLES];`
          )
          .replace(
            '#include <clipping_planes_fragment>',
            `#include <clipping_planes_fragment>
             for (int i = 0; i < MAX_FLOOR_HOLES; i++) {
               vec4 hole = uFloorHoles[i];
               if (hole.z > 0.0 && distance(vHallWorld.xz, hole.xy) < hole.z) discard;
             }`
          );
      },
      'duelhall-floor-holes'
    );
  }

  /** Soft additive light shafts: bright at the window, fading down the beam and at its silhouette. */
  _godRayMaterial() {
    const m = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
      fog: false,
      uniforms: {
        uTime: { value: 0 },
        uIntensity: { value: 1 },
        uColor: { value: new Color(0.55, 0.7, 1.0) } // moonlight
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying vec3 vNormalW;
        varying vec3 vViewDir;
        varying vec3 vWorld;
        void main() {
          vUv = uv;
          vec4 world = modelMatrix * vec4(position, 1.0);
          vWorld = world.xyz;
          vNormalW = normalize(mat3(modelMatrix) * normal);
          vViewDir = normalize(cameraPosition - world.xyz);
          gl_Position = projectionMatrix * viewMatrix * world;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uIntensity;
        uniform vec3 uColor;
        varying vec2 vUv;
        varying vec3 vNormalW;
        varying vec3 vViewDir;
        varying vec3 vWorld;
        void main() {
          float along = vUv.y;
          float fade = pow(1.0 - along, 1.6) * smoothstep(0.0, 0.06, along);
          float facing = pow(abs(dot(normalize(vNormalW), normalize(vViewDir))), 1.4);
          // Slow drifting streaks of dust inside the beam.
          float streak = 0.65 + 0.35 * sin(vUv.x * 40.0 + vWorld.y * 0.35 + uTime * 0.25)
                                     * sin(vUv.x * 13.0 - uTime * 0.17);
          float a = fade * facing * streak * 0.055 * uIntensity;
          gl_FragColor = vec4(uColor * a, 1.0);
        }`
    });
    m.userData.vfx = true;
    this._materials.push(m);
    return m;
  }

  /** Fold the repeated nodes into one InstancedMesh per primitive. */
  _buildInstances(instanced, mats) {
    const build = (nodes, name) => {
      if (!nodes.length) return [];
      const prims = [];
      nodes[0].traverse((n) => n.isMesh && prims.push(n));
      return prims.map((prim, p) => {
        const material = mats[prim.material?.name] ?? prim.material;
        // The book colours were painted into the second colour set; COLOR_0 is
        // an untouched all-white layer the export carries along.
        const tint = prim.geometry.getAttribute('color_1');
        if (tint) prim.geometry.setAttribute('color', tint);
        const mesh = new InstancedMesh(prim.geometry, material, nodes.length);
        mesh.name = `${name}_${p}`;
        nodes.forEach((node, i) => {
          // node.matrixWorld was computed while it was still under the export root.
          const target = node.isMesh ? node : node.children[p] ?? node;
          mesh.setMatrixAt(i, target === node ? node.matrixWorld : _m.multiplyMatrices(node.matrixWorld, target.matrix));
        });
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
        if (material?.userData?.vfx) mesh.layers.set(LAYER.VFX);
        (name === 'Bookshelves' ? this.castle : this.group).add(mesh);
        return mesh;
      });
    };

    this.shelves = build(instanced.shelf, 'Bookshelves');
    const [candles] = build(instanced.candle, 'Candles');
    const [flames] = build(instanced.flame, 'CandleFlames');
    this.candles = candles;
    this.flames = flames;

    // Per-candle bob state, and each flame's offset from its candle.
    this._candleBase = instanced.candle.map((node) => node.matrixWorld.clone());
    this._flameLocal = instanced.flame.map((node) => node.matrix.clone());
    this._flameOwner = instanced.flame.map((node) => instanced.candle.indexOf(node.parent));
    // Flames were children: their parent is gone now, so look them up by name.
    if (this._flameOwner.some((i) => i < 0)) {
      const byName = new Map(instanced.candle.map((n, i) => [n.name.slice('Candle_'.length), i]));
      this._flameOwner = instanced.flame.map((n) => byName.get(n.name.slice('CandleFlame_'.length)) ?? 0);
    }
    this._candlePhase = instanced.candle.map(() => Math.random() * Math.PI * 2);
    this._candleSpeed = instanced.candle.map(() => 0.35 + Math.random() * 0.35);
  }

  _collectAnimated(root) {
    const spin = (name, turnsPerSecond, local = false) => {
      const object = root.getObjectByName(name);
      if (object) this._spinners.push({ object, base: object.quaternion.clone(), rate: turnsPerSecond, local });
    };
    spin('RuneRing_A', 0.012);
    spin('RuneRing_B', -0.018);
    spin('RuneRing_C', 0.025);
    spin('FloorSigil', -0.005);
    spin('DebrisRocks', 0.004);
    spin('OrreryRing_0', 0.008, true);
    spin('OrreryRing_1', -0.012, true);
    spin('OrreryRing_2', 0.017, true);
    spin('OrreryRing_3', -0.025, true);
    spin('OrreryCage', 0.03, true);

    this._ringA = root.getObjectByName('RuneRing_A');
    if (this._ringA) this._ringABase = this._ringA.position.y;
    this._sigil = root.getObjectByName('FloorSigil');
    if (this._sigil) this._sigilBase = this._sigil.position.y;

    const debris = root.getObjectByName('DebrisRocks');
    if (debris) {
      this._debris = debris;
      this._bobbers.push({ object: debris, base: debris.position.y, amp: 0.25, speed: 0.2, phase: 0, sinks: true });
    }

    const shafts = root.getObjectByName('GodRayShafts');
    if (shafts) {
      shafts.traverse((n) => {
        if (!n.isMesh) return;
        n.material = this.godRayMaterial;
        n.layers.set(LAYER.VFX);
        n.renderOrder = 2;
      });
    }
  }

  /** A soft additive halo on every flame — one Points draw. */
  _buildCandleGlow(flameNodes) {
    const count = flameNodes.length;
    if (!count) return;
    const geometry = new BufferGeometry();
    this._glowPositions = new Float32Array(count * 3);
    const seeds = new Float32Array(count);
    for (let i = 0; i < count; i++) seeds[i] = Math.random();
    geometry.setAttribute('position', new BufferAttribute(this._glowPositions, 3));
    geometry.setAttribute('aSeed', new BufferAttribute(seeds, 1));

    this.glowMaterial = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      fog: false,
      uniforms: {
        uTime: { value: 0 },
        uSize: { value: 2.1 },
        uAmount: { value: 1 },
        uPixelRatio: { value: this.environment.renderer?.gl.getPixelRatio() ?? 1 }
      },
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform float uSize;
        uniform float uPixelRatio;
        attribute float aSeed;
        varying float vFlicker;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vFlicker = 0.8 + 0.2 * sin(uTime * (7.0 + aSeed * 5.0) + aSeed * 40.0);
          gl_PointSize = uSize * uPixelRatio * (projectionMatrix[1][1] * 300.0) / -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uAmount;
        varying float vFlicker;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float core = exp(-d * d * 18.0);
          float halo = exp(-d * d * 3.5) * 0.35;
          float a = (core + halo) * smoothstep(1.0, 0.7, d) * vFlicker * uAmount;
          gl_FragColor = vec4(vec3(1.0, 0.62, 0.28) * a, 1.0);
        }`
    });
    this._materials.push(this.glowMaterial);
    this.glow = new Points(geometry, this.glowMaterial);
    this.glow.frustumCulled = false;
    this.glow.layers.set(LAYER.VFX);
    this.group.add(this.glow);
  }

  setVisible(on) {
    this._visible = on;
    this.group.visible = on && !this._ar;
    this._applyStage();
    this._applyLightLevels();
  }

  /**
   * The stone plane. With no hall it is the stage, at y = 0 — and AR always
   * wants it there, as the shadow catcher. Inside the castle it is hidden: the
   * cloth is the stage and the hall has its own floor. With the castle gone it
   * comes back as the ground under the floating platform, running out into
   * the fog: it appears just under the hall's floor as the burn starts (so the
   * two never fight) and rises with it to `groundDepth`.
   */
  _applyStage() {
    const open = this.group.visible && this._burnShown > 0;
    this.ground.mesh.visible = !this.group.visible || open;
    const rise = this._burnEase();
    this.ground.setHeight(open ? HALL_FLOOR - 0.3 + (settings.hall.groundDepth - HALL_FLOOR + 0.3) * rise : 0);
  }

  /** The burn, eased, for the things that travel with it. */
  _burnEase() {
    const u = this._burnShown;
    return u * u * (3 - 2 * u);
  }

  /** Point the burn the other way, picking it up from wherever it is now. */
  _startBurn(away) {
    const dir = away ? 1 : -1;
    if (dir === this._burnDir) return;
    this._burnDir = dir;
    // The clock is how far into a full burn in this direction the castle
    // already is, so a switch flipped mid-burn reverses from there.
    const duration = Math.max(0.05, settings.hall.castleFade);
    this._burnClock = (away ? this._burnShown : 1 - this._burnShown) * duration;
  }

  setAR(on) {
    this._ar = on;
    this.setVisible(this._visible ?? settings.hall.enabled);
  }

  _applyLightLevels() {
    const k = this.group.visible ? settings.hall.lightIntensity : 0;
    const shown = this._burnShown;
    for (const { light, base, open } of this.lights) light.intensity = base * k * (1 + (open - 1) * shown);
  }

  /** Advance the castle's burn (or rebuild) on wall-clock time. */
  _updateBurn(realDt) {
    const hall = settings.hall;
    this._startBurn(!hall.castle);
    const duration = Math.max(0.05, hall.castleFade);
    // Hall switched off (or AR) mid-burn: land on the end state instead.
    if (!this.group.visible) this._burnClock = 1e4;
    else if (this._burnClock < 1e4) this._burnClock += realDt;
    const progress = Math.min(1, this._burnClock / duration);
    this._burnShown = this._burnDir > 0 ? progress : 1 - progress;

    this._burn.uDissolve.value = this._burnShown;
    this._burn.uDissolveColor.value.copy(getColor(hall.castleEdge));
    this.castle.visible = this._burnShown < 1;
    this.godRayMaterial.uniforms.uIntensity.value = hall.godRays * (1 - this._burnShown) ** 2;

    if (this.embers) {
      const u = this.emberMaterial.uniforms;
      const life = u.uLife.value * 1.45;
      this.embers.visible = hall.castleEmbers > 0 && this._burnClock < duration + life;
      u.uClock.value = this._burnClock;
      u.uDir.value = this._burnDir;
      u.uDuration.value = duration;
      u.uAmount.value = hall.castleEmbers;
    }

    // The rubble under the platform reaches up to y = -1, through the raised
    // floor and the top rune ring: it sinks out of sight as the floor rises,
    // and stops drawing once it is under.
    this._debrisSink = DEBRIS_SINK * this._burnEase();
    if (this._debris) this._debris.visible = this._burnShown < 1;

    if (this._ringA) {
      const e = this._burnEase();
      const lifted = OPEN_RING_Y - this._root.position.y;
      this._ringA.position.y = this._ringABase + (lifted - this._ringABase) * e;
      this._ringA.scale.setScalar(1 + (OPEN_RING_SCALE - 1) * e);
    }

    // The floor sigil rides up on the stone plane.
    if (this._sigil) {
      const target = hall.groundDepth + 0.05 - this._root.position.y;
      this._sigil.position.y = this._sigilBase + (target - this._sigilBase) * this._burnEase();
    }
    this._applyStage();
  }

  update(dt, elapsed, realDt = dt) {
    if (!this.loaded) return;
    const hall = settings.hall;
    if (hall.enabled !== this._visible) this.setVisible(hall.enabled);
    this._updateBurn(realDt);
    if (!this.group.visible) return;
    this._applyLightLevels();

    const t = elapsed * hall.motion;
    for (const s of this._spinners) {
      _q.setFromAxisAngle(_axisY, t * s.rate * Math.PI * 2);
      // The top rune ring's authored wobble (about 5 degrees) is levelled out as
      // it rises to the stage: out there it would lift one side over the cloth.
      let base = s.base;
      if (s.object === this._ringA) base = _tilt.copy(s.base).slerp(_level, this._burnEase());
      if (s.local) s.object.quaternion.copy(base).multiply(_q);
      else s.object.quaternion.copy(_q).multiply(base);
    }
    for (const b of this._bobbers) {
      b.object.position.y = b.base + Math.sin(t * b.speed + b.phase) * b.amp - (b.sinks ? this._debrisSink : 0);
    }

    this.godRayMaterial.uniforms.uTime.value = elapsed;
    this.runeMaterial.opacity = hall.runeGlow;
    if (this._velvet) this._velvet.value = hall.carpetBrightness;

    // Floating candles: a slow, individual bob; flames and halos ride along.
    if (this.candles) {
      const n = this._candleBase.length;
      const bobs = this._bobOffsets ?? (this._bobOffsets = new Float32Array(n));
      for (let i = 0; i < n; i++) {
        const y = Math.sin(t * this._candleSpeed[i] + this._candlePhase[i]) * 0.18;
        bobs[i] = y;
        _m.copy(this._candleBase[i]);
        _m.elements[13] += y;
        this.candles.setMatrixAt(i, _m);
      }
      this.candles.instanceMatrix.needsUpdate = true;
      if (this.flames) {
        for (let i = 0; i < this._flameLocal.length; i++) {
          const owner = this._flameOwner[i];
          _m.copy(this._candleBase[owner]);
          _m.elements[13] += bobs[owner];
          _m.multiply(this._flameLocal[i]);
          this.flames.setMatrixAt(i, _m);
          if (this._glowPositions) {
            _m.decompose(_p, _q, _s);
            this._glowPositions[i * 3] = _p.x;
            this._glowPositions[i * 3 + 1] = _p.y + 0.05;
            this._glowPositions[i * 3 + 2] = _p.z;
          }
        }
        this.flames.instanceMatrix.needsUpdate = true;
      }
      if (this.glow) {
        this.glow.geometry.attributes.position.needsUpdate = true;
        this.glowMaterial.uniforms.uTime.value = elapsed;
        this.glowMaterial.uniforms.uAmount.value = hall.candleGlow;
      }
    }
  }

  dispose() {
    this.group.traverse((n) => {
      if (n.isMesh || n.isPoints) n.geometry.dispose();
    });
    for (const m of this._materials) m.dispose();
    for (const t of this._textures) t.dispose();
  }
}
