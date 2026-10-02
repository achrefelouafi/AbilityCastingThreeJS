import { CanvasTexture, Matrix3, Matrix4, Quaternion, Vector2, Vector3, NoColorSpace, LinearFilter } from 'three';
import { EventEmitter } from '../utils/EventEmitter.js';
import { estimateFocal, fitHomography, mulH, orderQuad, poseFromHomography, projectH } from './planar.js';

/**
 * AR mode's main-thread half: the camera frames, the plane, and the pose.
 *
 * A `MediaStream` — the phone over WebRTC, or the webcam — goes into a video
 * element here and comes out as three things the app consumes:
 *
 *   - `texture`, the frame to draw *under* the scene. Not the live video: the
 *     frame the tracker last answered for, held until the next answer, so the
 *     pose and the picture are always the same instant. A live texture would
 *     run a frame ahead of the pose and the stage would swim on every move.
 *   - a camera pose, written into the app's camera by `applyCamera`, from the
 *     tracker's homography, the rectangle's shape and a focal length the
 *     session works out on its own.
 *   - `videoScale`, how the frame is cropped to fill the viewport, which the
 *     projection and the hand's pointer both have to agree with.
 *
 * The plane is picked by the user: four corners on a frozen frame (`freeze`
 * → `lock`). Its aspect ratio is all the geometry that is needed — a sheet
 * of A4 is 1.414 — and the *scale* of the stage on it is a free choice
 * (`stageSpan`: how many game metres the long side stands for), applied to
 * the pose's translation, so it can be turned live without touching the
 * tracker.
 *
 * Coordinates: the tracker works at `procWidth` pixels wide (640 at most —
 * the features do not get better with more, only slower) on a downscaled
 * copy of the frame, and everything it returns is in those pixels. The
 * display canvases are the source's native size.
 *
 * Events: `status` (text, kind), `state` (this), `video` (width, height),
 * `reference` (features), `result`.
 */

const PROC_WIDTH = 640;
/** Horizontal field of view assumed until the rectangle has said otherwise. */
const DEFAULT_HFOV = 66;
/** Perspective across the frame below which the focal estimate is noise. */
const MIN_TILT = 0.2;
/** Blend rate of new focal estimates; slow, so it never visibly breathes. */
const FOCAL_EMA = 0.04;

/** Plane frame → world frame: world.x = plane.x, world.y = -plane.z, world.z = plane.y. */
const PLANE_TO_WORLD = new Matrix3().set(1, 0, 0, 0, 0, -1, 0, 1, 0);
/** Pinhole camera (x right, y down, z forward) → three camera (y up, z back). */
const PINHOLE_TO_THREE = new Matrix3().set(1, 0, 0, 0, -1, 0, 0, 0, -1);

const _R = new Matrix3();
const _M = new Matrix3();
const _M4 = new Matrix4();
const _t = new Vector3();

/**
 * Turn a pinhole pose [R | t] (plane → camera, plane units) into a three.js
 * camera placement in world space, with the plane's long side spanning
 * `span` world units. Pure, so it can be tested without a browser.
 */
export function poseToCamera(R, t, span, outPosition, outQuaternion) {
  // Rᵀ (camera → plane rotation), then world = A · Rᵀ · D · three-camera.
  _R.set(R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]);
  _M.copy(PLANE_TO_WORLD).multiply(_R).multiply(PINHOLE_TO_THREE);
  const e = _M.elements; // column-major
  _M4.set(e[0], e[3], e[6], 0, e[1], e[4], e[7], 0, e[2], e[5], e[8], 0, 0, 0, 0, 1);
  outQuaternion.setFromRotationMatrix(_M4);

  // Camera centre in plane coordinates is -Rᵀ t; then into world, then scaled.
  _t.set(-(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]), -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]), -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2]));
  outPosition.set(_t.x, -_t.z, _t.y).multiplyScalar(span);
  return outPosition;
}

export class ARSession extends EventEmitter {
  constructor() {
    super();

    this.video = document.createElement('video');
    this.video.autoplay = true;
    this.video.muted = true;
    this.video.playsInline = true;
    this.stream = null;

    /** The frame under the scene, and the one on its way to the tracker. */
    this.display = document.createElement('canvas');
    this.pending = document.createElement('canvas');
    this.proc = document.createElement('canvas');
    this._displayCtx = this.display.getContext('2d');
    this._pendingCtx = this.pending.getContext('2d');
    this._procCtx = this.proc.getContext('2d', { willReadFrequently: true });

    this.texture = new CanvasTexture(this.display);
    this.texture.colorSpace = NoColorSpace;
    this.texture.minFilter = LinearFilter;
    this.texture.magFilter = LinearFilter;
    this.texture.generateMipmaps = false;

    this.videoWidth = 0;
    this.videoHeight = 0;
    this.procWidth = 0;
    this.procHeight = 0;
    /** Share of the frame that fits the viewport under a cover fit. */
    this.videoScale = new Vector2(1, 1);

    this.worker = null;
    this._inFlight = false;
    this._frameId = 0;
    this._buffer = null;
    this._frameHandle = 0;
    this._rafHandle = 0;

    this.frozen = false;
    this.tracking = false;
    this.lost = false;
    this.locked = false;
    /** The tracked quad in display pixels, for the overlay. */
    this.quad = new Float64Array(8);
    this.inliers = 0;
    this.total = 0;
    this.trackMs = 0;
    this.fps = 0;
    this._fpsCount = 0;
    this._fpsTime = 0;

    /** Plane → reference-image homography, in tracker pixels. */
    this._Href = null;
    this._G = new Float64Array(9);
    this._pose = { R: new Float64Array(9), t: new Float64Array(3) };
    this._hasPose = false;

    /** Long side over short side of the rectangle. */
    this.aspect = 297 / 210;
    /** World units the rectangle's long side stands for. */
    this.stageSpan = 12;
    /** Focal length, tracker pixels. Estimated unless `manualHfov` is set. */
    this.focal = 0;
    this.manualHfov = 0;
    this._focalSamples = 0;

    this.position = new Vector3();
    this.quaternion = new Quaternion();
    this.vfov = 50;

    this._pump = this._pump.bind(this);
    this._onLoaded = this._onLoaded.bind(this);
    this.video.addEventListener('loadedmetadata', this._onLoaded);
    this.video.addEventListener('resize', this._onLoaded);
  }

  /* ------------------------------------------------------------------ */
  /* Source                                                              */
  /* ------------------------------------------------------------------ */

  /** Feed frames from `stream`. A live lock is dropped: a new camera is a new plane. */
  async attach(stream) {
    if (this.stream === stream) return;
    this.unlock();
    this.frozen = false;
    this.stream = stream;
    this.video.srcObject = stream;
    try {
      await this.video.play();
    } catch {
      /* autoplay refused until a gesture; the pump waits on metadata anyway */
    }
    this._startPump();
  }

  detach() {
    this._stopPump();
    this.unlock();
    this.frozen = false;
    this.stream = null;
    this.video.srcObject = null;
    this.videoWidth = 0;
    this.videoHeight = 0;
    this.emit('video', 0, 0);
  }

  get attached() {
    return !!this.stream;
  }

  _onLoaded() {
    const w = this.video.videoWidth;
    const h = this.video.videoHeight;
    if (!w || !h || (w === this.videoWidth && h === this.videoHeight)) return;
    this.videoWidth = w;
    this.videoHeight = h;
    this.display.width = w;
    this.display.height = h;
    this.pending.width = w;
    this.pending.height = h;
    this.procWidth = Math.min(PROC_WIDTH, w);
    this.procHeight = Math.round((h * this.procWidth) / w);
    this.proc.width = this.procWidth;
    this.proc.height = this.procHeight;
    this._buffer = null;
    this.texture.needsUpdate = true;
    // A source of another size is another camera; the calibration goes with it.
    this.unlock();
    this.focal = 0;
    this._focalSamples = 0;
    this.emit('video', w, h);
  }

  _startPump() {
    this._stopPump();
    this._schedule();
  }

  _stopPump() {
    if (this._frameHandle && this.video.cancelVideoFrameCallback) this.video.cancelVideoFrameCallback(this._frameHandle);
    if (this._rafHandle) cancelAnimationFrame(this._rafHandle);
    this._frameHandle = 0;
    this._rafHandle = 0;
  }

  _schedule() {
    if (!this.stream) return;
    if (this.video.requestVideoFrameCallback) this._frameHandle = this.video.requestVideoFrameCallback(this._pump);
    else this._rafHandle = requestAnimationFrame(this._pump);
  }

  /** One camera frame. */
  _pump() {
    this._schedule();
    if (!this.videoWidth || this.frozen) return;

    if (!this.locked || this.lost) {
      // Nothing to wait for: the live frame goes straight under the scene.
      this._displayCtx.drawImage(this.video, 0, 0);
      this.texture.needsUpdate = true;
    }
    if (!this.locked || this._inFlight) return;

    // Hold the frame the tracker will answer for, and hand it a small copy.
    this._pendingCtx.drawImage(this.video, 0, 0);
    this._procCtx.drawImage(this.pending, 0, 0, this.procWidth, this.procHeight);
    const rgba = this._grab();
    this._inFlight = true;
    this._frameId++;
    this.worker.postMessage({ type: 'frame', id: this._frameId, width: this.procWidth, height: this.procHeight, rgba: rgba.buffer }, [rgba.buffer]);
  }

  /** RGBA of the tracker-sized canvas. */
  _grab() {
    return this._procCtx.getImageData(0, 0, this.procWidth, this.procHeight).data;
  }

  /* ------------------------------------------------------------------ */
  /* The plane                                                           */
  /* ------------------------------------------------------------------ */

  /** Hold the frame so the corners can be placed on something that stands still. */
  freeze() {
    if (!this.videoWidth) return false;
    this.unlock();
    this._displayCtx.drawImage(this.video, 0, 0);
    this.texture.needsUpdate = true;
    this.frozen = true;
    this.emit('state', this);
    return true;
  }

  unfreeze() {
    this.frozen = false;
    this.emit('state', this);
  }

  /**
   * Adopt the frozen frame as the reference and `quad` (display pixels, any
   * order) as the rectangle. Tracking starts on the next frame.
   *
   * @param {ArrayLike<number>} quad 8 numbers
   * @param {number} aspect long side / short side
   */
  lock(quad, aspect) {
    if (!this.videoWidth) return false;
    this._ensureWorker();
    this.aspect = Math.max(1, aspect || 1);

    // The reference is the display frame — frozen or the newest — at tracker size.
    if (!this.frozen) this._displayCtx.drawImage(this.video, 0, 0);
    this._procCtx.drawImage(this.display, 0, 0, this.procWidth, this.procHeight);
    const rgba = this._grab();

    const scale = this.procWidth / this.videoWidth;
    const small = new Float64Array(8);
    for (let i = 0; i < 8; i++) small[i] = quad[i] * scale;
    const ordered = orderQuad(small);

    // Plane coordinates: the long side (as clicked) is X of length 1 — the
    // stage span is applied later — and Y runs the short side. Which pair of
    // edges is the long one is read off the frozen frame; the aspect says
    // how much longer it is.
    const e01 = Math.hypot(ordered[2] - ordered[0], ordered[3] - ordered[1]) + Math.hypot(ordered[6] - ordered[4], ordered[7] - ordered[5]);
    const e12 = Math.hypot(ordered[4] - ordered[2], ordered[5] - ordered[3]) + Math.hypot(ordered[0] - ordered[6], ordered[1] - ordered[7]);
    const a = 0.5;
    const b = 0.5 / this.aspect;
    const metric = e01 >= e12
      ? new Float64Array([-a, -b, a, -b, a, b, -a, b])
      : new Float64Array([-b, -a, b, -a, b, a, -b, a]);
    this._Href = fitHomography(metric, ordered, null, 4, new Float64Array(9));
    if (!this._Href) return false;

    for (let i = 0; i < 8; i++) this.quad[i] = quad[i];
    this.locked = true;
    this.tracking = false;
    this.lost = false;
    this.frozen = false;
    this._hasPose = false;
    this._inFlight = true;
    this.worker.postMessage({ type: 'reference', width: this.procWidth, height: this.procHeight, rgba: rgba.buffer, quad: Array.from(ordered) }, [rgba.buffer]);
    this._status('Locking on…', 'info');
    this.emit('state', this);
    return true;
  }

  /**
   * Lock on a reference the phone took itself: its frozen frame, as an
   * image, and the corners it placed on it as fractions of that frame. Exact
   * by construction — the reference is the very picture the corners were
   * placed on, not whatever arrived here a few frames later — and immune to
   * the encoder scaling the stream on the way over, since fractions are
   * fractions at any size.
   *
   * @param {string} image  a data URL (JPEG) of the frozen frame
   * @param {ArrayLike<number>} corners 8 numbers in 0..1
   * @param {number} aspect long side / short side
   */
  async lockFromImage(image, corners, aspect) {
    if (!this.videoWidth) return false;
    let bitmap;
    try {
      const blob = await (await fetch(image)).blob();
      bitmap = await createImageBitmap(blob);
    } catch (error) {
      console.warn('[ar] could not decode the reference frame from the phone', error);
      return false;
    }
    this._displayCtx.drawImage(bitmap, 0, 0, this.videoWidth, this.videoHeight);
    bitmap.close?.();
    this.texture.needsUpdate = true;
    this.frozen = true;
    const quad = new Float64Array(8);
    for (let i = 0; i < 4; i++) {
      quad[2 * i] = corners[2 * i] * this.videoWidth;
      quad[2 * i + 1] = corners[2 * i + 1] * this.videoHeight;
    }
    return this.lock(quad, aspect);
  }

  /** Back to a live, untracked view. The plane is forgotten. */
  unlock() {
    if (!this.locked) return;
    this.locked = false;
    this.tracking = false;
    this.lost = false;
    this._hasPose = false;
    this._inFlight = false;
    this.worker?.postMessage({ type: 'reset' });
    this.emit('state', this);
  }

  _ensureWorker() {
    if (this.worker) return;
    this.worker = new Worker(new URL('./tracker.worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event) => this._onResult(event.data);
    this.worker.onerror = (event) => {
      console.error('[ar] tracker worker failed', event.message ?? event);
      this._status('The tracker crashed — see the console', 'error');
      this._inFlight = false;
    };
  }

  _onResult(message) {
    if (message.type === 'reference') {
      this._inFlight = false;
      this.total = message.features;
      this.emit('reference', message.features);
      if (message.features < 20) {
        this._status(`Only ${message.features} points to track — pick something with more print on it`, 'warn');
      }
      return;
    }
    if (message.type !== 'result') return;
    this._inFlight = false;
    if (!this.locked) return;

    this.trackMs = message.ms;
    this._fpsCount++;
    const now = performance.now();
    if (now - this._fpsTime > 1000) {
      this.fps = Math.round((this._fpsCount * 1000) / (now - this._fpsTime));
      this._fpsCount = 0;
      this._fpsTime = now;
    }

    const wasTracking = this.tracking;
    this.inliers = message.inliers;
    this.total = message.total;
    if (!message.ok) {
      this.tracking = false;
      this.lost = true;
      if (wasTracking) this._status('Lost the rectangle — bring it back into view', 'warn');
      this.emit('result', message);
      this.emit('state', this);
      return;
    }

    // The picture the pose belongs to goes under the scene now.
    this._displayCtx.drawImage(this.pending, 0, 0);
    this.texture.needsUpdate = true;

    const scale = this.videoWidth / this.procWidth;
    for (let i = 0; i < 8; i++) this.quad[i] = message.quad[i] * scale;
    this._solvePose(message.H);

    this.tracking = true;
    this.lost = false;
    if (!wasTracking) this._status('Tracking', 'live');
    this.emit('result', message);
    this.emit('state', this);
  }

  /* ------------------------------------------------------------------ */
  /* Pose                                                                */
  /* ------------------------------------------------------------------ */

  /** Field of view the panel shows, degrees across the frame's width. */
  get hfov() {
    if (!this.focal || !this.procWidth) return 0;
    return (2 * Math.atan(this.procWidth / (2 * this.focal)) * 180) / Math.PI;
  }

  /** Whether the focal length is being measured rather than dialled in. */
  get autoFocal() {
    return !this.manualHfov;
  }

  /** @param {number} hfov degrees, or 0 to go back to measuring it */
  setManualHfov(hfov) {
    this.manualHfov = hfov > 0 ? hfov : 0;
    if (this.manualHfov) this.focal = this.procWidth / (2 * Math.tan((this.manualHfov * Math.PI) / 360));
    else this._focalSamples = 0;
  }

  _solvePose(H) {
    // Plane → current image.
    mulH(H, this._Href, this._G);
    const cx = this.procWidth / 2;
    const cy = this.procHeight / 2;

    if (this.manualHfov) {
      this.focal = this.procWidth / (2 * Math.tan((this.manualHfov * Math.PI) / 360));
    } else {
      const { f, tilt } = estimateFocal(this._G, cx, cy);
      const sane = Number.isFinite(f) && f > 0.4 * this.procWidth && f < 4 * this.procWidth;
      if (sane && tilt > MIN_TILT) {
        // The first good look sets it; every one after nudges it.
        this.focal = this._focalSamples === 0 ? f : this.focal + (f - this.focal) * FOCAL_EMA;
        this._focalSamples++;
      } else if (!this.focal) {
        this.focal = this.procWidth / (2 * Math.tan((DEFAULT_HFOV * Math.PI) / 360));
      }
    }

    poseFromHomography(this._G, this.focal, cx, cy, this._pose);
    poseToCamera(this._pose.R, this._pose.t, this.stageSpan, this.position, this.quaternion);
    this._hasPose = true;
  }

  /**
   * Fit the frame to the viewport (cover) and derive the projection that
   * matches the crop. Call once per render frame, before `applyCamera`.
   */
  fitViewport(width, height) {
    if (!this.videoWidth) return;
    const s = Math.max(width / this.videoWidth, height / this.videoHeight);
    this.videoScale.set(width / (s * this.videoWidth), height / (s * this.videoHeight));
    if (this.focal) {
      const visibleHeight = this.videoScale.y * this.procHeight;
      this.vfov = (2 * Math.atan(visibleHeight / (2 * this.focal)) * 180) / Math.PI;
    }
  }

  /** Whether there is a pose to draw the stage with. */
  get hasPose() {
    return this._hasPose;
  }

  /** Write the tracked pose and the matching projection into `camera`. */
  applyCamera(camera, width, height) {
    if (!this._hasPose) return false;
    camera.position.copy(this.position);
    camera.quaternion.copy(this.quaternion);
    camera.fov = this.vfov;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    return true;
  }

  /**
   * A point on the frame, as a normalised (0..1) video coordinate, to NDC on
   * the viewport under the same cover fit the frame is drawn with.
   */
  frameToNdc(u, v, out) {
    out.x = ((u - 0.5) / this.videoScale.x) * 2;
    out.y = ((0.5 - v) / this.videoScale.y) * 2;
    return out;
  }

  /** Viewport pixel → display-frame pixel, inverse of the cover fit. */
  screenToFrame(x, y, width, height, out) {
    const u = 0.5 + (x / width - 0.5) * this.videoScale.x;
    const v = 0.5 + (y / height - 0.5) * this.videoScale.y;
    out.x = u * this.videoWidth;
    out.y = v * this.videoHeight;
    return out;
  }

  /** Display-frame pixel → viewport pixel. */
  frameToScreen(x, y, width, height, out) {
    out.x = (0.5 + (x / this.videoWidth - 0.5) / this.videoScale.x) * width;
    out.y = (0.5 + (y / this.videoHeight - 0.5) / this.videoScale.y) * height;
    return out;
  }

  /**
   * Project a world-space ground point back onto the display frame — the
   * overlay uses this to draw the stage's footprint while tracking.
   */
  worldToFrame(x, z, out) {
    if (!this._hasPose) return null;
    const w = projectH(this._G, x / this.stageSpan, z / this.stageSpan, out);
    if (w <= 0) return null;
    const scale = this.videoWidth / this.procWidth;
    out[0] *= scale;
    out[1] *= scale;
    return out;
  }

  _status(text, kind) {
    this.emit('status', text, kind);
  }

  dispose() {
    this.detach();
    this.worker?.terminate();
    this.worker = null;
    this.texture.dispose();
    this.video.removeEventListener('loadedmetadata', this._onLoaded);
    this.video.removeEventListener('resize', this._onLoaded);
    this.clear();
  }
}
