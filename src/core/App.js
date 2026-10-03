import { Vector3, MathUtils } from 'three';

import { Renderer } from './Renderer.js';
import { Time } from './Time.js';
import { CameraRig } from './CameraRig.js';
import { frame } from './FrameUniforms.js';

import { Environment } from '../world/Environment.js';
import { Ground } from '../world/Ground.js';
import { DustMotes } from '../world/DustMotes.js';
import { ContactShadows } from '../world/ContactShadows.js';
import { DuelHall } from '../world/DuelHall.js';

import { AssetLoader } from '../loaders/AssetLoader.js';
import { getStoneTextures } from '../loaders/StoneTextures.js';
import { buildSharkRig } from '../assets/SharkRig.js';
import { buildWolfRig } from '../assets/WolfRig.js';
import { buildDragonRig } from '../assets/DragonRig.js';
import { buildGyroscopeRig } from '../assets/GyroscopeRig.js';
import { buildAmethystRig } from '../assets/AmethystRig.js';
import { buildTomeRig } from '../assets/TomeRig.js';
import { buildReliquaryRig } from '../assets/ReliquaryRig.js';
import { CharacterController } from '../animation/CharacterController.js';
import { DummyField } from '../combat/DummyField.js';

import { InputManager } from '../input/InputManager.js';
import { AimController } from '../input/AimController.js';
import { HandInput } from '../input/HandInput.js';
import { PhoneCameraLink } from '../input/PhoneCamera.js';

import { ParticleEngine } from '../particles/ParticleEngine.js';
import { LightPool } from '../effects/LightPool.js';
import { DecalSystem } from '../effects/GroundDecals.js';
import { BurstSystem } from '../effects/BurstSphere.js';
import { CameraShake } from '../effects/CameraShake.js';
import { ScreenFlash } from '../effects/ScreenFlash.js';

import { AbilityManager } from '../abilities/AbilityManager.js';
import { PostProcessing } from '../postprocessing/PostProcessing.js';

import { HUD, LoadingScreen } from '../ui/HUD.js';
import { Editor } from '../ui/Editor.js';

import { settings, ELEMENTS, ELEMENT_META } from '../config/settings.js';

const HDR_URL = './hdri/spruit_sunrise.hdr';
const SHARK_URL = './models/shark.glb';
const WOLF_URL = './models/wolf.glb';
const DRAGON_URL = './models/dragon.glb';
const GYRO_URL = './models/magical_gyroscope.glb';
const AMETHYST_URL = './models/amethyst_stones.glb';
const TOME_URL = './models/arcane_tome.glb';
const RELIQUARY_URL = './models/wildroot_reliquary.glb';

/** Hand the page back for one frame, so the loading veil can repaint. */
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

/**
 * Poll `test` once a frame until it passes or `timeout` runs out.
 *
 * Resolves either way: everything this waits on during boot is an optimisation,
 * and a slow download must not be able to hold the loading screen up forever.
 */
async function waitFor(test, timeout) {
  const deadline = performance.now() + timeout;
  while (!test() && performance.now() < deadline) await nextFrame();
}

/**
 * Application root: owns every subsystem and the frame loop.
 *
 * The wiring is deliberately one-directional — App builds the systems, hands the
 * ability manager a context object of the shared services, and then does nothing
 * but order the per-frame updates. No subsystem reaches back into App.
 *
 * The interaction is a single loop: select and arm an ability (Q / E), swing the
 * ground arrow with the mouse, click to fire. `AimController` owns the targeting
 * and emits one `cast` event; App turns that into an ability, a heading for the
 * character and a cooldown.
 */
export class App {
  constructor(canvas) {
    this.canvas = canvas;
    this.time = new Time();
    this.elapsed = 0;
    this.paused = false;
    this._raf = 0;

    /**
     * Seconds left before each ability can be armed again. Per element, so
     * spending one slot never locks the other out.
     */
    this.cooldowns = new Map(ELEMENTS.map((element) => [element, 0]));
    /** Whether the selected slot could be armed last frame; see the loop. */
    this._slotReady = true;

    /* ---- core ---- */
    this.renderer = new Renderer(canvas);
    this.rig = new CameraRig(canvas);
    this.camera = this.rig.camera;

    this.environment = new Environment(this.renderer, this.camera);
    this.scene = this.environment.scene;

    /* ---- world ---- */
    this.ground = new Ground(this.environment);
    this.dust = new DustMotes();
    this.contactShadows = new ContactShadows(this.renderer, { size: 2.6, height: 2.4, blur: 2.0 });

    this.scene.add(this.ground.mesh, this.dust.points, this.contactShadows.group);
    this.hall = new DuelHall(this.environment, this.ground);
    this.scene.add(this.hall.group);
    this.dust.setPixelRatio(this.renderer.gl.getPixelRatio());

    /* ---- shared VFX services ---- */
    this.particles = new ParticleEngine(this.scene);
    this.lights = new LightPool(this.scene);
    this.decals = new DecalSystem(this.scene);
    this.bursts = new BurstSystem(this.scene);
    this.shake = new CameraShake(this.rig);
    this.flash = new ScreenFlash();

    /* ---- what the abilities are aimed at ---- */
    // Most abilities never hear about these: the field reads the casts instead
    // (`DummyField#applyHits`). The one exception is a cast that picks its own
    // targets, which needs to *ask* who is standing nearby — so the field is
    // built before the manager and handed over in its context.
    this.dummies = new DummyField(this.environment);
    this.scene.add(this.dummies.group);

    /**
     * Geometry that had to be loaded rather than generated, keyed by name.
     *
     * Handed to the abilities by reference and filled in by `load()`: the pools
     * build their instances lazily, on the first cast of an ability, which is
     * long after the assets have landed.
     */
    this.models = {};

    this.abilities = new AbilityManager({
      scene: this.scene,
      camera: this.camera,
      environment: this.environment,
      particles: this.particles,
      lights: this.lights,
      decals: this.decals,
      bursts: this.bursts,
      shake: this.shake,
      flash: this.flash,
      dummies: this.dummies,
      models: this.models
    });

    /* ---- character ---- */
    this.character = new CharacterController(this.environment);
    this.scene.add(this.character.root);
    // Built after the abilities, so it joins their shared context here: a cast
    // that leaves from the hands needs to know where they are.
    this.abilities.ctx.character = this.character;

    /* ---- input & targeting ---- */
    this.input = new InputManager(canvas);
    /**
     * Camera mode. Constructed cold — it opens no device until `M` asks it to,
     * so a machine with no webcam, or a user who never grants the permission,
     * pays nothing and notices nothing.
     */
    this.hands = new HandInput();
    /**
     * A phone's camera in place of the webcam, over WebRTC on the local
     * network. Also cold: it touches nothing until the panel asks it to. Dev
     * server only — see `PhoneCamera.js` for why it does not ship.
     */
    this.phone = new PhoneCameraLink();
    this.cameraMode = false;
    this._editorWasHidden = false;

    this.aim = new AimController(this.camera);
    // A targeted cast locks its circle onto a body; the field is who it can pick.
    this.aim.targets = this.dummies;
    this.scene.add(this.aim.object3D);

    /* ---- post ---- */
    this.post = new PostProcessing(this.renderer, this.scene, this.camera);

    /* ---- UI ---- */
    this.loading = new LoadingScreen();
    this.hud = new HUD(document.getElementById('hud'));
    this.editor = new Editor({
      onClear: () => this.clearEffects(),
      onToast: (message) => this.hud.showToast(message)
    });

    this._bindEvents();
    this.selectAbility(ELEMENTS[0], { silent: true });

    this._focusPoint = new Vector3();
  }

  /** The ability currently in the slot. */
  get element() {
    return this.abilities.selected;
  }

  /* ------------------------------------------------------------------ */

  _bindEvents() {
    this.renderer.onResize((width, height, pixelRatio) => {
      this.rig.resize(width, height);
      this.post.setSize(width, height, pixelRatio);
      this.dust.setPixelRatio(pixelRatio);
    });

    this.input.on('pointer:move', (pointer) => this.aim.point(pointer));
    this.input.on('pointer:confirm', (pointer) => {
      this.aim.point(pointer);
      this.aim.confirm();
    });
    this.input.on('action', (action, slot) => this._handleAction(action, slot));

    this.aim.on('cast', (origin, direction, distance) => this._cast(origin, direction, distance));
    this.aim.on('reject', () => this.hud.showToast('Too close — aim further out'));

    // Hand tracking speaks the same three events as the keyboard and mouse, so
    // it subscribes to the same handlers. Nothing downstream of this bus knows
    // which of the two is driving, and both stay live at once — on a stage the
    // keyboard fallback has to be one keypress away, never a mode away.
    this.hands.on('pointer:move', (pointer) => this.aim.point(pointer));
    this.hands.on('pointer:confirm', (pointer) => {
      this.aim.point(pointer);
      this.aim.confirm();
    });
    this.hands.on('action', (action, slot) => this._handleAction(action, slot));
    this.hands.on('engaged', () => {
      this.aim.arm();
      this.hud.showToast('Hand tracking engaged');
    });
    this.hands.on('error', () => {
      if (this.hands.errorStage === 'camera') {
        // No webcam, or the permission refused. Camera mode stays up: the
        // model is fine, and the panel can take a phone's camera instead —
        // it opens the pairing and says how. `M` is still the way out.
        this.hud.camera.setStatus('No webcam — use your phone below, or press M to leave');
        this.hud.showToast('No webcam — scan the code with your phone, or press M');
        this._pairPhone();
        return;
      }
      this.cameraMode = false;
      this.phone.close();
      this.hud.camera.phone.reset();
      this.hud.setCameraVisible(false);
      this.hud.showToast('Camera unavailable — keyboard still works');
    });

    // The phone camera. The link hands over a stream when video is flowing and
    // says when it has gone; the tracker is swapped under the panel either
    // way, and the panel's preview follows the tracker's video element.
    this.phone.on('status', (text, kind) => this.hud.camera.phone.setStatus(text, kind));
    this.phone.on('stream', async (stream) => {
      this.hud.camera.phone.setLive(true);
      if (!this.cameraMode) return;
      if (!(await this.hands.setStream(stream))) return;
      this.hud.camera.attach(this.hands.video);
      this.hud.showToast('Phone camera connected — open your palm to engage');
    });
    this.phone.on('ended', async () => {
      this.hud.camera.phone.setLive(false);
      if (!this.cameraMode) return;
      this.hud.camera.setStatus('Phone gone — back to the webcam…');
      if (await this.hands.useLocalCamera()) {
        this.hud.camera.attach(this.hands.video);
        this.hud.showToast('Back on the webcam');
      }
    });
    this.hud.camera.phone.onOpen = () => this._pairPhone();
    this.hud.camera.phone.onClose = () => this._unpairPhone();
    this.hud.camera.phone.onNextUrl = () => this.phone.nextUrl();

    this.hud.onAbility = (element) => this.armAbility(element);
    this.hud.onCastle = () => this._toggleCastle();
  }

  /**
   * @param {string} action
   * @param {number} slot
   */
  _handleAction(action, slot) {
    switch (action) {
      case 'ability': {
        const element = ELEMENTS[slot] ?? this.element;
        // Pressing the *same* key again puts an armed cast away, as it does in a
        // MOBA; pressing a different one swaps the slot without disarming.
        if (this.aim.isArmed && element === this.element) this.aim.cancel();
        else this.armAbility(element);
        break;
      }
      case 'abilityStep': {
        // `slot` carries a direction here, not an index — the hand steps
        // relative to whatever is selected, so it cannot disagree with the
        // keyboard about which ability that is.
        const index = ELEMENTS.indexOf(this.element);
        const element = ELEMENTS[(index + slot + ELEMENTS.length) % ELEMENTS.length];
        // The slot moves even when the ability is cooling. `armAbility` would
        // refuse both the move and the arm together, and a swap gesture that
        // silently does nothing reads as the tracker having failed.
        this.selectAbility(element);
        if ((this.cooldowns.get(element) ?? 0) > 0) this.hud.showToast('Not ready');
        else this.aim.arm();
        break;
      }
      case 'cancel':
        this.aim.cancel();
        break;
      case 'toggleHelp':
        this.hud.toggleHelp();
        break;
      case 'toggleEditor':
        this.editor.toggle();
        break;
      case 'clear':
        this.clearEffects();
        this.hud.showToast('Effects cleared');
        break;
      case 'resetDummies':
        this.dummies.reset();
        this.hud.showToast('Targets reset');
        break;
      case 'toggleCamera':
        this._toggleCamera();
        break;
      case 'toggleCastle':
        this._toggleCastle();
        break;
      case 'swapHands':
        // The roles came out backwards on this machine; see `HandInput`.
        if (!this.cameraMode) break;
        this.hands.swapHands();
        this.hud.showToast(`Aiming with your ${this.hands.aimHand.toLowerCase()} hand`);
        break;
      case 'togglePause':
        this.paused = !this.paused;
        this.hud.setPaused(this.paused);
        this.hud.showToast(this.paused ? 'Paused — the editor still applies' : 'Resumed');
        break;
      default:
        break;
    }
  }

  /**
   * Burn the castle away, leaving the platform floating over the open stage,
   * or raise it again. Turns the hall on if it was off: the switch is about
   * the walls, and the platform is what it leaves behind.
   */
  _toggleCastle() {
    const hall = settings.hall;
    const open = hall.enabled && hall.castle;
    hall.enabled = true;
    hall.castle = !open;
    this.hud.showToast(open ? 'Castle down — open stage' : 'Raising the castle');
  }

  /**
   * Put an ability in the slot. The aim indicator and the HUD both follow,
   * because `range` and `minRange` are the ability's, not the app's.
   */
  selectAbility(element, options = {}) {
    if (!ELEMENTS.includes(element)) return;
    this.abilities.select(element);
    this.aim.setElement(element);
    this.hud.setElement(element, options);
  }

  /** Select an ability and arm it, unless it is still cooling down. */
  armAbility(element = this.element) {
    if ((this.cooldowns.get(element) ?? 0) > 0) {
      this.hud.showToast('Not ready');
      return;
    }
    // Selecting before arming means the arrow is already drawn to the new
    // ability's range on the frame it appears.
    if (element !== this.element) this.selectAbility(element);
    this.aim.arm();
  }

  _cast(origin, direction, distance) {
    const element = this.element;
    this.abilities.cast(origin, direction, distance, element);
    this.cooldowns.set(element, Math.max(0, settings[element].cooldown));

    // Snap onto the shot and throw the body into it. Which clip that is belongs
    // to the ability, so each spell can be cast with its own gesture.
    this.character.setFacing(this.aim.facing);
    this.character.playCast(settings[element].castAnim);
    this.character.castLunge();
  }

  clearEffects() {
    this.aim.cancel();
    this.abilities.clear();
    this.particles.reset();
    this.decals.clear();
    this.bursts.clear();
    this.lights.reset();
    this.shake.reset();
    this.flash.reset();
  }

  /* ------------------------------------------------------------------ */

  /** Load assets, warm the shader cache, then start the loop. */
  async load() {
    const assets = new AssetLoader();

    this.loading.setProgress(0.05, 'Loading environment…');
    const hdr = await assets.loadHDR(HDR_URL);
    await this.environment.loadEnvironment(hdr);
    frame.uEnvMap.value = this.environment.equirect;

    this.loading.setProgress(0.42, 'Raising the duel hall…');
    await this.hall.load(assets);

    this.loading.setProgress(0.5, 'Loading character…');
    await this.character.load(assets);

    this.loading.setProgress(0.72, 'Loading targets…');
    await this.dummies.load(assets);

    this.loading.setProgress(0.848, 'Waking the shark…');
    const shark = await assets.loadGLTF(SHARK_URL);
    await assets.settled();
    this.models.shark = buildSharkRig(shark, { length: settings.shark.length });

    this.loading.setProgress(0.8485, 'Calling the wolf…');
    // Authored in Blender; without it the rifts still open, with nothing coming through.
    const wolf = await assets.loadGLTF(WOLF_URL).catch(() => null);
    await assets.settled();
    this.models.wolf = wolf ? buildWolfRig(wolf, { length: settings.wolf.length }) : null;

    this.loading.setProgress(0.849, 'Waking the dragon…');
    const dragon = await assets.loadGLTF(DRAGON_URL);
    await assets.settled();
    this.models.dragon = buildDragonRig(dragon, { wingspan: settings.dragon.wingspan });

    this.loading.setProgress(0.8495, 'Winding the gyroscope…');
    const gyro = await assets.loadGLTF(GYRO_URL);
    await assets.settled();
    this.models.gyro = buildGyroscopeRig(gyro, { height: settings.gyro.size });

    this.loading.setProgress(0.8498, 'Cutting the amethyst…');
    // Cut in Blender; the ability falls back to a stand-in if it never lands.
    const amethyst = await assets.loadGLTF(AMETHYST_URL).catch(() => null);
    this.models.amethyst = buildAmethystRig(amethyst);

    this.loading.setProgress(0.8499, 'Binding the tome…');
    // Built in Blender; without it the orrery still opens, with no book under it.
    const tome = await assets.loadGLTF(TOME_URL).catch(() => null);
    this.models.tome = buildTomeRig(tome);

    this.loading.setProgress(0.84995, 'Carving the reliquary…');
    // Cut in Blender; without it the halo stands in plain ring pieces.
    const reliquary = await assets.loadGLTF(RELIQUARY_URL).catch(() => null);
    this.models.reliquary = buildReliquaryRig(reliquary);

    await this._precompile(0.85, 0.99);

    this.loading.setProgress(1, 'Ready');
    this.loading.hide();
    this.hud.reveal();

    this.start();
  }

  /**
   * Build every ability and draw it once, behind the loading veil.
   *
   * This used to be a single `WebGLRenderer#compileAsync` over the scene, and it
   * was doing close to nothing, for two separate reasons.
   *
   * The first is that **the abilities were not in the scene yet.** Their pools
   * are lazy, so at that point not one ability object existed and there was
   * nothing of theirs to compile.
   *
   * The second would have bitten even if they had been: **three compiles a
   * program for the state a material is drawn in, and `compile` guesses that
   * state from the render target that happens to be bound.** The program cache
   * key carries `outputColorSpace` and `toneMapping`, and both differ between
   * drawing to the canvas (sRGB, ACES) and drawing into the composer's HDR
   * target (linear, none) — which is the only way this app ever draws. Every
   * program that call produced was keyed for a render that never happens, and
   * was compiled a second time on the first real frame. The light counts have
   * the same problem: the distortion pass renders with the camera restricted to
   * one layer, so its materials want a *no point lights* variant that a compile
   * against the full camera never asks for.
   *
   * So the warm-up is a real frame from the real pipeline instead — depth
   * prepass, distortion pass, shadow map, composer — with the ability revealed
   * inside it. That pays up front, one ability at a time, for everything the
   * first cast used to pay for mid-fight: the geometry generation, the program
   * compiles for all four passes, and the first upload of every vertex buffer.
   *
   * @param {number} from progress ratio to start the labels at
   * @param {number} to   progress ratio to finish on
   */
  async _precompile(from, to) {
    const elements = this.abilities.elements;
    // Impact-only shaders: these are built on the first decal or shell of each
    // kind, which is a second hitch a moment after the first cast's.
    const releaseDecals = this.decals.prewarm();
    const releaseBursts = this.bursts.prewarm();

    // The arrow and the zone circle are hidden until the first arm, so they
    // would otherwise compile on the first press of Q.
    this._warmDraw([this.aim.object3D]);

    const warmed = [];
    for (let i = 0; i < elements.length; i++) {
      const element = elements[i];
      this.loading.setProgress(
        from + (to - from) * (i / elements.length),
        `Compiling ${ELEMENT_META[element]?.label ?? element}…`
      );
      // Both halves below block the main thread for as long as they take, so
      // yield first or the veil never shows a single one of these labels.
      await nextFrame();

      const ability = this.abilities.prewarm(element);
      if (!ability) continue;
      warmed.push(ability.group);
      this._warmDraw([ability.group]);
    }

    // The cathedral scan (loaders/StoneTextures.js) may still be downloading,
    // and a texture is uploaded to the GPU by the first draw that binds it
    // after its image lands — which would be the first cast, decoding four JPEGs mid-frame. So wait for them
    // and draw once more. Everything else on this pass is already compiled;
    // this frame exists only to move bytes.
    await waitFor(() => getStoneTextures().state.loaded >= 4, 4000);
    this._warmDraw(warmed);

    releaseDecals();
    releaseBursts();
  }

  /**
   * One full pipeline frame with `roots` forced visible.
   *
   * Visibility and frustum culling are both overridden, because three skips an
   * invisible subtree outright and a culled mesh never reaches `setProgram` —
   * either one would leave a shader for the first cast to compile. Only what
   * this call changed is put back, so a mesh that was hidden by its own
   * constructor stays hidden.
   *
   * @param {THREE.Object3D[]} roots
   */
  _warmDraw(roots) {
    const hidden = [];
    const culled = [];

    for (const root of roots) {
      root.traverse((node) => {
        if (node.visible === false) {
          node.visible = true;
          hidden.push(node);
        }
        if (node.frustumCulled === true) {
          node.frustumCulled = false;
          culled.push(node);
        }
      });
    }

    // Same order as `frame()`, so every pass sees what it will see in flight.
    // Nothing here is skipped: the warm-up has to touch every program the
    // pipeline can ask for, which is the whole point of it.
    this.renderer.gl.shadowMap.needsUpdate = true;
    this.contactShadows.render(this.scene);
    this.post.sync(this.elapsed, this.flash);
    this.post.render();

    for (const node of hidden) node.visible = false;
    for (const node of culled) node.frustumCulled = true;
  }

  /**
   * Is anything on screen that samples the depth buffer or writes a distortion
   * offset? Ability meshes, particles and burst shells are the only three, so
   * when all of them are gone both auxiliary passes have nothing to feed and
   * `PostProcessing#render` skips them.
   */
  get _liveEffects() {
    return (
      this.abilities.active.length > 0 ||
      this.particles.live ||
      this.bursts.active.length > 0
    );
  }

  start() {
    this.time.reset();
    const loop = () => {
      this._raf = requestAnimationFrame(loop);
      this.frame();
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this._raf);
  }

  /**
   * Turn camera mode on or off.
   *
   * Starting is asynchronous — the permission prompt, the wasm fileset and a
   * 7 MB model all have to land — so the panel is shown first and carries its
   * own "starting" line rather than the app freezing on a black corner.
   */
  async _toggleCamera() {
    if (this.cameraMode) {
      this.cameraMode = false;
      // The phone first, while `cameraMode` is already off: its `ended` must
      // not send the tracker looking for a webcam that is about to be stopped.
      this.phone.close();
      this.hud.camera.phone.reset();
      this.hands.stop();
      this.hud.setCameraVisible(false);
      this.editor.setHidden(this._editorWasHidden);
      this.aim.cancel();
      this.hud.showToast('Camera mode off');
      return;
    }

    this.cameraMode = true;
    // The editor is a tall right-hand column and the preview wants the corner
    // underneath it; at a laptop's window height they overlap outright. Camera
    // mode is a presentation mode, so the dev tool stands down — `G` still
    // brings it back for anyone who wants both.
    this._editorWasHidden = this.editor.hidden;
    this.editor.setHidden(true);
    this.hud.setCameraVisible(true);
    this.hud.camera.setStatus('Starting camera…');

    if (!(await this.hands.start())) return;
    this.hud.camera.attach(this.hands.video);
    this.hud.showToast('Open your palm to engage');
  }

  /**
   * Put the phone's QR code up — or, when the relay cannot be used from a
   * phone, the line that says why. Idempotent: the no-webcam path calls it
   * every time the webcam fails, and the button calls it on a whim.
   */
  async _pairPhone() {
    const pairing = this.hud.camera.phone;
    if (!this.phone.info) await this.phone.probe();
    if (!this.phone.available) {
      pairing.showUnavailable();
      return;
    }
    if (!this.phone.reachable) {
      pairing.showNeedsLan(this.phone.info.https);
      return;
    }
    await this.phone.connect();
    pairing.showCode(this.phone.pageUrl, { alternatives: this.phone.urls.length > 1 });
    if (this.phone.live) pairing.setLive(true);
  }

  /** "Back to the webcam": drop the phone, live or not, and close the section. */
  async _unpairPhone() {
    const wasLive = this.phone.live;
    // Closing a live link emits `ended`, and that handler brings the webcam
    // back; only the idle case has to ask for it here.
    this.phone.close();
    this.hud.camera.phone.reset();
    if (wasLive || !this.cameraMode || this.hands.ready) return;
    if (await this.hands.useLocalCamera()) this.hud.camera.attach(this.hands.video);
  }

  /* ------------------------------------------------------------------ */

  frame() {
    const gl = this.renderer.gl;
    gl.info.reset();

    const raw = this.time.tick();
    const dt = this.paused ? 0 : raw * settings.global.timeScale;
    this.elapsed += dt;

    /* ---- shared uniforms ---- */
    frame.uTime.value = this.elapsed;
    frame.uDelta.value = dt;
    frame.uShaderIntensity.value = settings.global.shaderIntensity;
    frame.uGlobalGlow.value = settings.global.glow;
    frame.uCameraNear.value = this.camera.near;
    frame.uCameraFar.value = this.camera.far;

    /* ---- simulation ---- */
    this.renderer.syncSettings();

    this.environment.setFocus(this.character.position.x, this.character.position.z);
    this.environment.update();

    // Hand tracking also runs on real time, and *before* targeting: the pointer
    // it emits has to be in the aim controller by the time that resolves, or the
    // indicator trails the hand by a frame.
    if (this.cameraMode) {
      this.hands.update(raw);
      this.hud.camera.update(this.hands.state, this.hands.latest, { element: this.element });
    }

    // Targeting runs on *real* time so the arrow keeps sweeping and animating
    // while the sandbox is paused — pausing freezes the effects, not the UI.
    this.aim.setOrigin(this.character.position);
    this.aim.update(raw);

    if (settings.character.turnToAim && this.aim.isArmed) {
      this.character.turnToward(this.aim.facing, settings.character.turnRate, raw);
    }
    this.character.update(dt);

    for (const [element, remaining] of this.cooldowns) {
      if (remaining > 0) this.cooldowns.set(element, Math.max(0, remaining - raw));
    }

    // A cast puts the arrow away, and the keyboard brings it back with a
    // keypress. The hand has no key: its open palm *is* the arm, and it is
    // already up. So while it is engaged the arrow comes back on its own the
    // moment the slot is ready — on that edge only, not every frame, so
    // Escape still puts it away and lowering the hand still cancels.
    const slotReady = (this.cooldowns.get(this.element) ?? 0) <= 0;
    if (slotReady && !this._slotReady && this.cameraMode && this.hands.state.engaged) {
      this.aim.arm();
    }
    this._slotReady = slotReady;

    this.ground.update(this.elapsed);
    // The castle's burn runs on wall-clock time: a switch flipped while paused
    // or in slow motion should still answer at once.
    this.hall.update(dt, this.elapsed, raw);
    this.hud.setCastle(settings.hall.enabled && settings.hall.castle);
    this.dust.update(this.elapsed, this.character.position);

    this.abilities.update(dt);
    // The targets step first, then read the casts that were just advanced: a
    // body has to be standing in this frame's pose before it can be knocked
    // out of it.
    this.dummies.update(dt, this.character.position);
    this.dummies.applyHits(this.abilities.active);
    // Anything drawn onto a body is drawn off the pose it has just been given.
    this.abilities.lateUpdate(dt);
    this.particles.flush(this.elapsed);
    this.decals.update(dt);
    this.bursts.update(dt);
    this.lights.update(dt);

    /* ---- camera ---- */
    this.shake.update(raw);
    this.flash.update(raw);
    const focus = this.abilities.focus;
    if (focus) this.rig.lookAt(focus.position, focus.cameraWeight);
    this.rig.setAnchor(this.character.position.x, 0, this.character.position.z);
    // Steering the view is edge-only, and only while a cast is armed: holding
    // the hand anywhere in the middle of the frame moves nothing, and letting
    // the aim go slides the view back over the caster.
    this.rig.pan(this.aim.isArmed ? this.aim.pointer : null, raw);
    this.rig.update(raw);

    this.contactShadows.setPosition(this.character.position.x, this.character.position.z);
    this.contactShadows.render(this.scene);

    /* ---- render ---- */
    // Exactly one sun shadow update per frame (see Renderer). The flag is
    // raised here but only *consumed* by the main pass: every auxiliary pass
    // holds it back, because each of them renders with the camera pinned to a
    // single layer and would build a map missing everyone else's casters.
    gl.shadowMap.needsUpdate = true;
    this.post.sync(this.elapsed, this.flash);
    this.post.render(this._liveEffects);

    /* ---- readouts ---- */
    for (const element of ELEMENTS) {
      this.hud.setCooldown(element, this.cooldowns.get(element) ?? 0, settings[element].cooldown);
    }
    this.hud.setArmed(this.aim.isArmed);
    this.hud.update(raw, () => ({
      particles: this.particles.countLive(this.elapsed),
      calls: gl.info.render.calls,
      spikes: this.abilities.active.reduce((total, ability) => total + ability.instanceCount, 0),
      abilities: this.abilities.active.length
    }));
  }

  /* ------------------------------------------------------------------ */

  dispose() {
    this.stop();
    this.input.dispose();
    this.hands.dispose();
    this.phone.dispose();
    this.aim.dispose();
    this.abilities.dispose();
    this.particles.dispose();
    this.decals.dispose();
    this.bursts.dispose();
    this.lights.dispose();
    this.dummies.dispose();
    this.character.dispose();
    this.ground.dispose();
    this.hall.dispose();
    this.dust.dispose();
    this.contactShadows.dispose();
    this.post.dispose();
    this.environment.dispose();
    this.editor.dispose();
    this.rig.dispose();
    this.renderer.dispose();
  }
}
