import GUI from 'lil-gui';
import { settings, CAST_ANIMATIONS } from '../config/settings.js';
import { PresetManager } from './PresetManager.js';

/**
 * Real-time VFX editor.
 *
 * Every control binds straight to a field in `config/settings.js`. Because all
 * shaders, particle systems, lights and post passes *read* those fields each
 * frame, no controller needs an onChange handler: moving a slider updates the
 * prison that is already standing, the lance that is already in the air, the
 * next cast, the environment and the post stack simultaneously, with no rebuild
 * and no shader recompilation.
 *
 * That holds while the simulation is paused (`P`), which is the point — the
 * silhouette of a frozen shatter and the shape of a stopped wake are the
 * things worth tuning, and every ability re-resolves itself from these
 * values on a zero-length frame.
 */
export class Editor {
  /**
   * @param {object} hooks { onClear, onToast }
   */
  constructor(hooks = {}) {
    this.hooks = hooks;
    this.presets = new PresetManager();

    this.gui = new GUI({ title: 'VFX Editor', width: 330 });
    this.gui.domElement.style.setProperty('--title-height', '30px');

    this._presetState = { name: 'My preset', selected: this.presets.names[0] ?? '' };

    this._buildPresets();
    this._buildGlobal();
    this._buildAim();
    this._buildZone();
    this._buildShark();
    this._buildChains();
    this._buildDragon();
    this._buildGyro();
    this._buildAmethyst();
    this._buildTome();
    this._buildReliquary();
    this._buildEnvironment();
    this._buildHall();
    this._buildPost();
    this._buildCamera();
    this._buildCharacter();
    this._buildDummies();

    // Everything starts collapsed, top-level folders included. There are enough
    // controls here that any folder left open pushes the rest off the screen,
    // so the panel opens as a list of sections and the user picks one.
    this.gui.foldersRecursive().forEach((folder) => folder.close());
  }

  /* ------------------------------------------------------------------ */
  /* helpers                                                             */
  /* ------------------------------------------------------------------ */

  static range(folder, object, key, min, max, step, label) {
    return folder.add(object, key, min, max, step).name(label ?? key);
  }

  /**
   * Which clip the body throws when this ability fires.
   *
   * One per ability, because the gesture is part of how a spell reads — the
   * prison and the lance should not be cast the same way. `App` reads the value
   * at the moment of the cast, so switching it applies to the very next click.
   */
  static castAnimation(folder, object) {
    return folder.add(object, 'castAnim', CAST_ANIMATIONS).name('cast animation');
  }

  /**
   * The four colour stops of a particle system's lifetime gradient.
   *
   * `ParticleSystem#setGradient` samples them across a particle's own life, so
   * they are labelled by *when* they are seen rather than by what they are —
   * `A` is the instant it is born, `D` is the moment it dies.
   *
   * @param {string} prefix settings key without the A/B/C/D suffix
   */
  static gradient(folder, object, prefix, title) {
    const group = folder.addFolder(title);
    group.addColor(object, `${prefix}A`).name('birth');
    group.addColor(object, `${prefix}B`).name('early');
    group.addColor(object, `${prefix}C`).name('late');
    group.addColor(object, `${prefix}D`).name('death');
    return group;
  }

  refresh() {
    this.gui.controllersRecursive().forEach((controller) => controller.updateDisplay());
  }

  toggle() {
    this.setHidden(!this._hidden);
  }

  /** Whether the column is currently stood down. */
  get hidden() {
    return this._hidden;
  }

  /**
   * Force a visibility. Remembers nothing — the caller owns the previous state,
   * because the only thing that drives this is camera mode wanting the right
   * hand column back, and it has to be able to give it up again.
   */
  setHidden(hidden) {
    this._hidden = hidden;
    this.gui.show(!hidden);
  }

  /* ------------------------------------------------------------------ */
  /* folders                                                             */
  /* ------------------------------------------------------------------ */

  _buildPresets() {
    const folder = this.gui.addFolder('Presets');
    const state = this._presetState;

    let selector = folder
      .add(state, 'selected', this.presets.names.length ? this.presets.names : [''])
      .name('preset');

    // lil-gui rebuilds the controller when the option list changes, so the
    // reference has to be replaced rather than mutated.
    const refreshOptions = () => {
      const names = this.presets.names;
      selector = selector.options(names.length ? names : ['']).name('preset');
      selector.setValue(names.includes(state.selected) ? state.selected : (names[0] ?? ''));
    };

    folder.add(state, 'name').name('name');

    folder
      .add(
        {
          save: () => {
            this.presets.save(state.name);
            state.selected = state.name;
            refreshOptions();
            this.hooks.onToast?.(`Saved preset "${state.name}"`);
          }
        },
        'save'
      )
      .name('Save preset');

    folder
      .add(
        {
          load: () => {
            if (this.presets.load(state.selected)) {
              this.refresh();
              this.hooks.onToast?.(`Loaded "${state.selected}"`);
            }
          }
        },
        'load'
      )
      .name('Load preset');

    folder
      .add(
        {
          duplicate: () => {
            const copy = this.presets.duplicate(state.selected);
            if (copy) {
              state.selected = copy;
              refreshOptions();
              this.hooks.onToast?.(`Duplicated to "${copy}"`);
            }
          }
        },
        'duplicate'
      )
      .name('Duplicate');

    folder
      .add(
        {
          remove: () => {
            if (this.presets.remove(state.selected)) {
              refreshOptions();
              this.hooks.onToast?.('Preset deleted');
            }
          }
        },
        'remove'
      )
      .name('Delete');

    folder.add({ exportOne: () => this.presets.exportJSON() }, 'exportOne').name('Export current (JSON)');
    folder.add({ exportAll: () => this.presets.exportAll() }, 'exportAll').name('Export all presets');

    folder
      .add(
        {
          import: async () => {
            const result = await this.presets.importFromFile();
            refreshOptions();
            this.refresh();
            this.hooks.onToast?.(
              result.applied
                ? 'Settings imported'
                : result.imported.length
                  ? `Imported ${result.imported.length} preset(s)`
                  : 'Nothing imported'
            );
          }
        },
        'import'
      )
      .name('Import JSON…');

    folder
      .add(
        {
          reset: () => {
            this.presets.reset();
            this.refresh();
            this.hooks.onToast?.('Reset to defaults');
          }
        },
        'reset'
      )
      .name('Reset to defaults');

    this.presetFolder = folder;
  }

  _buildGlobal() {
    const folder = this.gui.addFolder('Global');
    const g = settings.global;
    const R = Editor.range;

    R(folder, g, 'timeScale', 0.02, 2, 0.01, 'time scale');
    R(folder, g, 'speed', 0.1, 4, 0.01, 'cast speed');
    R(folder, g, 'lifetime', 0.1, 4, 0.01, 'lifetime');
    R(folder, g, 'glow', 0, 5, 0.01, 'glow intensity');
    R(folder, g, 'shaderIntensity', 0, 2, 0.01, 'shader intensity');
    R(folder, g, 'opacity', 0, 2, 0.01, 'opacity');
    R(folder, g, 'noiseFrequency', 0.1, 4, 0.01, 'noise frequency');
    R(folder, g, 'noiseSpeed', 0, 4, 0.01, 'noise speed');
    R(folder, g, 'turbulence', 0, 4, 0.01, 'turbulence');
    R(folder, g, 'randomness', 0, 2, 0.01, 'randomness');
    R(folder, g, 'fresnel', 0, 3, 0.01, 'fresnel strength');
    R(folder, g, 'distortion', 0, 3, 0.01, 'heat distortion');

    const particles = folder.addFolder('Particles');
    R(particles, g, 'particleCount', 0, 3, 0.01, 'count');
    R(particles, g, 'particleLifetime', 0.1, 3, 0.01, 'lifetime');
    R(particles, g, 'particleSpeed', 0.1, 3, 0.01, 'speed');
    R(particles, g, 'particleSize', 0.1, 3, 0.01, 'size');
    R(particles, g, 'emissionRate', 0, 3, 0.01, 'emission rate');

    const lighting = folder.addFolder('Lighting & impact');
    R(lighting, g, 'lightIntensity', 0, 4, 0.01, 'light intensity');
    R(lighting, g, 'lightRadius', 0.1, 4, 0.01, 'light radius');
    R(lighting, g, 'explosionIntensity', 0, 3, 0.01, 'impact intensity');
    R(lighting, g, 'cameraShake', 0, 3, 0.01, 'camera shake');
    R(lighting, g, 'animationSpeed', 0, 3, 0.01, 'animation speed');

    this.globalFolder = folder;
  }

  /* ------------------------------------------------------------------ */

  _buildAim() {
    const folder = this.gui.addFolder('➤  Aim indicator');
    const a = settings.aim;
    const R = Editor.range;

    const shape = folder.addFolder('Silhouette (metres)');
    R(shape, a, 'shaftWidth', 0.05, 2, 0.01, 'shaft half-width');
    R(shape, a, 'headLength', 0.2, 8, 0.05, 'head length');
    R(shape, a, 'headWidth', 0.1, 5, 0.01, 'head half-width');
    R(shape, a, 'round', 0, 0.6, 0.01, 'corner rounding');
    R(shape, a, 'startOffset', 0, 5, 0.05, 'gap at the caster');
    R(shape, a, 'height', 0.005, 0.4, 0.005, 'hover height');

    const look = folder.addFolder('Rendering');
    R(look, a, 'edge', 0.01, 0.5, 0.005, 'outline thickness');
    R(look, a, 'edgeGlow', 0, 8, 0.05, 'outline glow');
    R(look, a, 'softness', 0.005, 0.5, 0.005, 'edge softness');
    R(look, a, 'fill', 0, 1.5, 0.01, 'interior fill');
    R(look, a, 'fillFalloff', 0.1, 4, 0.05, 'fill falloff');
    R(look, a, 'opacity', 0, 2, 0.01, 'opacity');
    look.addColor(a, 'colorCore').name('core colour');
    look.addColor(a, 'colorEdge').name('edge colour');
    look.addColor(a, 'colorInvalid').name('too-close colour');

    const energy = folder.addFolder('Energy & frost');
    R(energy, a, 'stripes', 0, 4, 0.01, 'chevrons / metre');
    R(energy, a, 'stripeSharp', 0, 1, 0.01, 'chevron sharpness');
    R(energy, a, 'stripeDepth', 0, 1, 0.01, 'chevron depth');
    R(energy, a, 'scrollSpeed', -10, 10, 0.05, 'scroll speed');
    R(energy, a, 'pulse', 0, 1, 0.01, 'pulse');
    R(energy, a, 'pulseSpeed', 0, 8, 0.05, 'pulse speed');
    R(energy, a, 'noise', 0, 1.5, 0.01, 'frost noise');
    R(energy, a, 'noiseScale', 0.1, 8, 0.05, 'noise scale');
    R(energy, a, 'noiseSpeed', 0, 3, 0.01, 'noise speed');
    R(energy, a, 'crystals', 0, 2, 0.01, 'frost plates');
    R(energy, a, 'crystalScale', 0.2, 10, 0.05, 'plate scale');

    const furniture = folder.addFolder('Rings & rosette');
    R(furniture, a, 'baseRing', 0, 3, 0.01, 'base ring radius');
    R(furniture, a, 'baseRingWidth', 0.005, 0.4, 0.005, 'base ring width');
    R(furniture, a, 'tipGlyph', 0, 2, 0.01, 'tip rosette');
    R(furniture, a, 'tipGlyphSize', 0.1, 4, 0.05, 'rosette radius');
    R(furniture, a, 'tipSpin', -3, 3, 0.01, 'rosette spin');
    R(furniture, a, 'rangeArc', 0, 2, 0.01, 'range arc');
    R(furniture, a, 'reveal', 0.01, 1, 0.005, 'sweep-out time');
  }

  /* ------------------------------------------------------------------ */

  /**
   * The far-cast indicator — the circle every zone ability is aimed with.
   *
   * Shared, like the arrow: it is a property of the *targeting*, not of any one
   * ability, so a second far cast inherits the whole thing and brings only its
   * own `zoneRadius`. The two controls worth reaching for first are `boundary`
   * (how thick the footprint edge reads) and `snap` (how hard it overshoots on
   * the way out), which between them decide whether the circle feels like a UI
   * overlay or like something the caster is doing.
   */
  _buildZone() {
    const folder = this.gui.addFolder('◎  Far-cast circle');
    const z = settings.zone;
    const R = Editor.range;

    const edge = folder.addFolder('The boundary (metres)');
    R(edge, z, 'boundary', 0.02, 2, 0.01, 'band thickness');
    R(edge, z, 'boundaryBias', 0, 1, 0.01, 'band bias out/in');
    R(edge, z, 'boundaryGlow', 0, 8, 0.05, 'band glow');
    R(edge, z, 'liner', 0.005, 0.4, 0.005, 'inner liner');
    R(edge, z, 'softness', 0.005, 0.4, 0.005, 'edge softness');
    R(edge, z, 'height', 0.005, 0.4, 0.005, 'hover height');

    const inside = folder.addFolder('The interior');
    R(inside, z, 'fill', 0, 1.5, 0.01, 'interior fill');
    R(inside, z, 'fillFalloff', 0.1, 5, 0.05, 'fill falloff');
    R(inside, z, 'rings', 0, 12, 0.1, 'contour rings');
    R(inside, z, 'ringWidth', 0.005, 0.5, 0.005, 'ring width');
    R(inside, z, 'ringSpeed', -4, 4, 0.01, 'ring speed');
    R(inside, z, 'crawl', 0, 3, 0.01, 'filaments');
    R(inside, z, 'crawlScale', 0.1, 8, 0.05, 'filaments / metre');
    R(inside, z, 'crawlSpeed', -4, 4, 0.01, 'filament crawl');
    R(inside, z, 'noise', 0, 1.5, 0.01, 'break-up');
    R(inside, z, 'noiseScale', 0.1, 8, 0.05, 'break-up scale');

    const furniture = folder.addFolder('Ticks, sweep & reticle');
    R(furniture, z, 'ticks', 0, 96, 1, 'boundary ticks');
    R(furniture, z, 'tickLength', 0.05, 3, 0.01, 'tick length');
    R(furniture, z, 'tickWidth', 0.02, 0.9, 0.01, 'tick duty');
    R(furniture, z, 'tickSpin', -2, 2, 0.005, 'tick spin');
    R(furniture, z, 'sweep', 0, 3, 0.01, 'radar sweep');
    R(furniture, z, 'sweepSpeed', -3, 3, 0.01, 'sweep speed');
    R(furniture, z, 'core', 0, 3, 0.01, 'centre mark');
    R(furniture, z, 'coreSize', 0.05, 3, 0.01, 'centre size');
    R(furniture, z, 'crosshair', 0, 3, 0.01, 'reticle arms');
    R(furniture, z, 'crosshairLength', 0.1, 6, 0.05, 'arm length');
    R(furniture, z, 'pulse', 0, 1, 0.01, 'pulse');
    R(furniture, z, 'pulseSpeed', 0, 8, 0.05, 'pulse speed');

    const reach = folder.addFolder('The reach ring');
    R(reach, z, 'reach', 0, 3, 0.01, 'reach brightness');
    R(reach, z, 'reachWidth', 0.005, 0.5, 0.005, 'reach width');
    R(reach, z, 'reachDashes', 0, 200, 1, 'dashes');
    R(reach, z, 'reachDashGap', 0, 0.95, 0.01, 'dash gap');
    R(reach, z, 'reachSpin', -1, 1, 0.005, 'dash creep');
    R(reach, z, 'reachLead', 0, 3, 0.01, 'lead marker');

    const look = folder.addFolder('Rendering');
    R(look, z, 'opacity', 0, 2, 0.01, 'opacity');
    R(look, z, 'reveal', 0.01, 1, 0.005, 'snap-out time');
    R(look, z, 'snap', 1, 2, 0.01, 'snap overshoot');
    look.addColor(z, 'colorCore').name('core colour');
    look.addColor(z, 'colorEdge').name('fill colour');
    look.addColor(z, 'colorInvalid').name('too-close colour');
  }

  _buildShark() {
    const folder = this.gui.addFolder('🦈  Abyssal Maw');
    const c = settings.shark;
    const R = Editor.range;

    const cast = folder.addFolder('The cast');
    R(cast, c, 'range', 4, 60, 0.1, 'max range');
    R(cast, c, 'minRange', 0, 12, 0.1, 'min range');
    R(cast, c, 'zoneRadius', 0.3, 4, 0.05, 'target ring (m)');
    R(cast, c, 'snapRadius', 0, 8, 0.05, 'locks onto bodies within (m)');
    R(cast, c, 'speed', 4, 150, 0.5, 'run to the target (m/s)');
    R(cast, c, 'showTime', 1, 12, 0.05, 'portals stand for at least (s)');
    R(cast, c, 'fadeTime', 0.1, 8, 0.05, 'stains dry over (s)');
    R(cast, c, 'cooldown', 0, 15, 0.05, 'cooldown');
    Editor.castAnimation(cast, c);

    const timing = folder.addFolder('The timing');
    R(timing, c, 'rockDelay', 0, 2, 0.01, 'rock bursts up at (s)');
    R(timing, c, 'rockRise', 0.02, 0.6, 0.005, 'rock stands in (s)');
    R(timing, c, 'hangTime', 0.1, 1.5, 0.01, 'kick to bite (s)');
    R(timing, c, 'emergeTime', 0.05, 1, 0.01, 'climbs its well in (s)');
    R(timing, c, 'flightTime', 0.3, 3, 0.01, 'in the air for (s)');
    R(timing, c, 'diveTime', 0.1, 2, 0.01, 'dives for (s)');

    const rock = folder.addFolder('1 · The rock');
    R(rock, c, 'rockHeight', 0.3, 5, 0.05, 'height (m)');
    R(rock, c, 'rockWidth', 0.3, 3, 0.05, 'girth');
    R(rock, c, 'rockHold', 0, 5, 0.05, 'stands for (s)');
    R(rock, c, 'rockSink', 0.1, 3, 0.05, 'crumbles over (s)');
    R(rock, c, 'rockChips', 0, 32, 1, 'chunks thrown');
    R(rock, c, 'rockGrit', 0, 300, 1, 'grit');
    R(rock, c, 'rockDust', 0, 60, 1, 'dust puffs');
    R(rock, c, 'rockShake', 0, 1.5, 0.01, 'shake');
    const kick = rock.addFolder('The kick');
    R(kick, c.kick, 'impulse', 0, 10, 0.05, 'along the cast (m/s)');
    R(kick, c.kick, 'lift', 0, 25, 0.1, 'up (m/s)');
    R(kick, c.kick, 'spin', 0, 5, 0.05, 'tumble');
    R(kick, c, 'hangGrip', 0, 0.5, 0.005, 'steered onto the jaw');
    const stone = rock.addFolder('The stone');
    R(stone, c, 'texScale', 0.3, 8, 0.05, 'scan tile (m)');
    R(stone, c, 'texAmount', 0, 1, 0.01, 'scan amount');
    R(stone, c, 'normalScale', 0, 3, 0.05, 'relief');
    R(stone, c, 'stoneRough', 0.2, 1.5, 0.01, 'roughness');
    R(stone, c, 'rockDamp', 0, 1, 0.01, 'damp root');
    R(stone, c, 'dustCoat', 0, 1, 0.01, 'dust settling on it');
    R(stone, c, 'stoneDesat', 0, 1, 0.01, 'desaturate');
    R(stone, c, 'stoneGrade', 0, 1, 0.01, 'grade');
    stone.addColor(c, 'colorStoneGrade').name('grade colour');
    stone.addColor(c, 'colorStone').name('stone');
    stone.addColor(c, 'colorStoneDeep').name('stone, deep');
    stone.addColor(c, 'colorDustCoat').name('dust coat');
    stone.addColor(c, 'colorDust').name('dust cloud');

    const portals = folder.addFolder('2 · The portals');
    R(portals, c, 'portalRadius', 0.5, 4, 0.01, 'radius (m)');
    R(portals, c, 'portalSpan', 1.5, 12, 0.05, 'from the target (m)');
    R(portals, c, 'openTime', 0.02, 2, 0.01, 'tear open in (s)');
    R(portals, c, 'closeDelay', 0, 3, 0.01, 'close after the shark (s)');
    R(portals, c, 'closeTime', 0.05, 3, 0.01, 'spiral shut in (s)');
    R(portals, c, 'swirl', 0, 6, 0.05, 'vortex (rad/s)');
    R(portals, c, 'closeSwirl', 0, 20, 0.1, 'vortex closing');
    const water = portals.addFolder('The water');
    R(water, c, 'clarity', 0, 1, 0.01, 'opacity head-on');
    R(water, c, 'ripple', 0, 0.3, 0.001, 'waves (m)');
    R(water, c, 'rippleScale', 0.1, 5, 0.01, 'wave scale');
    R(water, c, 'rippleSpeed', 0, 4, 0.01, 'wave speed');
    R(water, c, 'sheen', 0, 4, 0.01, 'sun highlight');
    R(water, c, 'gloss', 0, 1, 0.01, 'gloss');
    R(water, c, 'reflection', 0, 2, 0.01, 'sky reflection');
    R(water, c, 'caustic', 0, 2, 0.01, 'caustics');
    R(water, c, 'foam', 0, 2, 0.01, 'foam at the wall');
    R(water, c, 'foamWidth', 0.02, 1, 0.01, 'foam width (m)');
    R(water, c, 'churnDecay', 0.1, 6, 0.05, 'white water settles');
    R(water, c, 'abyssGlow', 0, 3, 0.01, 'glow from the deep');
    const well = portals.addFolder('The well');
    R(well, c, 'wellDepth', 2, 30, 0.1, 'depth (m)');
    R(well, c, 'depthFog', 0.05, 2, 0.01, 'depth fog (1/m)');
    R(well, c, 'wellRays', 0, 4, 0.01, 'light shafts');
    const stain = portals.addFolder('The stone round it');
    R(stain, c, 'lip', 0, 0.5, 0.005, 'torn lip (m)');
    R(stain, c, 'wetReach', 1, 3, 0.01, 'wet stain reach');
    R(stain, c, 'wetDark', 0, 1, 0.01, 'wet stain');
    R(stain, c, 'cracks', 0, 2, 0.01, 'cracks');
    R(stain, c, 'crackReach', 1, 3.5, 0.01, 'cracks reach');
    R(stain, c, 'crackGlow', 0, 6, 0.05, 'crack glow');
    R(stain, c, 'rune', 0, 3, 0.01, 'rune');
    R(stain, c, 'runeRadius', 1.05, 2.5, 0.01, 'rune radius');
    R(stain, c, 'runeSpin', -3, 3, 0.01, 'rune turn (rad/s)');
    const warp = portals.addFolder('Refraction');
    R(warp, c, 'warpStrength', 0, 3, 0.01, 'strength');
    R(warp, c, 'warpScale', 0.1, 5, 0.01, 'scale');
    R(warp, c, 'warpSpeed', 0, 4, 0.01, 'speed');

    const shark = folder.addFolder('3 · The shark');
    R(shark, c, 'length', 1.5, 10, 0.05, 'length (m)');
    R(shark, c, 'biteHeight', 0.8, 6, 0.05, 'bites at (m)');
    R(shark, c, 'emergeDepth', 0.5, 10, 0.05, 'starts its run from (m down)');
    R(shark, c, 'diveDepth', 0.5, 15, 0.05, 'dives to (m down)');
    R(shark, c, 'diveDrift', -2, 3, 0.01, 'carries on under water (m)');
    R(shark, c, 'socketDepth', 0, 1, 0.01, 'held how far back in the mouth');
    R(shark, c, 'biteSnap', 0.01, 0.5, 0.005, 'jaw takes hold in (s)');
    R(shark, c, 'deathRoll', -3, 3, 0.05, 'death roll (turns)');
    R(shark, c, 'rollTime', 0.05, 2, 0.01, 'roll takes (s)');
    R(shark, c, 'thrashRoll', 0, 60, 1, 'thrash rock (deg)');
    R(shark, c, 'thrashRate', 0.5, 5, 0.05, 'thrash rocks / s');
    R(shark, c, 'thrashTime', 0.1, 2, 0.01, 'thrash dies in (s)');
    R(shark, c, 'dissolveDepth', 0.2, 8, 0.05, 'body taken over (m down)');
    R(shark, c, 'wetness', 0, 1, 0.01, 'wet skin');
    R(shark, c, 'sharkRim', 0, 3, 0.01, 'rim');
    R(shark, c, 'sharkRimPower', 0.5, 8, 0.05, 'rim tightness');
    shark.addColor(c, 'colorRim').name('rim colour');

    const splash = folder.addFolder('4 · The splash');
    R(splash, c, 'crownHeight', 0, 6, 0.05, 'crown height (m)');
    R(splash, c, 'crownRadius', 0.2, 2, 0.01, 'crown radius');
    R(splash, c, 'crownSpread', 0, 2, 0.01, 'crown flare');
    R(splash, c, 'crownTime', 0.2, 3, 0.01, 'crown lasts (s)');
    R(splash, c, 'crownOpacity', 0, 1, 0.01, 'crown opacity');
    R(splash, c, 'entryScale', 0.3, 3, 0.01, 'going in, × coming out');
    R(splash, c, 'sprayCount', 0, 800, 1, 'droplets');
    R(splash, c, 'spraySpeed', 1, 25, 0.1, 'droplet speed (m/s)');
    R(splash, c, 'mistCount', 0, 80, 1, 'mist puffs');
    R(splash, c, 'dripRate', 0, 400, 1, 'drips/s in the air');
    R(splash, c, 'splashShake', 0, 1.5, 0.01, 'shake');
    R(splash, c, 'splashLight', 0, 200, 1, 'light punch');
    R(splash, c, 'splashFlash', 0, 0.5, 0.005, 'screen flash');

    const bite = folder.addFolder('5 · The bite');
    R(bite, c, 'biteSpray', 0, 400, 1, 'spray off the teeth');
    R(bite, c, 'biteShake', 0, 1.5, 0.01, 'shake');
    R(bite, c, 'biteLight', 0, 200, 1, 'light punch');
    R(bite, c, 'biteFlash', 0, 0.5, 0.005, 'screen flash');

    const palette = folder.addFolder('The palette');
    palette.addColor(c, 'colorShallow').name('shallows');
    palette.addColor(c, 'colorDeep').name('deep');
    palette.addColor(c, 'colorFoam').name('foam');
    palette.addColor(c, 'colorGlow').name('abyss glow');
    palette.addColor(c, 'colorRune').name('rune');
    palette.addColor(c, 'colorWet').name('wet stone');
    palette.addColor(c, 'colorMist').name('mist');
    palette.addColor(c, 'colorReticle').name('target lock');
    palette.addColor(c, 'colorLocked').name('target locked');

    const light = folder.addFolder('The light');
    R(light, c, 'lightIntensity', 0, 80, 0.5, 'intensity');
    R(light, c, 'lightRadius', 1, 30, 0.1, 'radius');
    light.addColor(c, 'lightColor').name('colour');
    R(light, c, 'portalLight', 0, 80, 0.5, 'portals');
    R(light, c, 'portalLightRadius', 1, 30, 0.1, 'portal radius');

    this.sharkFolder = folder;
  }

  _buildChains() {
    const folder = this.gui.addFolder('⛓  Chains of Penance');
    const c = settings.chains;
    const R = Editor.range;

    const cast = folder.addFolder('The cast');
    R(cast, c, 'range', 4, 60, 0.1, 'max range');
    R(cast, c, 'minRange', 0, 12, 0.1, 'min range');
    R(cast, c, 'zoneRadius', 0.3, 4, 0.05, 'target ring (m)');
    R(cast, c, 'snapRadius', 0, 8, 0.05, 'locks onto bodies within (m)');
    R(cast, c, 'speed', 4, 150, 0.5, 'run to the target (m/s)');
    R(cast, c, 'showTime', 1, 12, 0.05, 'rite lasts at least (s)');
    R(cast, c, 'fadeTime', 0.1, 8, 0.05, 'seal and blood fade over (s)');
    R(cast, c, 'cooldown', 0, 15, 0.05, 'cooldown');
    Editor.castAnimation(cast, c);

    const timing = folder.addFolder('The timing');
    R(timing, c, 'portalStagger', 0, 0.3, 0.005, 'portals open apart (s)');
    R(timing, c, 'portalOpen', 0.05, 1.5, 0.01, 'a portal opens in (s)');
    R(timing, c, 'fireDelay', 0, 2, 0.01, 'first chain thrown at (s)');
    R(timing, c, 'fireStagger', 0, 0.4, 0.005, 'chains thrown apart (s)');
    R(timing, c, 'flightTime', 0.03, 1, 0.005, 'chain flies for (s)');
    R(timing, c, 'wrapTime', 0.02, 1, 0.005, 'winds round its limb in (s)');
    R(timing, c, 'liftTime', 0.05, 2, 0.01, 'body hauled up in (s)');
    R(timing, c, 'strainStart', 0.3, 4, 0.01, 'hauling begins at (s)');
    R(timing, c, 'ratchets', 1, 6, 1, 'hauls before it gives');
    R(timing, c, 'ratchetPeriod', 0.1, 1.5, 0.01, 'between hauls (s)');
    R(timing, c, 'ratchetSnap', 0.01, 0.4, 0.005, 'one haul takes (s)');
    R(timing, c, 'tearStagger', 0, 0.6, 0.005, 'limbs come away apart (s)');
    R(timing, c, 'recoilTime', 0.05, 1.5, 0.01, 'limb dragged home in (s)');
    R(timing, c, 'dragDelay', 0, 2, 0.01, 'trunk taken after (s)');
    R(timing, c, 'dragTime', 0.1, 3, 0.01, 'trunk goes down in (s)');
    R(timing, c, 'closeDelay', 0, 1, 0.01, 'portal shuts after (s)');
    R(timing, c, 'closeTime', 0.05, 1.5, 0.01, 'shuts in (s)');

    const portals = folder.addFolder('1 · The portals');
    R(portals, c, 'portalRadius', 0.1, 1.5, 0.01, 'radius (m)');
    R(portals, c, 'floorPortalRadius', 0.2, 2, 0.01, 'floor portal radius (m)');
    R(portals, c, 'portalDistance', 1, 8, 0.05, 'from the body (m)');
    R(portals, c, 'portalSpread', 0, 4, 0.05, 'random extra (m)');
    R(portals, c, 'portalJitter', 0, 1, 0.01, 'random swing');
    R(portals, c, 'portalMinHeight', 0, 3, 0.05, 'lowest (m)');
    R(portals, c, 'groundSpan', 0.4, 4, 0.05, 'leg portals out (m)');
    R(portals, c, 'blades', 3, 12, 1, 'iris blades');
    R(portals, c, 'irisOpen', 0, 1.25, 0.01, 'iris opens');
    R(portals, c, 'portalSpin', -4, 4, 0.01, 'filigree turn (rad/s)');
    R(portals, c, 'tunnelDepth', 0, 6, 0.05, 'tunnel depth');
    R(portals, c, 'tunnelSpeed', 0, 3, 0.01, 'tunnel streams');
    R(portals, c, 'runeGlow', 0, 6, 0.05, 'tunnel runes');
    R(portals, c, 'lineGlow', 0, 8, 0.05, 'gold');
    R(portals, c, 'halo', 0, 3, 0.01, 'halo');
    R(portals, c, 'voidOpacity', 0, 1, 0.01, 'void');
    R(portals, c, 'igniteFlash', 0, 4, 0.01, 'ignition spark');
    R(portals, c, 'warpStrength', 0, 3, 0.01, 'lens');
    R(portals, c, 'warpSwirl', -2, 2, 0.01, 'lens swirl');

    const chains = folder.addFolder('2 · The chains');
    R(chains, c, 'linkLength', 0.04, 0.4, 0.005, 'link (m)');
    R(chains, c, 'linkThickness', 0.4, 2, 0.01, 'link thickness');
    R(chains, c, 'hookSize', 0.05, 1, 0.01, 'barbed head (m)');
    R(chains, c, 'curl', 0, 3, 0.01, 'throw arc (m)');
    R(chains, c, 'whip', 0, 1.5, 0.01, 'whip (m)');
    R(chains, c, 'whipWaves', 0.5, 6, 0.05, 'whip waves');
    R(chains, c, 'sag', 0, 0.6, 0.005, 'slack sag');
    R(chains, c, 'vibration', 0, 0.15, 0.001, 'thrum (m)');
    R(chains, c, 'vibrationFreq', 1, 60, 0.5, 'thrum (Hz)');
    R(chains, c, 'jerkWave', 0, 0.6, 0.005, 'haul wave (m)');
    R(chains, c, 'wrapTurns', 0.5, 6, 0.05, 'coil turns');
    R(chains, c, 'wrapReach', 0.2, 1.5, 0.01, 'coil length');
    R(chains, c, 'wrapRadius', 0.5, 2.5, 0.01, 'coil girth');
    const iron = chains.addFolder('The iron');
    R(iron, c, 'metalness', 0, 1, 0.01, 'metalness');
    R(iron, c, 'roughness', 0, 1, 0.01, 'roughness');
    R(iron, c, 'ironEnv', 0, 3, 0.01, 'probe');
    R(iron, c, 'runeScale', 0.5, 10, 0.05, 'runes per link');
    R(iron, c, 'chainRuneGlow', 0, 6, 0.05, 'rune glow');
    R(iron, c, 'heatGlow', 0, 10, 0.05, 'heat glow');
    R(iron, c, 'crackScale', 2, 60, 0.5, 'crust scale');
    iron.addColor(c, 'colorIron').name('iron');

    const hold = folder.addFolder('3 · The hold');
    R(hold, c, 'hangHeight', 0.8, 4, 0.05, 'hangs at (m)');
    R(hold, c, 'reach', 0.3, 2, 0.01, 'limbs held out');
    R(hold, c, 'grip', 0, 0.6, 0.005, 'limb grip');
    R(hold, c, 'waistGrip', 0, 0.8, 0.005, 'trunk grip');
    R(hold, c, 'catchTime', 0.01, 1, 0.01, 'grip takes (s)');
    const kick = hold.addFolder('The first chain to land');
    R(kick, c.kick, 'impulse', 0, 10, 0.05, 'along the cast (m/s)');
    R(kick, c.kick, 'lift', 0, 15, 0.05, 'up (m/s)');
    R(kick, c.kick, 'spin', 0, 5, 0.05, 'tumble');

    const strain = folder.addFolder('4 · The strain');
    R(strain, c, 'stretch', 0, 0.6, 0.005, 'out of the socket (m)');
    R(strain, c, 'reachGain', 0, 1.5, 0.01, 'each haul drags further');
    R(strain, c, 'seamStrain', 0, 1, 0.01, 'seams glow');
    R(strain, c.tear, 'veins', 0, 3, 0.01, 'veins of heat');
    R(strain, c, 'jerkShake', 0, 1, 0.005, 'haul shake');
    R(strain, c, 'strainRumble', 0, 0.3, 0.001, 'rumble');
    R(strain, c, 'ratchetLight', 0, 150, 0.5, 'haul light');

    const tear = folder.addFolder('5 · The tear');
    R(tear, c.tear, 'tearNoise', 0, 0.48, 0.005, 'ragged seam');
    R(tear, c.tear, 'tearNoiseScale', 2, 60, 0.5, 'seam detail');
    R(tear, c.tear, 'tearEdge', 0.005, 0.3, 0.005, 'hot band');
    R(tear, c.tear, 'seamGlow', 0, 20, 0.1, 'seam glow');
    R(tear, c.tear, 'meatGlow', 0, 3, 0.01, 'wound glow');
    tear.addColor(c.tear, 'colorSeam').name('seam');
    tear.addColor(c.tear, 'colorMeat').name('wound');
    R(tear, c.tear, 'portalRimGlow', 0, 20, 0.1, 'portal burn');
    R(tear, c.tear, 'portalRimWidth', 0.005, 0.3, 0.005, 'portal burn width (m)');
    R(tear, c, 'recoilDepth', 0, 4, 0.05, 'dragged past its portal (m)');
    R(tear, c, 'bloodCount', 0, 600, 1, 'blood');
    R(tear, c, 'bloodSpeed', 0, 15, 0.05, 'blood speed (m/s)');
    R(tear, c, 'goreCount', 0, 40, 1, 'gore');
    R(tear, c, 'emberCount', 0, 300, 1, 'embers');
    R(tear, c, 'mistCount', 0, 40, 1, 'mist');
    R(tear, c, 'tearShake', 0, 1.5, 0.01, 'shake');
    R(tear, c, 'tearLight', 0, 200, 1, 'light punch');
    R(tear, c, 'tearFlash', 0, 0.5, 0.005, 'screen flash');

    const seal = folder.addFolder('6 · The seal');
    R(seal, c, 'sealRadius', 0.3, 5, 0.05, 'radius (m)');
    R(seal, c, 'sealGlow', 0, 6, 0.05, 'glow');
    R(seal, c, 'sealDraw', 0.05, 3, 0.01, 'inscribed in (s)');
    R(seal, c, 'bloodPool', 0, 4, 0.05, 'blood pool (m)');
    R(seal, c, 'bloodGrow', 0.1, 6, 0.05, 'spreads over (s)');

    const air = folder.addFolder('The air round it');
    R(air, c, 'sparkRate', 0, 200, 1, 'sparks');
    R(air, c, 'emberRate', 0, 120, 1, 'embers per portal');
    R(air, c, 'smokeRate', 0, 40, 0.5, 'smoke per portal');

    const palette = folder.addFolder('The palette');
    palette.addColor(c, 'colorGold').name('gold');
    palette.addColor(c, 'colorCore').name('white heat');
    palette.addColor(c, 'colorHeat').name('heat');
    palette.addColor(c, 'colorDeep').name('crimson');
    palette.addColor(c, 'colorVoid').name('void');
    palette.addColor(c, 'colorLacquer').name('lacquer');
    palette.addColor(c, 'colorBlood').name('blood');
    palette.addColor(c, 'colorBloodDark').name('blood, dark');
    palette.addColor(c, 'colorEmber').name('embers');
    palette.addColor(c, 'colorSmoke').name('smoke');
    palette.addColor(c, 'colorReticle').name('target lock');
    palette.addColor(c, 'colorLocked').name('target locked');

    const light = folder.addFolder('The light');
    R(light, c, 'lightIntensity', 0, 80, 0.5, 'intensity');
    R(light, c, 'lightRadius', 1, 30, 0.1, 'radius');
    light.addColor(c, 'lightColor').name('colour');
    R(light, c, 'portalLight', 0, 80, 0.5, 'portals');
    R(light, c, 'portalLightRadius', 1, 30, 0.1, 'portal radius');

    this.chainsFolder = folder;
  }

  /**
   * The Dragonfire Circle, in the order of the show.
   *
   * Units: seconds for **The timing** (each act after the last); metres for
   * anything on the stage, except `orbitRadius`, which is a fraction of the
   * circle; kelvin for the fire's two temperatures.
   */
  _buildDragon() {
    const folder = this.gui.addFolder('🐉  Dragonfire Circle');
    const c = settings.dragon;
    const R = Editor.range;

    const cast = folder.addFolder('The cast');
    R(cast, c, 'range', 4, 60, 0.1, 'max range');
    R(cast, c, 'minRange', 0, 12, 0.1, 'min range');
    R(cast, c, 'zoneRadius', 2, 12, 0.1, 'circle radius (m)');
    R(cast, c, 'speed', 4, 120, 0.5, 'fuse speed (m/s)');
    R(cast, c, 'fuseEmbers', 0, 800, 1, 'fuse embers/s');
    R(cast, c, 'fadeTime', 0.5, 20, 0.1, 'floor cools over (s)');
    R(cast, c, 'cooldown', 0, 20, 0.05, 'cooldown');
    Editor.castAnimation(cast, c);

    const timing = folder.addFolder('The timing');
    R(timing, c, 'portalOpen', 0.05, 3, 0.01, 'sky tears open (s)');
    R(timing, c, 'arriveTime', 0.3, 5, 0.01, 'the dive (s)');
    R(timing, c, 'traceTime', 0.6, 12, 0.05, 'the lap (s)');
    R(timing, c, 'departTime', 0.4, 5, 0.01, 'the leaving (s)');
    R(timing, c, 'spreadDelay', 0, 3, 0.01, 'fire turns inward after (s)');
    R(timing, c, 'spreadTime', 0.3, 10, 0.05, 'fire runs inward (s)');

    /* ---- panel 1 ---- */
    const portal = folder.addFolder('1 · The tear in the sky');
    R(portal, c, 'portalHeight', 4, 30, 0.1, 'height (m)');
    R(portal, c, 'portalBack', -10, 20, 0.1, 'past the circle (m)');
    R(portal, c, 'portalRadius', 0.5, 10, 0.05, 'radius (m)');
    R(portal, c, 'portalTilt', 0, 1.5, 0.01, 'turned to the circle (rad)');
    R(portal, c, 'portalSpin', -6, 6, 0.05, 'vortex spin (rad/s)');
    R(portal, c, 'portalIntensity', 0, 8, 0.05, 'fire');
    R(portal, c, 'portalVoid', 0, 1, 0.01, 'void darkness');
    R(portal, c, 'portalShake', 0, 1.5, 0.005, 'shake as it comes through');
    R(portal, c, 'portalLight', 0, 200, 0.5, 'light');
    R(portal, c, 'portalLightRadius', 1, 50, 0.1, 'light radius');
    R(portal, c, 'revealWidth', 0.02, 2, 0.01, 'molten edge (m)');
    R(portal, c, 'revealGlow', 0, 30, 0.1, 'molten edge glow');

    /* ---- panel 2 ---- */
    const dragon = folder.addFolder('2 · The dragon');
    const flight = dragon.addFolder('The flight');
    R(flight, c, 'wingspan', 2, 20, 0.05, 'wingspan (m)');
    R(flight, c, 'altitude', 1, 12, 0.05, 'lap height (m)');
    R(flight, c, 'orbitRadius', 0.6, 2, 0.01, 'lap (of circle radius)');
    R(flight, c, 'lag', -1, 1.5, 0.01, 'trails its fire by (rad)');
    R(flight, c, 'bank', 0, 3, 0.01, 'bank');
    R(flight, c, 'bob', 0, 1, 0.005, 'bob per beat (m)');
    const wings = dragon.addFolder('The wings, the neck, the jaw');
    R(wings, c, 'idleWeight', 0, 1, 0.01, 'authored idle shows');
    R(wings, c, 'flapRate', 0.1, 4, 0.01, 'beats/s on the lap');
    R(wings, c, 'flapAmplitude', 0, 1.4, 0.01, 'stroke on the lap (rad)');
    R(wings, c, 'climbRate', 0.1, 4, 0.01, 'beats/s leaving');
    R(wings, c, 'climbAmplitude', 0, 1.4, 0.01, 'stroke leaving (rad)');
    R(wings, c, 'diveSweep', 0, 1.5, 0.01, 'folded in the dive (rad)');
    R(wings, c, 'dihedral', -0.5, 0.8, 0.01, 'held up (rad)');
    R(wings, c, 'tailSway', 0, 0.6, 0.005, 'tail sway (rad)');
    R(wings, c, 'neckCurl', -0.8, 1, 0.01, 'neck carried down (rad)');
    R(wings, c, 'aimLimit', 0, 3, 0.01, 'neck turns up to (rad)');
    R(wings, c, 'snarlJaw', 0, 1.2, 0.01, 'jaw snarling out of the tear (rad)');
    R(wings, c, 'breathJaw', 0, 1.2, 0.01, 'jaw to breathe (rad)');
    R(wings, c, 'inwardShake', 0, 1.5, 0.005, 'fire turns inward: shake');
    R(wings, c, 'inwardFlash', 0, 0.5, 0.005, 'fire turns inward: flash');
    const hide = dragon.addFolder('The hide');
    R(hide, c, 'underGlow', 0, 4, 0.01, 'fire under it');
    R(hide, c, 'throatGlow', 0, 10, 0.05, 'throat glow');
    R(hide, c, 'dragonRim', 0, 3, 0.01, 'ember rim');
    R(hide, c, 'dragonRimPower', 0.5, 8, 0.05, 'rim tightness');
    hide.addColor(c, 'colorRim').name('rim colour');

    /* ---- panel 3 ---- */
    const breath = folder.addFolder('3 · The breath');
    R(breath, c, 'breathWidth', 0.02, 1, 0.005, 'at the lips (m)');
    R(breath, c, 'breathSpread', 0.1, 4, 0.01, 'where it lands (m)');
    R(breath, c, 'breathCore', 0, 1, 0.01, 'white core');
    R(breath, c, 'breathSpeed', 2, 60, 0.5, 'gas speed (m/s)');
    R(breath, c, 'breathBend', 0, 2, 0.01, 'left behind as it flies');
    R(breath, c, 'breathNoiseScale', 0.2, 4, 0.05, 'noise scale');
    R(breath, c, 'breathShred', 0, 3, 0.01, 'shred');
    R(breath, c, 'breathIntensity', 0, 8, 0.05, 'intensity');
    R(breath, c, 'breathPuffs', 0, 400, 1, 'puffs/s down the jet');
    R(breath, c, 'splashRate', 0, 300, 1, 'splash puffs/s');
    R(breath, c, 'breathSparks', 0, 300, 1, 'sparks/s');
    R(breath, c, 'breathLight', 0, 200, 0.5, 'light');
    R(breath, c, 'breathShake', 0, 0.5, 0.005, 'shake');

    /* ---- panel 4 ---- */
    const ring = folder.addFolder('4 · The ring');
    R(ring, c, 'ringHeight', 0.2, 6, 0.05, 'wall height (m)');
    R(ring, c, 'ringThick', 0, 1.5, 0.01, 'wall depth (m)');
    R(ring, c, 'ringGrow', 0.05, 2, 0.01, 'catches over (rad)');
    R(ring, c, 'ringFlare', 0, 3, 0.01, 'leaps where it catches');
    R(ring, c, 'ringNoiseScale', 0.2, 5, 0.05, 'noise scale');
    R(ring, c, 'ringRise', 0, 6, 0.05, 'tongues climb (m/s)');
    R(ring, c, 'ringShred', 0, 3, 0.01, 'shred');
    R(ring, c, 'ringIntensity', 0, 8, 0.05, 'intensity');
    R(ring, c, 'ringBand', 0.05, 2, 0.01, 'scorched band (m)');
    R(ring, c, 'ringEmbers', 0, 400, 1, 'embers/s');
    R(ring, c, 'closeShake', 0, 1.5, 0.005, 'shake as it closes');
    R(ring, c, 'closeFlash', 0, 0.5, 0.005, 'flash as it closes');
    R(ring, c, 'closeLight', 0, 300, 0.5, 'light as it closes');

    /* ---- panel 5 ---- */
    const spread = folder.addFolder('5 · The fire runs inward');
    R(spread, c, 'frontHeight', 0.1, 5, 0.05, 'front wall (m)');
    R(spread, c, 'frontWobble', 0, 2, 0.01, 'edge torn by (m)');
    R(spread, c, 'frontWidth', 0.05, 2, 0.01, 'burning line (m)');
    R(spread, c, 'frontGlow', 0, 8, 0.05, 'burning line glow');
    R(spread, c, 'heatReach', 0.1, 6, 0.05, 'burns hot behind it (m)');
    R(spread, c, 'blazeHeight', 0.1, 5, 0.05, 'tongues (m)');
    R(spread, c, 'blazeWidth', 0.1, 3, 0.01, 'tongue width (m)');
    R(spread, c, 'blazeBurn', 0.3, 8, 0.05, 'roars for (s)');
    R(spread, c, 'blazeSustain', 0, 1, 0.01, 'share that burn on');
    R(spread, c, 'blazeLeap', 0, 3, 0.01, 'leaps as it catches');
    R(spread, c, 'blazeIntensity', 0, 8, 0.05, 'intensity');
    R(spread, c, 'blazeNoiseScale', 0.2, 5, 0.05, 'noise scale');
    R(spread, c, 'fieldPuffs', 0, 300, 1, 'fire puffs/s');
    R(spread, c, 'fieldEmbers', 0, 500, 1, 'embers/s');
    R(spread, c, 'smokeRate', 0, 80, 1, 'smoke/s');
    R(spread, c, 'smokeOpacity', 0, 1, 0.01, 'smoke opacity');
    R(spread, c, 'eruptionShake', 0, 1.5, 0.005, 'eruption shake');
    R(spread, c, 'eruptionFlash', 0, 0.6, 0.005, 'eruption flash');
    R(spread, c, 'eruptionLight', 0, 400, 1, 'eruption light');
    R(spread, c, 'eruptionEmbers', 0, 800, 1, 'eruption embers');

    /* ---- panel 6 ---- */
    const floor = folder.addFolder('6 · The floor');
    R(floor, c, 'charDark', 0, 1, 0.01, 'char');
    R(floor, c, 'crackScale', 0.2, 5, 0.05, 'plates per metre');
    R(floor, c, 'crackWidth', 0.005, 0.4, 0.005, 'crack width');
    R(floor, c, 'crackGlow', 0, 8, 0.05, 'crack glow');
    R(floor, c, 'groundEmbers', 0, 5, 0.05, 'embers in the crust');
    R(floor, c, 'ash', 0, 2, 0.01, 'ash');
    floor.addColor(c, 'colorChar').name('char');
    floor.addColor(c, 'colorAsh').name('ash');
    floor.addColor(c, 'colorHot').name('heat');
    floor.addColor(c, 'colorCrack').name('cracks');
    R(floor, c, 'heatHaze', 0, 3, 0.01, 'heat haze');
    R(floor, c, 'hazeHeight', 0.5, 12, 0.1, 'haze height (m)');
    R(floor, c, 'lingerEmbers', 0, 300, 1, 'embers/s as it cools');

    /* ---- panel 7 ---- */
    const bodies = folder.addFolder('7 · The bodies');
    const bc = c.burn;
    R(bodies, bc, 'stain', 0, 8, 0.05, 'chars at (1/s)');
    R(bodies, bc, 'onset', 0, 4, 0.01, 'starts to go after (s)');
    R(bodies, bc, 'rate', 0.05, 4, 0.01, 'burns away at (1/s)');
    R(bodies, bc, 'flames', 0, 200, 1, 'fire puffs/s each');
    R(bodies, bc.look, 'rimEmissive', 0, 8, 0.05, 'burnt rim glow');
    R(bodies, bc.look, 'edgeEmissive', 0, 16, 0.05, 'burn line glow');
    R(bodies, bc.look, 'edgeWidth', 0.005, 0.4, 0.005, 'burn line width');
    bodies.addColor(bc.look, 'color').name('charred');
    bodies.addColor(bc.look, 'rimColor').name('burnt rim');
    bodies.addColor(bc.look, 'edgeColor').name('burn line');
    R(bodies, c.burnHit, 'impulse', 0, 15, 0.1, 'stagger (m/s)');
    R(bodies, c.burnHit, 'lift', 0, 10, 0.1, 'lift');
    R(bodies, c.burnHit, 'spin', 0, 6, 0.05, 'spin');

    const fire = folder.addFolder('The fire');
    R(fire, c, 'tempCore', 1500, 8000, 10, 'core (K)');
    R(fire, c, 'tempEdge', 1000, 4000, 10, 'edge (K)');
    R(fire, c, 'emissionCurve', 0.5, 6, 0.05, 'radiance exponent');
    R(fire, c, 'palette', 0, 1, 0.01, 'radiator → palette');
    fire.addColor(c, 'colorCore').name('core');
    fire.addColor(c, 'colorMid').name('mid');
    fire.addColor(c, 'colorEdge').name('edge');
    fire.addColor(c, 'colorEmber').name('ember');

    const light = folder.addFolder('The light');
    R(light, c, 'lightIntensity', 0, 120, 0.5, 'on the dragon');
    R(light, c, 'lightRadius', 1, 40, 0.1, 'dragon light radius');
    light.addColor(c, 'lightColor').name('dragon light colour');
    R(light, c, 'lightGutter', 0, 1, 0.01, 'gutter');
    R(light, c, 'lightGutterSpeed', 0.5, 30, 0.1, 'gutter speed');
    R(light, c, 'fieldLight', 0, 160, 0.5, 'the field');
    R(light, c, 'fieldLightRadius', 1, 40, 0.1, 'field light radius');

    this.dragonFolder = folder;
  }

  /**
   * The Stormheart Gyroscope, in the order of the show.
   */
  _buildGyro() {
    const folder = this.gui.addFolder('⚛  Stormheart Gyroscope');
    const c = settings.gyro;
    const R = Editor.range;

    const cast = folder.addFolder('The cast');
    R(cast, c, 'range', 4, 60, 0.1, 'max range');
    R(cast, c, 'minRange', 0, 12, 0.1, 'min range');
    R(cast, c, 'zoneRadius', 2, 14, 0.1, 'circle radius (m)');
    R(cast, c, 'speed', 4, 120, 0.5, 'arc speed (m/s)');
    R(cast, c, 'fuseSparks', 0, 600, 1, 'arc sparks/s');
    R(cast, c, 'fuseArcs', 0, 60, 1, 'arc licks/s');
    R(cast, c, 'cooldown', 0, 20, 0.05, 'cooldown');
    Editor.castAnimation(cast, c);

    const timing = folder.addFolder('The timing');
    R(timing, c, 'summonTime', 0.2, 5, 0.01, 'summoning (s)');
    R(timing, c, 'chargeTime', 0.1, 5, 0.01, 'charge (s)');
    R(timing, c, 'stormTime', 0.2, 15, 0.05, 'storm (s)');
    R(timing, c, 'overloadTime', 0.2, 3, 0.01, 'overload (s)');
    R(timing, c, 'departTime', 0.2, 4, 0.01, 'leaving (s)');

    const summon = folder.addFolder('1 · The summoning');
    R(summon, c, 'size', 0.5, 8, 0.05, 'height (m)');
    R(summon, c, 'arriveDrop', 0, 10, 0.05, 'condenses this high (m)');
    R(summon, c, 'landAt', 0.3, 1, 0.01, 'lands at (\u00d7 summoning)');
    R(summon, c, 'departRise', 0, 6, 0.05, 'lifts as it leaves (m)');
    R(summon, c, 'revealWidth', 0.01, 1, 0.01, 'condensing edge (m)');
    R(summon, c, 'revealGlow', 0, 30, 0.1, 'condensing edge glow');
    summon.addColor(c, 'revealColor').name('condensing edge colour');
    R(summon, c, 'columnRadius', 0.2, 5, 0.05, 'shaft radius (m)');
    R(summon, c, 'columnIntensity', 0, 4, 0.01, 'shaft');
    R(summon, c, 'moteRate', 0, 800, 1, 'motes/s');
    R(summon, c, 'moteSize', 0.01, 0.4, 0.005, 'mote size');
    R(summon, c, 'moteSwirl', -10, 10, 0.05, 'mote swirl (rad/s)');
    R(summon, c, 'formShake', 0, 1.5, 0.005, 'shake when whole');
    R(summon, c, 'formFlash', 0, 0.5, 0.005, 'flash when whole');

    const construct = folder.addFolder('2 · The construct');
    R(construct, c, 'spinRate', 0, 5, 0.05, 'ring spin, at rest');
    R(construct, c, 'spinSummon', 0, 15, 0.05, 'ring spin, condensing');
    R(construct, c, 'spinStorm', 0, 8, 0.05, 'ring spin, storm');
    R(construct, c, 'spinDepart', 0, 20, 0.05, 'ring spin, leaving');
    R(construct, c, 'strikeKick', 0, 10, 0.05, 'spin kick per strike');
    R(construct, c, 'yawSpeed', -3, 3, 0.01, 'turn (rad/s)');
    R(construct, c, 'sway', 0, 0.5, 0.005, 'sway (rad)');
    R(construct, c, 'bobAmplitude', 0, 1, 0.005, 'bob (m)');
    R(construct, c, 'bobRate', 0, 2, 0.01, 'bob rate');
    construct.addColor(c, 'rimColor').name('rim');
    R(construct, c, 'rimStrength', 0, 3, 0.01, 'rim strength');
    R(construct, c, 'rimPower', 0.5, 8, 0.05, 'rim tightness');
    R(construct, c, 'gemGlow', 0, 12, 0.05, 'rune glow with charge');

    const core = folder.addFolder('3 · The core');
    R(core, c, 'coreSize', 0.2, 8, 0.05, 'size (m)');
    R(core, c, 'coreIntensity', 0, 6, 0.01, 'intensity');
    R(core, c, 'coreRays', 1, 16, 1, 'rays');
    R(core, c, 'coreFlicker', 0, 1, 0.01, 'gutter');
    R(core, c, 'starRate', 0, 400, 1, 'stars/s');
    R(core, c, 'starSize', 0.01, 0.6, 0.005, 'star size');
    R(core, c, 'starReach', 0.1, 3, 0.01, 'star reach (× rings)');
    R(core, c, 'crawlRate', 0, 40, 0.5, 'crawling arcs/s');
    R(core, c, 'chargeRumble', 0, 0.4, 0.005, 'charge rumble');

    const sigil = folder.addFolder('4 · The sigil');
    R(sigil, c, 'sigilIntensity', 0, 4, 0.01, 'intensity');
    R(sigil, c, 'sigilSpin', -2, 2, 0.01, 'spin');
    R(sigil, c, 'sigilFill', 0, 1, 0.01, 'fill');

    const strikes = folder.addFolder('5 · The strikes');
    R(strikes, c, 'strikeInterval', 0.05, 2, 0.01, 'between strikes (s)');
    R(strikes, c, 'chainJumps', 0, 4, 1, 'chain jumps');
    R(strikes, c, 'chainRange', 0.5, 12, 0.1, 'chain reach (m)');
    R(strikes, c, 'chainDelay', 0, 0.6, 0.005, 'between links (s)');
    R(strikes, c, 'idleStrikeRate', 0, 10, 0.1, 'floor strikes/s, nobody left');
    R(strikes, c, 'aimHeight', 0, 1, 0.01, 'aim height (× body)');
    R(strikes, c, 'boltWidth', 0.01, 0.6, 0.005, 'bolt width (m)');
    R(strikes, c, 'boltCore', 0.02, 1, 0.01, 'white spine');
    R(strikes, c, 'boltJag', 0, 0.6, 0.005, 'jaggedness');
    R(strikes, c, 'boltArch', -0.5, 0.5, 0.005, 'arch');
    R(strikes, c, 'boltForks', 0, 4, 1, 'forks');
    R(strikes, c, 'boltLife', 0.05, 1.5, 0.01, 'life (s)');
    R(strikes, c, 'boltLeader', 0.005, 0.4, 0.005, 'leader (s)');
    R(strikes, c, 'boltRestrikes', 0, 8, 1, 're-strikes');
    R(strikes, c, 'boltIntensity', 0, 8, 0.05, 'intensity');
    R(strikes, c, 'impactSparks', 0, 200, 1, 'sparks per hit');
    R(strikes, c, 'strikeShake', 0, 1.5, 0.005, 'shake');
    R(strikes, c, 'strikeFlash', 0, 0.5, 0.005, 'flash');
    R(strikes, c, 'strikeLight', 0, 200, 0.5, 'light');
    R(strikes, c, 'strikeLightRadius', 1, 30, 0.1, 'light radius');
    R(strikes, c.hit, 'impulse', 0, 20, 0.1, 'knock back (m/s)');
    R(strikes, c.hit, 'lift', 0, 12, 0.1, 'lift (m/s)');
    R(strikes, c.hit, 'spin', 0, 6, 0.05, 'spin');

    const overload = folder.addFolder('6 · The overload');
    R(overload, c, 'novaBolts', 0, 24, 1, 'bolts to the edge');
    R(overload, c, 'novaShake', 0, 2, 0.01, 'shake');
    R(overload, c, 'novaFlash', 0, 0.6, 0.005, 'flash');
    R(overload, c, 'novaLight', 0, 300, 1, 'light');

    const palette = folder.addFolder('The palette');
    palette.addColor(c, 'colorCore').name('white core');
    palette.addColor(c, 'colorBolt').name('bolt');
    palette.addColor(c, 'colorGlow').name('glow');
    palette.addColor(c, 'colorArc').name('arc');
    palette.addColor(c, 'colorStar').name('stars');
    palette.addColor(c, 'colorSigil').name('sigil');
    palette.addColor(c, 'colorSigilGold').name('sigil gold');

    const light = folder.addFolder('The light');
    R(light, c, 'lightIntensity', 0, 120, 0.5, 'at the core');
    R(light, c, 'lightRadius', 1, 40, 0.1, 'core light radius');
    light.addColor(c, 'lightColor').name('core light colour');
    R(light, c, 'lightGutter', 0, 1, 0.01, 'gutter');

    this.gyroFolder = folder;
  }

  /**
   * The Amethyst Verdict, in the order of the rite.
   */
  _buildAmethyst() {
    const folder = this.gui.addFolder('◆  Amethyst Verdict');
    const c = settings.amethyst;
    const R = Editor.range;

    const cast = folder.addFolder('The cast');
    R(cast, c, 'range', 4, 60, 0.1, 'max range');
    R(cast, c, 'minRange', 0, 12, 0.1, 'min range');
    R(cast, c, 'zoneRadius', 1.5, 8, 0.05, 'circle radius (m)');
    R(cast, c, 'snapRadius', 0.5, 6, 0.05, 'snap radius (m)');
    R(cast, c, 'speed', 4, 120, 0.5, 'speed (m/s)');
    R(cast, c, 'cooldown', 0, 20, 0.05, 'cooldown');
    R(cast, c, 'fadeTime', 0.1, 5, 0.05, 'fade (s)');
    Editor.castAnimation(cast, c);

    const timing = folder.addFolder('The timing');
    R(timing, c, 'drawTime', 0.05, 2, 0.01, 'circle draws (s)');
    R(timing, c, 'socketStagger', 0, 0.4, 0.005, 'between sockets (s)');
    R(timing, c, 'socketOpen', 0.05, 1.5, 0.01, 'socket opens (s)');
    R(timing, c, 'riseTime', 0.1, 2, 0.01, 'stone rises (s)');
    R(timing, c, 'riseStagger', 0, 0.5, 0.005, 'between stones (s)');
    R(timing, c, 'hoverTime', 0, 3, 0.01, 'hangs (s)');
    R(timing, c, 'aimTime', 0.05, 2, 0.01, 'turns to aim (s)');
    R(timing, c, 'launchStagger', 0, 0.5, 0.005, 'between throws (s)');
    R(timing, c, 'flightTime', 0.05, 1, 0.005, 'flight (s)');
    R(timing, c, 'finaleDelay', 0, 1, 0.01, 'finale after last (s)');
    R(timing, c, 'afterTime', 0.1, 4, 0.05, 'holds after (s)');

    const circle = folder.addFolder('1 · The circle');
    R(circle, c, 'stones', 3, 8, 1, 'sockets / stones');
    R(circle, c, 'socketRadius', 0.2, 1.5, 0.01, 'socket radius (m)');
    R(circle, c, 'circleIntensity', 0, 4, 0.01, 'intensity');
    R(circle, c, 'circleSpin', -3, 3, 0.01, 'spin');

    const stones = folder.addFolder('2 · The stones');
    R(stones, c, 'stoneSize', 0.3, 4, 0.01, 'height (m)');
    R(stones, c, 'stoneSizeVariance', 0, 0.6, 0.01, 'size variance');
    R(stones, c, 'hoverHeight', 0.5, 6, 0.05, 'hang height (m)');
    R(stones, c, 'hoverVariance', 0, 2, 0.01, 'hang variance (m)');
    R(stones, c, 'hoverBob', 0, 0.5, 0.005, 'bob (m)');
    R(stones, c, 'hoverSpin', -6, 6, 0.05, 'turn (rad/s)');
    R(stones, c, 'riseOvershoot', 0, 1.5, 0.01, 'rise overshoot (m)');
    R(stones, c, 'windup', 0, 2, 0.01, 'draw back (m)');
    R(stones, c, 'tremble', 0, 0.15, 0.001, 'tremble (m)');
    R(stones, c, 'flightSpin', -40, 40, 0.5, 'drill (rad/s)');
    R(stones, c, 'stopShort', 0, 1, 0.01, 'breaks short of (m)');
    R(stones, c, 'aimHeight', 0.2, 2, 0.01, 'aim height (m)');

    const crystal = folder.addFolder('3 · The crystal');
    R(crystal, c, 'stoneCloud', 0, 2, 0.01, 'cloud');
    R(crystal, c, 'stoneVeins', 0, 4, 0.01, 'veins');
    R(crystal, c, 'stoneInner', 0, 3, 0.01, 'inner light');
    R(crystal, c, 'stoneRim', 0, 3, 0.01, 'rim');
    R(crystal, c, 'stoneEnv', 0, 4, 0.01, 'reflections');
    R(crystal, c, 'chargeGlow', 0, 3, 0.01, 'charge glow');

    const smash = folder.addFolder('4 · The shattering');
    R(smash, c, 'shards', 0, 30, 1, 'pieces per stone');
    R(smash, c, 'shardSize', 0.02, 0.8, 0.005, 'piece size (m)');
    R(smash, c, 'shardSpeed', 0, 20, 0.1, 'piece speed (m/s)');
    R(smash, c, 'shardLife', 0.2, 8, 0.05, 'pieces last (s)');
    R(smash, c, 'chipCount', 0, 200, 1, 'chips');
    R(smash, c, 'sparkCount', 0, 200, 1, 'sparks');
    R(smash, c, 'dustCount', 0, 40, 1, 'dust');
    R(smash, c, 'impactShake', 0, 1.5, 0.005, 'shake');
    R(smash, c, 'impactLight', 0, 200, 0.5, 'light');
    R(smash, c.hit, 'impulse', 0, 20, 0.1, 'first blow (m/s)');
    R(smash, c.hit, 'lift', 0, 12, 0.1, 'first blow lift (m/s)');
    R(smash, c.hit, 'spin', 0, 6, 0.05, 'first blow spin');
    R(smash, c, 'shove', 0, 15, 0.1, 'each blow after (m/s)');
    R(smash, c, 'shoveLift', 0, 10, 0.1, 'each blow lift (m/s)');

    const finale = folder.addFolder('5 · The finale');
    R(finale, c, 'finaleLift', 0, 20, 0.1, 'throws up (m/s)');
    R(finale, c, 'finaleShards', 0, 60, 1, 'pieces');
    R(finale, c, 'finaleShake', 0, 2, 0.01, 'shake');
    R(finale, c, 'finaleFlash', 0, 0.6, 0.005, 'flash');
    R(finale, c, 'finaleLight', 0, 300, 1, 'light');

    const palette = folder.addFolder('The palette');
    palette.addColor(c, 'colorDeep').name('stone, deep');
    palette.addColor(c, 'colorStone').name('stone');
    palette.addColor(c, 'colorPale').name('stone, cloud');
    palette.addColor(c, 'colorGlow').name('inner light');
    palette.addColor(c, 'colorVein').name('veins');
    palette.addColor(c, 'colorCircle').name('circle');
    palette.addColor(c, 'colorSocket').name('sockets');
    palette.addColor(c, 'colorCharge').name('charge');
    palette.addColor(c, 'colorSpark').name('sparks');
    palette.addColor(c, 'colorDust').name('dust');

    const light = folder.addFolder('The light');
    R(light, c, 'lightIntensity', 0, 60, 0.5, 'intensity');
    R(light, c, 'lightRadius', 1, 30, 0.1, 'radius');
    light.addColor(c, 'lightColor').name('colour');

    this.amethystFolder = folder;
  }

  /**
   * The Astral Tome, in the order of the show.
   */
  _buildTome() {
    const folder = this.gui.addFolder('✦  Astral Tome');
    const c = settings.tome;
    const R = Editor.range;

    const cast = folder.addFolder('The cast');
    R(cast, c, 'range', 4, 60, 0.1, 'max range');
    R(cast, c, 'minRange', 0, 12, 0.1, 'min range');
    R(cast, c, 'zoneRadius', 1.5, 12, 0.05, 'circle radius (m)');
    R(cast, c, 'cooldown', 0, 20, 0.05, 'cooldown');
    Editor.castAnimation(cast, c);

    const timing = folder.addFolder('The timing');
    R(timing, c, 'conjureTime', 0.2, 3, 0.01, 'conjures (s)');
    R(timing, c, 'flySpeed', 1, 40, 0.1, 'flies (m/s)');
    R(timing, c, 'flyMin', 0.1, 3, 0.01, 'flight at least (s)');
    R(timing, c, 'flyMax', 0.2, 5, 0.01, 'flight at most (s)');
    R(timing, c, 'growTime', 0.1, 3, 0.01, 'grows (s)');
    R(timing, c, 'openTime', 0.1, 3, 0.01, 'opens (s)');
    R(timing, c, 'judgeTime', 0.2, 10, 0.05, 'judgement (s)');
    R(timing, c, 'closeTime', 0.2, 4, 0.05, 'closes (s)');

    const conjure = folder.addFolder('1 · The conjuring');
    R(conjure, c, 'conjureSize', 0.1, 2, 0.01, 'size (m)');
    R(conjure, c, 'conjureHeight', 0.3, 3, 0.01, 'height (m)');
    R(conjure, c, 'conjureReach', -1, 3, 0.01, 'ahead (m)');
    R(conjure, c, 'conjureSide', -2, 2, 0.01, 'aside (m)');
    R(conjure, c, 'conjureMotes', 0, 600, 1, 'motes/s');
    R(conjure, c, 'moteSize', 0.01, 0.3, 0.005, 'mote size');
    R(conjure, c, 'moteSwirl', -8, 8, 0.05, 'mote swirl');
    R(conjure, c, 'edgeWidth', 0.01, 0.4, 0.005, 'burn-in edge');
    R(conjure, c, 'edgeGlow', 0, 20, 0.1, 'edge glow');
    conjure.addColor(c, 'colorEdge').name('edge colour');

    const flight = folder.addFolder('2 · The flight');
    R(flight, c, 'flyArc', 0, 8, 0.05, 'arc (m)');
    R(flight, c, 'flySpin', -4, 4, 0.05, 'turns');
    R(flight, c, 'flyTilt', -1.5, 1.5, 0.01, 'bank (rad)');
    R(flight, c, 'flyTrail', 0, 600, 1, 'trail/s');

    const book = folder.addFolder('3 · The book');
    R(book, c, 'size', 0.4, 6, 0.01, 'size (m)');
    R(book, c, 'hoverHeight', 0.3, 5, 0.01, 'hangs at (m)');
    R(book, c, 'hoverBob', 0, 0.5, 0.005, 'bob (m)');
    R(book, c, 'bobRate', 0, 3, 0.01, 'bob rate');
    R(book, c, 'yawSpeed', -3, 3, 0.01, 'turn (rad/s)');
    R(book, c, 'glyphGlow', 0, 12, 0.05, 'glyph glow');
    R(book, c, 'rimStrength', 0, 3, 0.01, 'rim');

    const orrery = folder.addFolder('4 · The orrery');
    R(orrery, c, 'holoHeight', 0.2, 5, 0.01, 'star height (m)');
    R(orrery, c, 'holoRadius', 0.3, 6, 0.01, 'widest orbit (m)');
    R(orrery, c, 'planets', 0, 6, 1, 'planets');
    R(orrery, c, 'orbitSpeed', -4, 4, 0.01, 'orbit speed');
    R(orrery, c, 'orbitWidth', 0.002, 0.08, 0.001, 'orbit line (m)');
    R(orrery, c, 'orbitIntensity', 0, 5, 0.01, 'orbit intensity');
    R(orrery, c, 'planetSize', 0.05, 2, 0.01, 'planet size');
    R(orrery, c, 'planetIntensity', 0, 5, 0.01, 'planet intensity');
    R(orrery, c, 'planetRegrow', 0.05, 4, 0.01, 'planet regathers (s)');
    R(orrery, c, 'coreSize', 0.2, 5, 0.01, 'star size');
    R(orrery, c, 'coreIntensity', 0, 5, 0.01, 'star intensity');
    R(orrery, c, 'fanRadius', 0.1, 4, 0.01, 'fan radius (m)');
    R(orrery, c, 'fanIntensity', 0, 5, 0.01, 'fan intensity');
    R(orrery, c, 'fanMotes', 0, 400, 1, 'fan motes/s');
    R(orrery, c, 'starRate', 0, 400, 1, 'stars/s');
    R(orrery, c, 'starSize', 0.01, 0.5, 0.005, 'star mote size');
    R(orrery, c, 'starReach', 0.2, 3, 0.01, 'star reach');
    R(orrery, c, 'openFlash', 0, 0.5, 0.005, 'open flash');

    const judge = folder.addFolder('5 · The judgement');
    R(judge, c, 'strikeInterval', 0.05, 2, 0.01, 'between throws (s)');
    R(judge, c, 'idleStrikeRate', 0.1, 10, 0.05, 'floor throws/s');
    R(judge, c, 'cometFlight', 0.05, 2, 0.01, 'flight (s)');
    R(judge, c, 'cometArc', -0.5, 1, 0.01, 'arc');
    R(judge, c, 'cometSize', 0.05, 3, 0.01, 'light size');
    R(judge, c, 'cometIntensity', 0, 5, 0.01, 'light intensity');
    R(judge, c, 'trailDensity', 0, 80, 1, 'trail/m');
    R(judge, c, 'beamWidth', 0.005, 0.4, 0.005, 'beam width');
    R(judge, c, 'beamIntensity', 0, 8, 0.05, 'beam intensity');
    R(judge, c, 'aimHeight', 0, 1, 0.01, 'aim height');
    R(judge, c, 'impactSparks', 0, 200, 1, 'sparks');
    R(judge, c, 'strikeShake', 0, 1.5, 0.005, 'shake');
    R(judge, c, 'strikeFlash', 0, 0.5, 0.005, 'flash');
    R(judge, c, 'strikeLight', 0, 200, 0.5, 'light');
    R(judge, c.hit, 'impulse', 0, 20, 0.1, 'impulse');
    R(judge, c.hit, 'lift', 0, 12, 0.1, 'lift');
    R(judge, c.hit, 'spin', 0, 6, 0.05, 'spin');

    const finale = folder.addFolder('6 · The finale');
    R(finale, c, 'finaleShake', 0, 2, 0.01, 'shake');
    R(finale, c, 'finaleFlash', 0, 0.6, 0.005, 'flash');
    R(finale, c, 'finaleLight', 0, 300, 1, 'light');

    const zodiac = folder.addFolder('7 · The zodiac');
    R(zodiac, c, 'sigilIntensity', 0, 4, 0.01, 'intensity');
    R(zodiac, c, 'sigilSpin', -3, 3, 0.01, 'spin');

    const palette = folder.addFolder('The palette');
    palette.addColor(c, 'colorCore').name('core');
    palette.addColor(c, 'colorGlow').name('glow');
    palette.addColor(c, 'colorLine').name('orbits, beams');
    palette.addColor(c, 'colorSpark').name('sparks');
    palette.addColor(c, 'colorStar').name('stars');
    palette.addColor(c, 'colorSigil').name('zodiac');
    palette.addColor(c, 'colorDeep').name('trail, deep');

    const light = folder.addFolder('The light');
    R(light, c, 'lightIntensity', 0, 60, 0.5, 'intensity');
    R(light, c, 'lightRadius', 1, 30, 0.1, 'radius');
    light.addColor(c, 'lightColor').name('colour');

    this.tomeFolder = folder;
  }

  /**
   * The Wildroot Reliquary, in the order of the rite.
   */
  _buildReliquary() {
    const folder = this.gui.addFolder('❦  Wildroot Reliquary');
    const c = settings.reliquary;
    const R = Editor.range;

    const cast = folder.addFolder('The cast');
    R(cast, c, 'range', 4, 60, 0.1, 'max range');
    R(cast, c, 'minRange', 0, 12, 0.1, 'min range');
    R(cast, c, 'zoneRadius', 1.5, 8, 0.05, 'sigil radius (m)');
    R(cast, c, 'snapRadius', 0.5, 6, 0.05, 'snap radius (m)');
    R(cast, c, 'speed', 4, 120, 0.5, 'seed speed (m/s)');
    R(cast, c, 'cooldown', 0, 20, 0.05, 'cooldown');
    R(cast, c, 'fadeTime', 0.1, 6, 0.05, 'fade (s)');
    Editor.castAnimation(cast, c);

    const timing = folder.addFolder('The timing');
    R(timing, c, 'drawTime', 0.05, 2, 0.01, 'sigil draws (s)');
    R(timing, c, 'archAt', 0, 2, 0.01, 'arch breaks floor at (s)');
    R(timing, c, 'archGrow', 0.1, 4, 0.01, 'arch climbs (s)');
    R(timing, c, 'haloAt', 0, 4, 0.01, 'stones rise at (s)');
    R(timing, c, 'haloRise', 0.1, 3, 0.01, 'a slab rises (s)');
    R(timing, c, 'haloStagger', 0, 0.5, 0.005, 'between slabs (s)');
    R(timing, c, 'cubeStagger', 0, 0.2, 0.001, 'between cubes (s)');
    R(timing, c, 'bindAt', 0, 5, 0.01, 'tendrils come at (s)');
    R(timing, c, 'whipTime', 0.05, 2, 0.01, 'tendrils reach (s)');
    R(timing, c, 'wrapTime', 0.05, 2, 0.01, 'tendrils wind (s)');
    R(timing, c, 'hoistTime', 0.1, 3, 0.01, 'hoist (s)');
    R(timing, c, 'igniteAt', 0, 8, 0.01, 'runes light at (s)');
    R(timing, c, 'igniteTime', 0.1, 5, 0.01, 'runes light over (s)');
    R(timing, c, 'finaleDelay', 0, 2, 0.01, 'then waits (s)');
    R(timing, c, 'diveTime', 0.05, 2, 0.01, 'cubes dive (s)');
    R(timing, c, 'dragTime', 0.1, 3, 0.01, 'dragged under (s)');
    R(timing, c, 'witherDelay', 0, 3, 0.01, 'then waits (s)');
    R(timing, c, 'witherTime', 0.2, 5, 0.01, 'roots wither (s)');
    R(timing, c, 'saplingGrow', 0.1, 4, 0.01, 'sapling grows (s)');

    const sigil = folder.addFolder('1 · The sigil');
    R(sigil, c, 'sigilIntensity', 0, 4, 0.01, 'intensity');
    R(sigil, c, 'sigilSpin', -3, 3, 0.01, 'spin');

    const arch = folder.addFolder('2 · The arch');
    R(arch, c, 'archSpan', 0.8, 6, 0.01, 'to each foot (m)');
    R(arch, c, 'archHeight', 1.5, 9, 0.01, 'apex (m)');
    R(arch, c, 'archBehind', -2, 2, 0.01, 'behind the body (m)');
    R(arch, c, 'archRadius', 0.05, 0.8, 0.005, 'foot radius (m)');
    R(arch, c, 'archTipRadius', 0.01, 0.4, 0.005, 'tip radius (m)');
    R(arch, c, 'archFlare', 0, 3, 0.01, 'foot flare');
    R(arch, c, 'archTwist', -2, 2, 0.01, 'braid (turns/m)');
    R(arch, c, 'archTwine', 0, 1.5, 0.01, 'twine (m)');
    R(arch, c, 'archSway', 0, 0.4, 0.005, 'sway (m)');
    R(arch, c, 'vines', 0, 2, 1, 'vines per root');
    R(arch, c, 'vineRadius', 0.01, 0.2, 0.001, 'vine radius (m)');
    R(arch, c, 'vineTurns', 0, 2, 0.01, 'vine turns/m');
    R(arch, c, 'curls', 0, 8, 1, 'curling tendrils');
    R(arch, c, 'curlLength', 0.2, 4, 0.01, 'curl length (m)');
    R(arch, c, 'curlRadius', 0.01, 0.25, 0.001, 'curl radius (m)');
    R(arch, c, 'groundRoots', 0, 4, 1, 'floor roots');
    R(arch, c, 'groundLength', 0.2, 5, 0.01, 'floor root length (m)');
    R(arch, c, 'eruptShake', 0, 1.5, 0.005, 'eruption shake');

    const bark = folder.addFolder('3 · The bark and the leaves');
    R(bark, c, 'barkBump', 0, 4, 0.01, 'bark relief');
    R(bark, c, 'moss', 0, 1.5, 0.01, 'moss');
    R(bark, c, 'lichen', 0, 1.5, 0.01, 'lichen');
    R(bark, c, 'veinGlow', 0, 5, 0.01, 'crevice light');
    R(bark, c, 'sapGlow', 0, 4, 0.01, 'sap glow');
    R(bark, c, 'sapSpeed', -4, 4, 0.01, 'sap speed');
    R(bark, c, 'tipGlow', 0, 20, 0.05, 'growing tip');
    R(bark, c, 'barkRim', 0, 3, 0.01, 'rim');
    R(bark, c, 'barkEnv', 0, 2, 0.01, 'reflections');
    R(bark, c, 'taper', 0.05, 3, 0.01, 'tip taper (m)');
    R(bark, c, 'leafSize', 0.05, 1.5, 0.005, 'leaf length (m)');
    R(bark, c, 'leafTranslucency', 0, 4, 0.01, 'leaf translucency');

    const halo = folder.addFolder('4 · The reliquary');
    R(halo, c, 'haloHeight', 0.8, 6, 0.01, 'ring height (m)');
    R(halo, c, 'haloRadius', 0.5, 4, 0.01, 'ring radius (m)');
    R(halo, c, 'haloSpan', 90, 350, 1, 'slabs span (°)');
    R(halo, c, 'haloSway', 0, 0.6, 0.005, 'rock (rad)');
    R(halo, c, 'slabs', 2, 5, 1, 'slabs');
    R(halo, c, 'slabThickness', 0.3, 3, 0.01, 'slab thickness');
    R(halo, c, 'slabDropStagger', 0, 0.5, 0.005, 'between falls (s)');
    R(halo, c, 'sinkSpeed', 0, 2, 0.01, 'sinks after');
    R(halo, c, 'cubes', 0, 16, 1, 'cubes');
    R(halo, c, 'cubeRadius', 0.3, 3, 0.01, 'cube ring radius (m)');
    R(halo, c, 'cubeSize', 0.05, 0.6, 0.005, 'cube size (m)');
    R(halo, c, 'cubeSpan', 30, 350, 1, 'cubes span (°)');
    R(halo, c, 'cubeTumble', -4, 4, 0.01, 'tumble (rad/s)');
    R(halo, c, 'converge', 0, 0.8, 0.01, 'close in');
    R(halo, c, 'auraIntensity', 0, 4, 0.01, 'light in the ring');

    const stone = folder.addFolder('5 · The stone');
    R(stone, c, 'patina', 0, 1.5, 0.01, 'patina');
    R(stone, c, 'glyphGlow', 0, 5, 0.01, 'rune glow');
    R(stone, c, 'carveDepth', 0, 2, 0.01, 'carving');
    R(stone, c, 'stoneRim', 0, 3, 0.01, 'rim');
    R(stone, c, 'stoneEnv', 0, 4, 0.01, 'reflections');

    const bind = folder.addFolder('6 · The binding');
    R(bind, c, 'sproutRadius', 0.3, 4, 0.01, 'sprouts out (m)');
    R(bind, c, 'tendrilRadius', 0.01, 0.2, 0.001, 'tendril radius (m)');
    R(bind, c, 'wrapTurns', 0.5, 6, 0.05, 'wraps');
    R(bind, c, 'wrapRadius', 0.02, 0.25, 0.001, 'wrap radius (m)');
    R(bind, c, 'spreadArms', 0, 2, 0.01, 'arms out (m)');
    R(bind, c, 'armsUp', -1, 2, 0.01, 'arms up (m)');
    R(bind, c, 'spreadLegs', 0, 1.5, 0.01, 'legs out (m)');
    R(bind, c, 'legsDown', 0, 2, 0.01, 'legs down (m)');
    R(bind, c, 'bindShake', 0, 1, 0.005, 'bite shake');
    R(bind, c, 'overgrow', 0, 1, 0.01, 'bark over the body');
    R(bind, c.hit, 'impulse', 0, 10, 0.05, 'bite impulse');
    R(bind, c.hit, 'lift', 0, 10, 0.05, 'bite lift');
    R(bind, c.hit, 'spin', 0, 4, 0.05, 'bite spin');
    bind.addColor(c.look, 'color').name('body: bark');
    bind.addColor(c.look, 'rimColor').name('body: rim');
    R(bind, c.look, 'rimEmissive', 0, 8, 0.05, 'body: rim glow');
    bind.addColor(c.look, 'edgeColor').name('body: edge');
    R(bind, c.look, 'edgeEmissive', 0, 16, 0.1, 'body: edge glow');

    const finale = folder.addFolder('7 · The reclamation');
    R(finale, c, 'dragDepth', 0.5, 6, 0.01, 'dragged down (m)');
    R(finale, c, 'finaleLeaves', 0, 400, 1, 'leaves');
    R(finale, c, 'finaleSpores', 0, 400, 1, 'spores');
    R(finale, c, 'finaleDirt', 0, 60, 1, 'dirt');
    R(finale, c, 'finaleShake', 0, 2, 0.01, 'shake');
    R(finale, c, 'finaleFlash', 0, 0.6, 0.005, 'flash');
    R(finale, c, 'finaleLight', 0, 300, 1, 'light');

    const sapling = folder.addFolder('8 · The sapling');
    R(sapling, c, 'saplingHeight', 0, 2.5, 0.01, 'height (m)');
    R(sapling, c, 'saplingRadius', 0.005, 0.15, 0.001, 'radius (m)');
    R(sapling, c, 'saplingGlow', 0, 4, 0.01, 'glow');

    const air = folder.addFolder('9 · The air');
    R(air, c, 'sporeRate', 0, 400, 1, 'spores/s');
    R(air, c, 'leafFall', 0, 120, 1, 'leaves/s');

    const palette = folder.addFolder('The palette');
    palette.addColor(c, 'colorBarkDark').name('bark, deep');
    palette.addColor(c, 'colorBark').name('bark');
    palette.addColor(c, 'colorMoss').name('moss');
    palette.addColor(c, 'colorLichen').name('lichen');
    palette.addColor(c, 'colorVine').name('vines');
    palette.addColor(c, 'colorVein').name('sap, veins');
    palette.addColor(c, 'colorTip').name('growing tip');
    palette.addColor(c, 'colorDry').name('withered');
    palette.addColor(c, 'colorLeaf').name('leaf');
    palette.addColor(c, 'colorLeafDark').name('leaf, deep');
    palette.addColor(c, 'colorStoneDark').name('stone, deep');
    palette.addColor(c, 'colorStone').name('stone');
    palette.addColor(c, 'colorPatina').name('patina');
    palette.addColor(c, 'colorGlyph').name('runes, cold');
    palette.addColor(c, 'colorGlyphHot').name('runes, lit');
    palette.addColor(c, 'colorSigil').name('sigil');
    palette.addColor(c, 'colorAura').name('ring light');
    palette.addColor(c, 'colorDirt').name('dirt');

    const light = folder.addFolder('The light');
    R(light, c, 'lightIntensity', 0, 60, 0.5, 'intensity');
    R(light, c, 'lightRadius', 1, 30, 0.1, 'radius');
    light.addColor(c, 'lightColor').name('colour');

    this.reliquaryFolder = folder;
  }

  /* ------------------------------------------------------------------ */

  /* ------------------------------------------------------------------ */

  _buildHall() {
    const folder = this.gui.addFolder('Duel hall');
    const h = settings.hall;
    const R = Editor.range;

    // Both also flip from the HUD switch and the ` key, so they listen.
    folder.add(h, 'enabled').name('hall').listen();
    folder.add(h, 'castle').name('castle walls').listen();
    R(folder, h, 'castleFade', 0.2, 6, 0.05, 'burn time (s)');
    folder.addColor(h, 'castleEdge').name('burn colour');
    R(folder, h, 'castleEmbers', 0, 3, 0.01, 'embers');
    R(folder, h, 'groundDepth', -15, -0.5, 0.1, 'ground under platform (m)');
    R(folder, h, 'lightIntensity', 0, 3, 0.01, 'hall lights');
    R(folder, h, 'candleGlow', 0, 3, 0.01, 'candle glow');
    R(folder, h, 'runeGlow', 0, 3, 0.01, 'rune glow');
    R(folder, h, 'godRays', 0, 3, 0.01, 'god rays');
    R(folder, h, 'carpetBrightness', 0, 1, 0.01, 'velvet brightness');
    R(folder, h, 'motion', 0, 3, 0.01, 'motion');
  }

  _buildEnvironment() {
    const folder = this.gui.addFolder('Environment');
    const e = settings.environment;
    const R = Editor.range;

    R(folder, e, 'sunIntensity', 0, 8, 0.01, 'key intensity');
    folder.addColor(e, 'sunColor').name('key colour');
    R(folder, e, 'sunAzimuth', 0, Math.PI * 2, 0.01, 'key azimuth');
    R(folder, e, 'sunElevation', 0.05, 1.5, 0.01, 'key elevation');
    R(folder, e, 'ambientIntensity', 0, 3, 0.01, 'ambient');
    folder.addColor(e, 'ambientColor').name('ambient colour');
    R(folder, e, 'hemiIntensity', 0, 3, 0.01, 'hemisphere');
    R(folder, e, 'envIntensity', 0, 3, 0.01, 'env (IBL)');
    R(folder, e, 'shadowRadius', 0, 8, 0.05, 'shadow softness');
    R(folder, e, 'shadowBias', -0.01, 0.001, 0.0001, 'shadow bias');
    R(folder, e, 'contactShadow', 0, 1.5, 0.01, 'contact shadow');

    const rim = folder.addFolder('Rim light');
    R(rim, e, 'rimIntensity', 0, 4, 0.01, 'rim intensity');
    rim.addColor(e, 'rimColor').name('rim colour');
    R(rim, e, 'rimAzimuth', 0, Math.PI * 2, 0.01, 'rim azimuth');
    R(rim, e, 'rimElevation', 0.05, 1.5, 0.01, 'rim elevation');
    rim.addColor(e, 'hemiSkyColor').name('hemi sky');
    rim.addColor(e, 'hemiGroundColor').name('hemi bounce');

    const fog = folder.addFolder('Backdrop, fog & dust');
    fog.addColor(e, 'backgroundColor').name('backdrop');
    fog.add(e, 'fogEnabled').name('fog enabled');
    fog.addColor(e, 'fogColor').name('fog colour');
    // near = where the fog starts, far = where it is total; widening the gap or
    // pushing both out thins the fog, closing it thickens it.
    R(fog, e, 'fogNear', 1, 200, 1, 'fog near');
    R(fog, e, 'fogFar', 10, 400, 1, 'fog far');
    R(fog, e, 'dustAmount', 0, 3, 0.01, 'floating dust');

    const floor = folder.addFolder('Stage floor');
    floor.addColor(e, 'floorColor').name('floor colour');
    floor.addColor(e, 'floorTint').name('floor tint');
    R(floor, e, 'floorRoughness', 0.05, 1, 0.01, 'roughness');
    R(floor, e, 'floorSheen', 0, 1, 0.01, 'sheen');
    R(floor, e, 'floorPool', 0, 1, 0.01, 'light pool');
  }

  _buildPost() {
    const folder = this.gui.addFolder('Post processing');
    const p = settings.post;
    const R = Editor.range;

    folder.add(p, 'enabled').name('enabled');
    R(folder, p, 'exposure', 0.1, 3, 0.01, 'exposure');
    R(folder, p, 'contrast', 0.5, 2, 0.01, 'contrast');
    R(folder, p, 'saturation', 0, 2.5, 0.01, 'saturation');
    R(folder, p, 'temperature', -0.5, 0.5, 0.01, 'temperature');
    R(folder, p, 'lift', -0.2, 0.2, 0.005, 'lift');
    R(folder, p, 'gain', 0.5, 2, 0.01, 'gain');
    R(folder, p, 'vignette', 0, 1.5, 0.01, 'vignette');
    R(folder, p, 'chromaticAberration', 0, 3, 0.01, 'chromatic aberration');
    R(folder, p, 'grain', 0, 0.2, 0.001, 'film grain');
    R(folder, p, 'distortion', 0, 0.2, 0.001, 'screen warp');
    R(folder, p, 'flashStrength', 0, 2, 0.01, 'impact flash');
  }

  _buildCamera() {
    const folder = this.gui.addFolder('Camera');
    const c = settings.camera;
    const R = Editor.range;

    // The wheel writes `distance` straight into settings, so the slider listens.
    R(folder, c, 'distance', 1, 40, 0.1, 'distance').listen();
    R(folder, c, 'minDistance', 1, 20, 0.1, 'min distance');
    R(folder, c, 'maxDistance', 4, 40, 0.1, 'max distance');
    R(folder, c, 'zoomSpeed', 0.1, 3, 0.01, 'zoom speed');
    R(folder, c, 'fov', 20, 90, 0.5, 'field of view');
    R(folder, c, 'targetHeight', 0, 4, 0.01, 'target height');
    R(folder, c, 'minPolar', 0.05, 1.5, 0.01, 'min pitch');
    R(folder, c, 'maxPolar', 0.2, 1.55, 0.01, 'max pitch');
    R(folder, c, 'damping', 0.001, 0.5, 0.001, 'follow damping');
    R(folder, c, 'autoFrame', 0, 1, 0.01, 'auto framing');

    // Edge panning. `dead zone` is the share of the frame that moves nothing —
    // raise it if the hand is shaky, lower it to start panning sooner.
    const panning = folder.addFolder('Edge panning');
    R(panning, c, 'panDeadZone', 0, 0.95, 0.01, 'dead zone');
    R(panning, c, 'panSpeed', 0, 20, 0.1, 'pan speed');
    R(panning, c, 'panRange', 0, 30, 0.5, 'pan range');
    R(panning, c, 'panRecenter', 0.01, 1, 0.01, 'recentre hold');

    folder.add({ clear: () => this.hooks.onClear?.() }, 'clear').name('Clear effects (C)');
  }

  _buildCharacter() {
    const folder = this.gui.addFolder('Character');
    const c = settings.character;
    const R = Editor.range;

    // The mixer's own rate, so it scales the idle and the cast clips together.
    // The same value as Global → animation speed, mirrored here where it is
    // actually reached for; `listen` keeps the two readouts honest.
    R(folder, settings.global, 'animationSpeed', 0.1, 3, 0.01, 'playback rate').listen();

    // Which clip each ability throws lives in that ability's own folder, under
    // "The cast"; these are the edges of the blend that lays it over the idle.
    const cast = folder.addFolder('Casting');
    R(cast, c, 'castBlendIn', 0.01, 1, 0.01, 'blend into cast');
    R(cast, c, 'castBlendOut', 0.01, 1.5, 0.01, 'blend back to idle');
    cast.add(c, 'turnToAim').name('turn to aim');
    R(cast, c, 'turnRate', 0.000001, 0.02, 0.000001, 'turn follow');

    // The procedural accent that rides on top of the clip. Zero both leans to
    // let the animation carry the cast on its own.
    const lunge = folder.addFolder('Lunge');
    R(lunge, c, 'castLean', 0, 1.2, 0.01, 'lunge lean');
    R(lunge, c, 'castRecoil', 0, 0.8, 0.005, 'lunge recoil');
    R(lunge, c, 'castSettle', 0.2, 8, 0.05, 'lunge settle');
  }

  /**
   * The target dummies and how they fall.
   *
   * Everything here is live: the ring re-populates while you watch, the fall's
   * gravity and stiffness apply to bodies already on the floor, and the blow's
   * numbers apply to the next thing that gets hit. The one exception is
   * `height`, which sizes the model when it is loaded.
   */
  _buildDummies() {
    const folder = this.gui.addFolder('Target dummies');
    const d = settings.dummies;
    const R = Editor.range;

    folder.add(d, 'enabled').name('enabled');
    R(folder, d, 'count', 0, 16, 1, 'how many');

    const ring = folder.addFolder('Where they stand');
    R(ring, d, 'radius', 4, 40, 0.5, 'ring radius');
    R(ring, d, 'minRadius', 1, 20, 0.5, 'no nearer than');
    R(ring, d, 'separation', 0.5, 6, 0.1, 'apart, metres');
    ring.add(d, 'watch').name('turn to watch');
    R(ring, d, 'turnRate', 0.000001, 0.5, 0.000001, 'turn follow');

    // What a cast has to cover to knock one down, and how hard it throws it.
    const hit = folder.addFolder('The blow');
    hit.add(d.hit, 'enabled').name('abilities kill');
    R(hit, d.hit, 'radius', 0.2, 6, 0.05, 'line reach, metres');
    R(hit, d.hit, 'zoneScale', 0.2, 2.5, 0.05, 'far-cast footprint');
    R(hit, d, 'bodyRadius', 0.1, 1.5, 0.02, 'body radius');
    R(hit, d.hit, 'impulse', 0, 30, 0.1, 'impulse');
    R(hit, d.hit, 'lift', 0, 16, 0.1, 'lift');
    R(hit, d.hit, 'spin', -3, 4, 0.05, 'spin (torque)');

    const fall = folder.addFolder('The fall');
    R(fall, d.ragdoll, 'gravity', -60, -2, 0.5, 'gravity');
    R(fall, d.ragdoll, 'damping', 0, 0.6, 0.005, 'air drag');
    R(fall, d.ragdoll, 'iterations', 1, 16, 1, 'solver passes');
    R(fall, d.ragdoll, 'brace', 0, 1, 0.01, 'torso stiffness');
    R(fall, d.ragdoll, 'radius', 0.01, 0.4, 0.005, 'joint radius');
    R(fall, d.ragdoll, 'friction', 0, 1, 0.01, 'ground friction');
    R(fall, d.ragdoll, 'bounce', 0, 0.8, 0.01, 'ground bounce');
    R(fall, d.ragdoll, 'sleep', 0.001, 0.5, 0.001, 'sleep threshold');

    const corpse = folder.addFolder('Corpse & respawn');
    R(corpse, d, 'corpseTime', 0, 20, 0.1, 'lies there, seconds');
    R(corpse, d, 'dissolveTime', 0.1, 6, 0.05, 'burns away, seconds');
    R(corpse, d, 'respawnDelay', 0, 15, 0.1, 'respawn delay');

    const look = folder.addFolder('The look');
    look.addColor(d.look, 'color').name('body');
    R(look, d.look, 'roughness', 0, 1, 0.01, 'roughness');
    R(look, d.look, 'metalness', 0, 1, 0.01, 'metalness');
    look.addColor(d.look, 'rimColor').name('rim');
    R(look, d.look, 'rimPower', 0.5, 8, 0.05, 'rim tightness');
    R(look, d.look, 'rimEmissive', 0, 6, 0.05, 'rim strength');
    look.addColor(d.look, 'edgeColor').name('burn edge');
    R(look, d.look, 'edgeEmissive', 0, 20, 0.1, 'burn glow');
    R(look, d.look, 'edgeWidth', 0.01, 0.5, 0.005, 'burn width');
    R(look, d.look, 'dissolveDetail', 1, 30, 0.5, 'burn detail');
  }

  dispose() {
    this.gui.destroy();
  }
}
