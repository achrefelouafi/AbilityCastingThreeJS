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
import { buildDroneRig } from '../assets/DroneRig.js';
import { buildMonowheelRig } from '../assets/MonowheelRig.js';
import { buildPhoenixRig } from '../assets/PhoenixRig.js';
import { buildSharkRig } from '../assets/SharkRig.js';
import { buildDragonRig } from '../assets/DragonRig.js';
import { buildGyroscopeRig } from '../assets/GyroscopeRig.js';
import { buildAmethystRig } from '../assets/AmethystRig.js';
import { buildTomeRig } from '../assets/TomeRig.js';
import { CharacterController } from '../animation/CharacterController.js';
import { DummyField } from '../combat/DummyField.js';

import { InputManager } from '../input/InputManager.js';
import { AimController } from '../input/AimController.js';
import { HandInput } from '../input/HandInput.js';
import { PhoneCameraLink } from '../input/PhoneCamera.js';
import { ARSession } from '../ar/ARSession.js';
import { openPrintableMat } from '../ar/StageMat.js';

import { ParticleEngine } from '../particles/ParticleEngine.js';
import { LightPool } from '../effects/LightPool.js';
import { DecalSystem } from '../effects/GroundDecals.js';
import { BurstSystem } from '../effects/BurstSphere.js';
import { CameraShake } from '../effects/CameraShake.js';
import { ScreenFlash } from '../effects/ScreenFlash.js';

import { AbilityManager } from '../abilities/AbilityManager.js';
import { DroneState } from '../abilities/DroneAbility.js';
import { PostProcessing } from '../postprocessing/PostProcessing.js';

import { HUD, LoadingScreen } from '../ui/HUD.js';
import { Editor } from '../ui/Editor.js';

import { settings, ELEMENTS, ELEMENT_META, isSummon } from '../config/settings.js';

const HDR_URL = './hdri/spruit_sunrise.hdr';
const DRONE_URL = './models/drone.glb';
const MONOWHEEL_URL = './models/monowheelArmyBot.glb';
const PHOENIX_URL = './models/phoenix_bird.glb';
const SHARK_URL = './models/shark.glb';
const DRAGON_URL = './models/dragon.glb';
const GYRO_URL = './models/magical_gyroscope.glb';
const AMETHYST_URL = './models/amethyst_stones.glb';
const TOME_URL = './models/arcane_tome.glb';

const _summonHeading = new Vector3();

/** What the toasts call each construct. */
const SUMMON_NAMES = { drone: 'drone', monowheel: 'bot' };

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
 *
 * The exception is a **summon** (`CastShape.SUMMON`: the drone, the monowheel
 * bot): its slot is a toggle rather than an arm, it is driven for as long as
 * it is out, and every other slot is refused while it is. App owns that lock,
 * because it is the one place every route into a cast — key, HUD click, hand
 * — passes. Both constructs answer the same control surface, so one deck and
 * one set of handlers drive whichever is out.
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
    /**
     * AR mode: the stage anchored to a real rectangle seen by a camera.
     * Cold like the others — the worker, the canvases and the video element
     * cost nothing until `N`. See `ar/ARSession.js`.
     */
    this.ar = new ARSession();
    this.arMode = false;
    /** Which camera feeds the tracker: 'phone' | 'webcam' | ''. */
    this._arSource = '';
    /** Where the hands come from in AR mode: the AR camera, or the webcam. */
    this._arHands = 'ar';
    /** A webcam opened for AR alone, to be closed with it. */
    this._arWebcam = null;
    this._arEditorWasHidden = false;
    this._arSavedClip = { near: 0.1, far: 400 };
    /** The rendered view, captured for the phone to look through. */
    this._returnStream = null;
    this._stageSentAt = 0;

    /**
     * The summon that is out, or null, and which slot it came from. Every
     * input route checks this before it arms anything — while it is set, the
     * caster is driving, not casting.
     */
    this.summon = null;
    this.summonElement = null;
    /** Which of the hold-to-fire sources are down, so releasing one does not
     *  silence another. */
    this._mouseFiring = false;
    this._keysFiring = false;
    this._keySteering = false;
    this.aim = new AimController(this.camera);
    // A targeted cast locks its circle onto a body; the field is who it can pick.
    this.aim.targets = this.dummies;
    /** What the detection boxes are handed while a targeted cast is aimed. */
    this._aimMark = { targets: [], mark: null, lock: 0, position: new Vector3(), lockedLabel: 'MARKED' };
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
      // With a summon out, the button is a trigger and stays one until it
      // comes back up.
      if (this.summonOnStation) {
        this._mouseFiring = true;
        this._syncSummonFire();
        return;
      }
      this.aim.point(pointer);
      this.aim.confirm();
    });
    this.input.on('pointer:release', () => {
      if (!this._mouseFiring) return;
      this._mouseFiring = false;
      this._syncSummonFire();
    });
    this.input.on('action', (action, slot) => this._handleAction(action, slot, 'keys'));

    this.aim.on('cast', (origin, direction, distance) => this._cast(origin, direction, distance));
    this.aim.on('reject', () => this.hud.showToast('Too close — aim further out'));

    // Hand tracking speaks the same three events as the keyboard and mouse, so
    // it subscribes to the same handlers. Nothing downstream of this bus knows
    // which of the two is driving, and both stay live at once — on a stage the
    // keyboard fallback has to be one keypress away, never a mode away.
    this.hands.on('pointer:move', (pointer) => {
      // The open hand is the summon's stick while it is out: off the centre
      // of the frame it drives, near the centre it holds.
      if (this.summonOnStation) this.summon.steerFromPointer(pointer);
      this.aim.point(pointer);
    });
    this.hands.on('pointer:confirm', (pointer) => {
      // The fist is the trigger while it is out — `grab` carries that — and
      // must not also be read as a cast.
      if (this.summonLocked) return;
      this.aim.point(pointer);
      this.aim.confirm();
    });
    this.hands.on('grab', () => this._syncSummonFire());
    this.hands.on('pointer:lost', () => {
      // The arm came down. The summon holds where it is and stops shooting;
      // it does not come home — that is a deliberate gesture, not a lapse.
      if (!this.summonDeployed) return;
      this.summon.setSteer(0, 0);
      this._syncSummonFire();
    });
    this.hands.on('action', (action, slot) => this._handleAction(action, slot, 'hand'));
    this.hands.on('engaged', () => {
      if (this.summonLocked) {
        this.hud.showToast(`Hand tracking engaged — you are driving the ${this.summonName}`);
        return;
      }
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
    // way, and the panel's preview follows the tracker's video element. Two
    // panels can ask for the phone — the camera panel and the AR panel — so
    // the link's news goes to both pairing widgets.
    this.phone.on('status', (text, kind) => {
      for (const pairing of this._pairings) pairing.setStatus(text, kind);
    });
    this.phone.on('stream', async (stream) => {
      for (const pairing of this._pairings) pairing.setLive(true);
      this.hud.ar.setSource(this._arSource, { phoneLive: true });
      // The tracker first, when the phone is its camera; then the hands, in
      // camera mode, unless AR mode has them on the webcam instead.
      if (this.arMode && this._arSource === 'phone') {
        await this.ar.attach(stream);
        this._sendViewToPhone(true);
      }
      if (!this.cameraMode) return;
      if (this.arMode && this._arSource === 'phone' && this._arHands !== 'ar') return;
      if (!(await this.hands.setStream(stream))) return;
      this.hud.camera.attach(this.hands.video);
      await this._routeARHands();
      this.hud.showToast('Phone camera connected — open your palm to engage');
    });
    this.phone.on('ended', async () => {
      for (const pairing of this._pairings) pairing.setLive(false);
      if (this.arMode && this._arSource === 'phone') {
        this.ar.detach();
        this._arSource = '';
        this.hud.ar.setSource('', { phoneLive: false });
        this.hud.ar.setStatus('The phone went away — pair it again, or use the webcam', 'warn');
      }
      if (!this.cameraMode) return;
      this.hud.camera.setStatus('Phone gone — back to the webcam…');
      if (await this.hands.useLocalCamera()) {
        this.hud.camera.attach(this.hands.video);
        this.hands.setPointerMap(null);
        this.hud.camera.setMirrored(true);
        this.hud.showToast('Back on the webcam');
      }
    });
    this.hud.camera.phone.onOpen = () => this._pairPhone(this.hud.camera.phone);
    this.hud.camera.phone.onClose = () => this._unpairPhone();
    this.hud.camera.phone.onNextUrl = () => this.phone.nextUrl();

    // AR mode. The panel fires intents; the session reports back.
    const ar = this.hud.ar;
    ar.onSource = (kind) => this._setARSource(kind);
    ar.onFreeze = () => this._arFreeze();
    ar.onLock = (corners, aspect) => this._arLock(corners, aspect);
    ar.onUnlock = () => {
      this.ar.unlock();
      ar.setStatus('Unlocked — freeze a frame to place the stage again', 'info');
    };
    ar.onSpan = (span) => {
      this.ar.stageSpan = span;
    };
    ar.onFov = (hfov) => this.ar.setManualHfov(hfov);
    ar.onHands = (kind) => this._setARHands(kind);
    ar.onPrintMat = () => {
      if (!openPrintableMat()) this.hud.showToast('The browser blocked the print window — allow pop-ups for this page');
    };
    ar.phone.onOpen = () => this._setARSource('phone');
    ar.phone.onClose = () => this._unpairPhone();
    ar.phone.onNextUrl = () => this.phone.nextUrl();
    this.ar.on('status', (text, kind) => ar.setStatus(text, kind));
    this.ar.on('video', (width, height) => {
      if (width) ar.setStatus(`Camera ${width}×${height} — freeze a frame with the rectangle in view`, 'info');
    });

    // The phone placing the stage itself. Its frozen frame and corners lock
    // the tracker here; its handles are mirrored on the panel as they move.
    // A placement arriving with AR mode off turns it on — the phone drives.
    this.phone.on('plane', async ({ corners, aspect, image }) => {
      if (!this.arMode) await this._toggleAR();
      if (this._arSource !== 'phone') await this._setARSource('phone');
      if (!this.ar.attached) {
        ar.setStatus('The phone placed the stage before its video arrived — tap Place again', 'warn');
        return;
      }
      ar.endPlacement();
      ar.setRemoteCorners(null);
      ar.setAspect(aspect);
      if (!(await this.ar.lockFromImage(image, corners, aspect))) {
        ar.setStatus('Could not lock on the phone\u2019s placement', 'error');
        return;
      }
      this.hud.showToast('Stage placed from the phone');
    });
    this.phone.on('corners', (corners) => {
      if (this.arMode && this._arSource === 'phone') ar.setRemoteCorners(corners);
    });
    this.phone.on('unplace', () => {
      if (!this.arMode) return;
      this.ar.unlock();
      ar.setRemoteCorners(null);
      ar.setStatus('The phone took the stage away — place it again from there', 'info');
    });

    this.hud.onAbility = (element) => this.armAbility(element);
    this.hud.drone.on('steer', (x, y) => {
      if (this.summonOnStation) this.summon.steerFromStick(x, y);
    });
    this.hud.drone.on('fire', (down) => {
      this._mouseFiring = down;
      this._syncSummonFire();
    });
  }

  /** The summon is out, in any state — deploying, on station, or on its way home. */
  get summonDeployed() {
    return !!this.summon && this.summon.isActive;
  }

  /**
   * The summon is out and *holding the bar*: deploying or on station. One
   * on its way home has let go — the slot can be cast again while it prints
   * out, which is a second the presenter does not have to wait.
   */
  get summonLocked() {
    return this.summonDeployed && this.summon.state !== DroneState.RECALL;
  }

  /** The summon is out *and* answering the stick. */
  get summonOnStation() {
    return !!this.summon && this.summon.isOnStation;
  }

  /** Fold every hold-to-fire source into the one flag the summon reads. */
  _syncSummonFire() {
    if (!this.summonOnStation) return;
    this.summon.setFiring(this._mouseFiring || this._keysFiring || this.hands.state.grabbing);
  }

  /**
   * @param {string} action
   * @param {number} slot
   * @param {'keys'|'hand'} [source] which bus it came in on. Almost nothing
   *   cares; `cancel` does, because a hand that dropped out of frame and a
   *   presenter pressing Escape mean different things to a drone.
   */
  _handleAction(action, slot, source = 'keys') {
    switch (action) {
      case 'ability': {
        const element = ELEMENTS[slot] ?? this.element;
        // A summon's slot is a switch: the same press deploys and recalls.
        if (isSummon(element)) {
          this._toggleSummon(element);
          break;
        }
        if (this.summonLocked) {
          this.hud.showToast(`Recall the ${this.summonName} first`);
          break;
        }
        // Pressing the *same* key again puts an armed cast away, as it does in a
        // MOBA; pressing a different one swaps the slot without disarming.
        if (this.aim.isArmed && element === this.element) this.aim.cancel();
        else this.armAbility(element);
        break;
      }
      case 'abilityStep': {
        // With a summon out, the swap gesture is the recall: the presenter
        // is saying "next", and the construct is what has to go first. The
        // slot stays where it is — the next point steps it.
        if (this.summonLocked) {
          this._toggleSummon(this.summonElement);
          break;
        }
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
        // Escape brings the summon home. A hand lost to the tracker does not
        // — that fires the same action, and the construct should hold through
        // it — and neither does the right button, which is how the view is
        // orbited and would otherwise recall it on every drag.
        if (this.summonLocked && source !== 'hand' && slot !== 'pointer') {
          this._toggleSummon(this.summonElement);
          break;
        }
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
      case 'toggleAR':
        this._toggleAR();
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
    if (isSummon(element)) {
      this._toggleSummon(element);
      return;
    }
    if (this.summonLocked) {
      this.hud.showToast(`Recall the ${this.summonName} first`);
      return;
    }
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
    // A summon in the slot has no line to cast along: the confirm is the
    // toggle. This is the hand's way in — point to the slot, close the fist.
    if (isSummon(element)) {
      this._toggleSummon(element);
      return;
    }
    this.abilities.cast(origin, direction, distance, element);
    this.cooldowns.set(element, Math.max(0, settings[element].cooldown));

    // Snap onto the shot and throw the body into it. Which clip that is belongs
    // to the ability, so each spell can be cast with its own gesture.
    this.character.setFacing(this.aim.facing);
    this.character.playCast(settings[element].castAnim);
    this.character.castLunge();
  }

  /** What the toasts call the construct that is out. */
  get summonName() {
    return SUMMON_NAMES[this.summonElement] ?? 'summon';
  }

  /**
   * Deploy a summon, or bring it home.
   *
   * Deploying is a cast in every way that matters to the rest of the app —
   * it goes through the manager, it is pooled, the camera follows it — but
   * it is not aimed, and it does not start a cooldown: that starts on the
   * recall, because until then the slot is *in use*, not spent.
   *
   * Only one construct is out at a time. Pressing the slot of the one that is
   * out recalls it; pressing the other's while it holds the bar is refused,
   * the same as any cast would be.
   */
  _toggleSummon(element) {
    if (this.summonDeployed) {
      if (element !== this.summonElement) {
        if (this.summonLocked) {
          this.hud.showToast(`Recall the ${this.summonName} first`);
          return;
        }
        // The other one is already on its way out: it has let go of the bar,
        // and the manager retires it on its own. This one can go straight out.
      } else {
        if (this.summon.state === DroneState.RECALL) return;
        this.summon.recall();
        this.cooldowns.set(element, Math.max(0, settings[element].cooldown));
        this.hud.setDeployed(element, false);
        this.hud.drone.setVisible(false);
        this.hud.showToast(`${ELEMENT_META[element].label} recalled`);
        return;
      }
    }

    if ((this.cooldowns.get(element) ?? 0) > 0) {
      this.hud.showToast('Not ready');
      return;
    }

    this.selectAbility(element, { silent: true });
    this.aim.cancel();

    const yaw = this.character.facing;
    _summonHeading.set(Math.sin(yaw), 0, Math.cos(yaw));
    const summon = this.abilities.cast(this.character.position, _summonHeading, settings[element].range, element);
    if (!summon) return;
    this.summon = summon;
    this.summonElement = element;

    this._mouseFiring = false;
    this._keysFiring = false;
    this._keySteering = false;
    this.hud.setDeployed(element, true);
    this.hud.drone.setLabel(
      ELEMENT_META[element].deck ?? element.toUpperCase(),
      ELEMENT_META[element].key,
      element === 'drone' ? 'fly' : 'drive'
    );
    this.hud.drone.setVisible(true);
    this.hud.showToast(`${ELEMENT_META[element].label} deployed — hold fire to engage`);
    this.character.playCast(settings[element].castAnim);
  }

  /** The summon is gone — recalled, cleared, or retired. Put the deck away. */
  _summonDown() {
    if (this.summonElement) this.hud.setDeployed(this.summonElement, false);
    this.summon = null;
    this.summonElement = null;
    this._mouseFiring = false;
    this._keysFiring = false;
    this._keySteering = false;
    this.hud.drone.setVisible(false);
  }

  /**
   * The keys as a stick: WASD or the arrows drive, Space fires.
   *
   * Only ever *writes* the steer while a key is down, and writes a zero once
   * on the release, so the stick and the hand are free to drive in between.
   */
  _pollSummonKeys() {
    if (!this.summonOnStation) return;
    const keys = this.input.keys;

    let x = 0;
    let y = 0;
    if (keys.has('KeyW') || keys.has('ArrowUp')) y += 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) y -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) x += 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) x -= 1;
    const steering = x !== 0 || y !== 0;
    if (steering) this.summon.setSteer(x, y);
    else if (this._keySteering) this.summon.setSteer(0, 0);
    this._keySteering = steering;

    const firing = keys.has('Space');
    if (firing !== this._keysFiring) {
      this._keysFiring = firing;
      this._syncSummonFire();
    }
  }

  clearEffects() {
    this.aim.cancel();
    this.abilities.clear();
    if (this.summon) this._summonDown();
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

    this.loading.setProgress(0.35, 'Loading floor…');
    await this.ground.loadTextures(assets);

    this.loading.setProgress(0.42, 'Raising the duel hall…');
    await this.hall.load(assets);

    this.loading.setProgress(0.5, 'Loading character…');
    await this.character.load(assets);

    this.loading.setProgress(0.72, 'Loading targets…');
    await this.dummies.load(assets);

    this.loading.setProgress(0.8, 'Loading the drone…');
    const drone = await assets.loadGLTF(DRONE_URL);
    this.models.drone = buildDroneRig(drone.scene, { span: settings.drone.size });

    this.loading.setProgress(0.838, 'Loading the monowheel bot…');
    const monowheel = await assets.loadGLTF(MONOWHEEL_URL);
    this.models.monowheel = buildMonowheelRig(monowheel.scene, { height: settings.monowheel.size });

    this.loading.setProgress(0.845, 'Waking the phoenix…');
    const phoenix = await assets.loadGLTF(PHOENIX_URL);
    // The textures are still in flight when the model resolves; the bird's
    // shaders sample them on the warm-up draw, so wait for them to land.
    await assets.settled();
    this.models.phoenix = buildPhoenixRig(phoenix, { wingspan: settings.phoenix.wingspan });

    this.loading.setProgress(0.848, 'Waking the shark…');
    const shark = await assets.loadGLTF(SHARK_URL);
    await assets.settled();
    this.models.shark = buildSharkRig(shark, { length: settings.shark.length });

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

    // Building the Toxic Shield is what *starts* the cathedral scan
    // downloading (loaders/StoneTextures.js), and a texture is uploaded to the
    // GPU by the first draw that binds it after its image lands — which would
    // be the first cast again, decoding four JPEGs mid-frame. So wait for them
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

    // In AR mode the hands may belong on the AR camera rather than the
    // webcam; the tracker is up either way, so the routing is one call.
    if (this.arMode && this._arHands === 'ar' && this.ar.stream) {
      if (!(await this.hands.start(this.ar.stream))) return;
      await this._routeARHands();
    } else if (!(await this.hands.start())) {
      return;
    }
    this.hud.camera.attach(this.hands.video);
    this.hud.showToast('Open your palm to engage');
  }

  /** Both places the phone can be paired from. */
  get _pairings() {
    return [this.hud.camera.phone, this.hud.ar.phone];
  }

  /**
   * Put the phone's QR code up — or, when the relay cannot be used from a
   * phone, the line that says why. Idempotent: the no-webcam path calls it
   * every time the webcam fails, and the button calls it on a whim.
   *
   * @param {import('../ui/PhonePairing.js').PhonePairing} [pairing] which
   *   panel's widget shows the code
   */
  async _pairPhone(pairing = this.hud.camera.phone) {
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
    for (const pairing of this._pairings) pairing.reset();
    if (wasLive || !this.cameraMode || this.hands.ready) return;
    if (await this.hands.useLocalCamera()) this.hud.camera.attach(this.hands.video);
  }

  /* ------------------------------------------------------------------ */
  /* AR mode                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Turn AR mode on or off.
   *
   * On: the backdrop, the fog and the stone floor stand down (the camera
   * frame is the backdrop, the real table is the floor, and it keeps the
   * shadows), the orbit rig lets go of the camera, and the panel takes the
   * presenter through camera → freeze → corners → lock. A camera that is
   * already open — the phone, or the webcam the hands are on — is taken as
   * the first choice, so the common case is one keypress and a drag.
   */
  async _toggleAR() {
    if (this.arMode) {
      this.arMode = false;
      this.phone.arHint = false;
      this.hud.setARVisible(false);
      this.post.setVideo(null);
      this.environment.setAR(false);
      this.ground.setShadowCatcher(false);
      this.hall.setAR(false);
      this.rig.controls.enabled = true;
      this.camera.near = this._arSavedClip.near;
      this.camera.far = this._arSavedClip.far;
      const size = this.renderer.size;
      this.rig.resize(size.width, size.height);
      this.hands.setPointerMap(null);
      this.hud.camera.setMirrored(true);
      this.hud.ar.setRemoteCorners(null);

      // The phone goes back to being a plain camera, and stops getting the view.
      this._sendViewToPhone(false);
      if (this.phone.live) this.phone.requestMode({ ar: false });

      this.ar.detach();
      if (this._arWebcam) {
        const owned = this._arWebcam;
        this._arWebcam = null;
        const handsOnIt = this.cameraMode && this.hands.stream === owned;
        owned.getTracks().forEach((track) => track.stop());
        // The hands may have been reading the very stream that just stopped.
        if (handsOnIt && (await this.hands.useLocalCamera())) this.hud.camera.attach(this.hands.video);
      }
      this._arSource = '';
      this.editor.setHidden(this._arEditorWasHidden);
      this.hud.showToast('AR mode off');
      return;
    }

    this.arMode = true;
    this._arEditorWasHidden = this.editor.hidden;
    this.editor.setHidden(true);
    this.hud.setARVisible(true);
    this.environment.setAR(true);
    this.ground.setShadowCatcher(true);
    this.hall.setAR(true);
    this.rig.controls.enabled = false;
    this.aim.cancel();
    // The camera now stands tens of metres out in game units — a phone half
    // a metre over a sheet that spans sixteen — so the clip planes follow.
    this._arSavedClip.near = this.camera.near;
    this._arSavedClip.far = this.camera.far;
    this.camera.near = 0.5;
    this.camera.far = 1500;
    this.hud.ar.setHands(this._arHands);
    this.hud.ar.setSource('', { phoneLive: this.phone.live });
    this.hud.ar.setStatus('Pick the camera that looks at the table', 'info');
    this.hud.showToast('AR mode — pick a camera, freeze, drag the corners, lock');

    if (this.phone.live) await this._setARSource('phone');
    else if (this.hands.ready && this.hands.stream && this.hands.ownsStream) await this._setARSource('webcam');
  }

  /**
   * Choose the tracker's camera.
   *
   * The phone: paired from the AR panel if it is not yet, and asked for its
   * rear camera in HD when it is — a page of print at 640×480 is a page of
   * mush on a projector. The webcam: shared with the hands when they have
   * it open, opened for AR alone otherwise.
   */
  async _setARSource(kind) {
    this._arSource = kind;
    this.hud.ar.setSource(kind, { phoneLive: this.phone.live });

    if (kind === 'phone') {
      this.phone.arHint = true;
      if (this.phone.live) {
        this.hud.ar.phone.reset();
        await this.ar.attach(this.phone.stream);
        this.phone.requestMode({ ar: true });
        this._sendViewToPhone(true);
        this.hud.ar.setStatus('Phone camera — place the stage on the phone: freeze, drag the corners, place', 'live');
      } else {
        await this._pairPhone(this.hud.ar.phone);
      }
      return;
    }

    if (kind === 'webcam') {
      this.hud.ar.phone.reset();
      let stream = this.hands.ready && this.hands.ownsStream ? this.hands.stream : this._arWebcam;
      if (!stream) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'environment' },
            audio: false
          });
          this._arWebcam = stream;
        } catch (error) {
          this._arSource = '';
          this.hud.ar.setSource('', { phoneLive: this.phone.live });
          this.hud.ar.setStatus(
            error?.name === 'NotAllowedError' ? 'Webcam permission refused' : 'No webcam found — use the phone',
            'error'
          );
          return;
        }
      }
      await this.ar.attach(stream);
      this.hud.ar.setStatus('Webcam — point it at the table and freeze a frame', 'live');
      await this._routeARHands();
    }
  }

  /**
   * The phone looks *through* the stage: the rendered canvas goes back to
   * it as a video track on the line its offer reserved. Captured once, and
   * only while AR mode has the phone as its camera.
   */
  _sendViewToPhone(on) {
    if (on) {
      if (!this._returnStream) {
        try {
          this._returnStream = this.canvas.captureStream(30);
        } catch (error) {
          console.warn('[ar] could not capture the view for the phone', error);
          return;
        }
      }
      this.phone.setReturnTrack(this._returnStream.getVideoTracks()[0] ?? null);
      return;
    }
    this.phone.setReturnTrack(null);
    if (this._returnStream) {
      this._returnStream.getTracks().forEach((track) => track.stop());
      this._returnStream = null;
    }
  }

  _arFreeze() {
    if (!this.ar.freeze()) {
      this.hud.ar.setStatus('No picture yet — pick a camera first', 'warn');
      return;
    }
    this.hud.ar.beginPlacement(this.ar);
    this.hud.ar.setStatus('Frozen. Drag the four corners onto the rectangle — the loupe shows the exact pixel', 'info');
  }

  _arLock(corners, aspect) {
    this.hud.ar.endPlacement();
    if (!this.ar.lock(corners, aspect)) {
      this.hud.ar.setStatus('Could not lock — the four corners do not make a rectangle', 'error');
      return;
    }
    this.hud.showToast('Stage locked to the surface');
  }

  /** Which camera the hands read in AR mode. Applied now if they are up, or when they come up. */
  async _setARHands(kind) {
    this._arHands = kind;
    this.hud.ar.setHands(kind);
    await this._routeARHands();
  }

  /**
   * Put the hands on the camera AR mode says they belong on.
   *
   * On the AR camera the pointer is the palm's place *in the frame* — the
   * arrow sits under the real hand on the real table — and the preview is
   * shown the way round the main view shows it. On the webcam everything is
   * as in camera mode.
   */
  async _routeARHands() {
    if (!this.arMode || !this.cameraMode || !this.hands.ready) return;
    if (this._arHands === 'ar' && this.ar.stream) {
      if (this.hands.stream !== this.ar.stream) {
        if (!(await this.hands.setStream(this.ar.stream))) return;
        this.hud.camera.attach(this.hands.video);
      }
      this.hands.setPointerMap((x, y, out) => this.ar.frameToNdc(x, y, out));
      this.hud.camera.setMirrored(false);
      this.hud.camera.setStatus('Hands on the AR camera — reach over the table');
    } else {
      if (!this.hands.stream || this.hands.stream === this.ar.stream) {
        if (await this.hands.useLocalCamera()) this.hud.camera.attach(this.hands.video);
      }
      this.hands.setPointerMap(null);
      this.hud.camera.setMirrored(true);
    }
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
      this.hud.camera.update(this.hands.state, this.hands.latest, {
        element: this.element,
        // Locked, not merely deployed: one on its way home has let go of the
        // bar, and the slot's gestures are a cast's again.
        deployed: this.summonLocked,
        status: this._summonHandStatus()
      });
    }

    // Targeting runs on *real* time so the arrow keeps sweeping and animating
    // while the sandbox is paused — pausing freezes the effects, not the UI.
    this.aim.setOrigin(this.character.position);
    this.aim.update(raw);

    // The summon's bookkeeping. It can go on its own — recalled and faded,
    // cleared with C, retired by the manager — and the deck has to follow.
    if (this.summon && !this.summon.isActive) this._summonDown();
    this._pollSummonKeys();

    if (settings.character.turnToAim && this.aim.isArmed) {
      this.character.turnToward(this.aim.facing, settings.character.turnRate, raw);
    } else if (this.summonDeployed && settings[this.summonElement].watch) {
      // The operator watches the construct.
      const dx = this.summon.position.x - this.character.position.x;
      const dz = this.summon.position.z - this.character.position.z;
      if (dx * dx + dz * dz > 1) {
        this.character.turnToward(Math.atan2(dx, dz), settings.character.turnRate, raw);
      }
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
    if (
      slotReady &&
      !this._slotReady &&
      this.cameraMode &&
      this.hands.state.engaged &&
      !this.summonLocked &&
      !isSummon(this.element)
    ) {
      this.aim.arm();
    }
    this._slotReady = slotReady;

    this.ground.update(this.elapsed);
    this.hall.update(dt, this.elapsed);
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
    if (this.arMode) {
      // The tracker owns the camera: its pose, and a projection matching the
      // frame's lens and the crop that fits it to the window. Until a plane
      // is locked the frame is shown alone, whatever the scene is doing.
      const size = this.renderer.size;
      this.ar.fitViewport(size.width, size.height);
      if (this.ar.hasPose) {
        this.ar.applyCamera(this.camera, size.width, size.height);
        if (this.rig.shakeOffset.lengthSq() > 0) {
          this.camera.position.add(this.rig.shakeOffset);
          this.camera.rotateZ(this.rig.shakeRoll);
        }
      }
      this.post.setVideo(this.ar.videoWidth ? this.ar.texture : null, this.ar.videoScale, !this.ar.hasPose);
      this.hud.ar.update(this.ar);
      // The phone's status line, a few times a second.
      if (this._arSource === 'phone' && this.phone.live && performance.now() - this._stageSentAt > 250) {
        this._stageSentAt = performance.now();
        this.phone.sendStage({
          locked: this.ar.locked,
          tracking: this.ar.tracking,
          lost: this.ar.lost,
          inliers: this.ar.inliers,
          total: this.ar.total
        });
      }
    } else {
      const focus = this.abilities.focus;
      if (focus) this.rig.lookAt(focus.position, focus.cameraWeight);
      this.rig.setAnchor(this.character.position.x, 0, this.character.position.z);
      // Steering the view is edge-only, and only while a cast is armed: holding
      // the hand anywhere in the middle of the frame moves nothing, and letting
      // the aim go slides the view back over the caster.
      this.rig.pan(this.aim.isArmed ? this.aim.pointer : null, raw);
      this.rig.update(raw);
    }

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
    if (this.summonDeployed) this.hud.drone.setStatus(...this._summonStatus());
    // The detection boxes read the camera the frame was just drawn with, so
    // they sit on the bodies rather than a frame behind them.
    if (this.summonOnStation) {
      this.hud.targets.update(raw, this.camera, this.summon, settings[this.summonElement]);
    } else if (this.aim.isArmed && this.aim.target) {
      // A targeted cast: the body the circle has locked onto gets the brackets.
      const mark = this._aimMark;
      mark.targets[0] = this.aim.target;
      mark.targets.length = 1;
      mark.mark = this.aim.target;
      mark.lock = this.aim.lock;
      mark.position.copy(this.character.position);
      this.hud.targets.update(raw, this.camera, mark, settings[this.element]);
    } else {
      this.hud.targets.clear();
    }
    this.hud.update(raw, () => ({
      particles: this.particles.countLive(this.elapsed),
      calls: gl.info.render.calls,
      spikes: this.abilities.active.reduce((total, ability) => total + ability.instanceCount, 0),
      abilities: this.abilities.active.length
    }));
  }

  /** One line for the deck: what the summon is doing, and whether it is hot. */
  _summonStatus() {
    const summon = this.summon;
    if (summon.state === DroneState.DEPLOY) return ['Deploying…', false];
    if (summon.state === DroneState.RECALL) return [this.summonElement === 'drone' ? 'Returning' : 'Standing down', false];
    const n = summon.targetsInRange;
    if (summon.firing) {
      if (summon.mark) return [summon.lock >= 1 ? 'FIRING' : 'Locking…', true];
      return [n ? 'Acquiring…' : 'Scanning — nothing in range', true];
    }
    return [n ? 'On station · ' + n + ' in range' : 'On station', false];
  }

  /** What the camera panel should say while the hand is driving the summon. */
  _summonHandStatus() {
    if (!this.summonDeployed) return null;
    if (this.hands.state.grabbing) return 'Fist — firing';
    return this.summonElement === 'drone' ? 'Flying the drone' : 'Driving the bot';
  }

  /* ------------------------------------------------------------------ */

  dispose() {
    this.stop();
    this.input.dispose();
    this.hands.dispose();
    this.phone.dispose();
    this.ar.dispose();
    this._sendViewToPhone(false);
    this._arWebcam?.getTracks().forEach((track) => track.stop());
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
