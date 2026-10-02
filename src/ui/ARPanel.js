import { PHONE_PAIRING_MARKUP, PhonePairing } from './PhonePairing.js';
import { makeDraggable } from './draggable.js';

/**
 * The AR mode's panel: a camera view with the stage's rectangle placed *in
 * it*, and the dials.
 *
 * The top of the panel is the camera looking at the table — the session's
 * frame, live or frozen — and the placement happens on that picture: four
 * handles on the corners of a quad, dragged onto a printed rectangle, with
 * a loupe beside the handle being dragged because a corner a pixel off on a
 * 640-wide frame is a degree of tilt on the stage. The panel widens while
 * placing so the picture is worth dragging on. Once locked the same frame
 * shows the tracked outline.
 *
 * With the phone as the camera the placement is done on the phone itself
 * (its page has the same handles, thumb-sized), and this frame mirrors the
 * phone's corners as they move; the handles here still work, for whoever
 * prefers the mouse. Below the picture: the camera choice, the rectangle's
 * shape, the stage's size, the lens, and where the hands come from.
 *
 * The panel decides nothing: every control fires a callback and `App` does
 * the work, then feeds the session state back through `update`.
 */

/** Rectangle shapes to pick from, as long side over short side. */
const SHAPES = [
  { id: 'a4', label: 'A4 / A3 sheet (297 × 210)', aspect: 297 / 210 },
  { id: 'letter', label: 'US Letter (11 × 8.5 in)', aspect: 11 / 8.5 },
  { id: 'square', label: 'Square', aspect: 1 },
  { id: 'wide', label: '16 : 9 (a screen, a mousepad)', aspect: 16 / 9 },
  { id: 'custom', label: 'Custom…', aspect: 0 }
];

const MARKUP = `
  <div class="hud__ar" data-ar>
    <div class="ar__head">
      <span class="ar__title">AR · anchor the stage to a real surface</span>
      <kbd>N</kbd>
    </div>

    <div class="ar__frame" data-ar-frame>
      <div class="ar__frame-slot" data-ar-slot></div>
      <svg class="ar__frame-svg" data-ar-svg preserveAspectRatio="none">
        <polygon class="ar__quad" data-ar-poly points=""></polygon>
        <polygon class="ar__quad ar__quad--remote" data-ar-remote points=""></polygon>
        <polygon class="ar__quad ar__quad--track" data-ar-trackpoly points=""></polygon>
      </svg>
      <div class="ar-handle" data-ar-handle="0" hidden></div>
      <div class="ar-handle" data-ar-handle="1" hidden></div>
      <div class="ar-handle" data-ar-handle="2" hidden></div>
      <div class="ar-handle" data-ar-handle="3" hidden></div>
      <div class="ar__frame-badge" data-ar-badge>No camera yet</div>
    </div>

    <div class="ar__section">
      <div class="ar__label">Camera looking at the table</div>
      <div class="ar__row">
        <button type="button" class="camera__btn" data-ar-phone><span class="camera__btn-icon" aria-hidden="true">📱</span><span data-ar-phone-label>Phone</span></button>
        <button type="button" class="camera__btn" data-ar-webcam><span class="camera__btn-icon" aria-hidden="true">🎥</span><span>Webcam</span></button>
      </div>
      ${PHONE_PAIRING_MARKUP}
      <div class="ar__status" data-ar-status></div>
    </div>

    <div class="ar__section">
      <div class="ar__label">The rectangle</div>
      <div class="ar__row">
        <select class="ar__select" data-ar-shape>
          ${SHAPES.map((s) => `<option value="${s.id}">${s.label}</option>`).join('')}
        </select>
      </div>
      <div class="ar__row ar__custom" data-ar-custom hidden>
        <input class="ar__input" type="number" min="1" step="0.1" value="30" data-ar-w aria-label="width"> ×
        <input class="ar__input" type="number" min="1" step="0.1" value="20" data-ar-h aria-label="height">
        <span class="ar__dim">any unit — only the ratio counts</span>
      </div>
      <div class="ar__row">
        <button type="button" class="camera__btn" data-ar-freeze disabled>❄ Freeze &amp; place corners</button>
        <button type="button" class="camera__btn ar__lock" data-ar-lock disabled>Lock the stage</button>
        <button type="button" class="camera__btn camera__btn--quiet" data-ar-unlock hidden>Unlock</button>
      </div>
      <div class="ar__hint" data-ar-place-hint>
        Aim at something printed — a page of text, a book cover, a mat. Blank paper has
        nothing to track. <button type="button" class="ar__link" data-ar-mat>Print a tracking mat</button>
      </div>
      <div class="ar__hint" data-ar-phone-hint hidden>
        With the phone, place the stage <b>on the phone</b>: freeze, drag the corners, tap
        <b>Place the stage</b>. Its screen then shows the stage over its camera. The handles
        above work too.
      </div>
    </div>

    <div class="ar__section">
      <div class="ar__label">The stage</div>
      <label class="ar__slider">
        <span>Size</span>
        <input type="range" min="4" max="60" step="0.5" value="12" data-ar-span>
        <b data-ar-span-out>12 m</b>
      </label>
      <label class="ar__slider">
        <span>Lens</span>
        <input type="range" min="30" max="120" step="0.5" value="66" data-ar-fov>
        <b data-ar-fov-out>auto</b>
      </label>
      <label class="ar__check"><input type="checkbox" data-ar-fov-auto checked> measure the field of view from the rectangle</label>
      <div class="ar__row ar__hands">
        <span class="ar__dim">Hands from</span>
        <button type="button" class="camera__btn camera__btn--small" data-ar-hands-ar>this camera</button>
        <button type="button" class="camera__btn camera__btn--small" data-ar-hands-cam>the webcam</button>
      </div>
      <div class="ar__hint">Press <kbd>M</kbd> for the hands. On this camera, reach over the table: the arrow sits under your hand. Roles backwards? <kbd>J</kbd> swaps them.</div>
      <label class="ar__check"><input type="checkbox" data-ar-outline checked> draw the tracked outline</label>
    </div>

    <div class="ar__track" data-ar-track></div>
  </div>

  <canvas class="ar-loupe" data-ar-loupe width="180" height="180" hidden></canvas>
`;

export { MARKUP as AR_MARKUP };

/** Loupe: pixels of the frame shown, and the zoom. */
const LOUPE_SOURCE = 60;
const LOUPE_SIZE = 180;

export class ARPanel {
  constructor(root) {
    this.element = root.querySelector('[data-ar]');
    const $ = (sel) => this.element.querySelector(sel);
    this.frame = $('[data-ar-frame]');
    this.slot = $('[data-ar-slot]');
    this.svg = $('[data-ar-svg]');
    this.poly = $('[data-ar-poly]');
    this.remotePoly = $('[data-ar-remote]');
    this.trackPoly = $('[data-ar-trackpoly]');
    this.handles = Array.from(this.element.querySelectorAll('[data-ar-handle]'));
    this.badge = $('[data-ar-badge]');
    this.phoneButton = $('[data-ar-phone]');
    this.phoneLabel = $('[data-ar-phone-label]');
    this.webcamButton = $('[data-ar-webcam]');
    this.status = $('[data-ar-status]');
    this.shape = $('[data-ar-shape]');
    this.custom = $('[data-ar-custom]');
    this.customW = $('[data-ar-w]');
    this.customH = $('[data-ar-h]');
    this.freezeButton = $('[data-ar-freeze]');
    this.lockButton = $('[data-ar-lock]');
    this.unlockButton = $('[data-ar-unlock]');
    this.matButton = $('[data-ar-mat]');
    this.placeHint = $('[data-ar-place-hint]');
    this.phoneHint = $('[data-ar-phone-hint]');
    this.span = $('[data-ar-span]');
    this.spanOut = $('[data-ar-span-out]');
    this.fov = $('[data-ar-fov]');
    this.fovOut = $('[data-ar-fov-out]');
    this.fovAuto = $('[data-ar-fov-auto]');
    this.handsAr = $('[data-ar-hands-ar]');
    this.handsCam = $('[data-ar-hands-cam]');
    this.outline = $('[data-ar-outline]');
    this.track = $('[data-ar-track]');
    this.loupe = root.querySelector('[data-ar-loupe]');
    this.loupeCtx = this.loupe.getContext('2d');

    this.phone = new PhonePairing(this.element);

    /** Callbacks, wired by App. */
    this.onSource = null;
    this.onFreeze = null;
    this.onLock = null;
    this.onUnlock = null;
    this.onSpan = null;
    this.onFov = null;
    this.onHands = null;
    this.onOutline = null;
    this.onPrintMat = null;

    /** Corners being placed, in frame pixels. */
    this.corners = null;
    this.placing = false;
    this._session = null;
    this._drag = null;
    this._statusShown = '';
    this._trackShown = '';
    this._frameShown = '';
    this._source = '';
    this._hands = 'ar';
    this.visible = false;

    this._bind();
    this._undrag = makeDraggable(this.element);
  }

  _bind() {
    this.phoneButton.addEventListener('click', () => this.onSource?.('phone'));
    this.webcamButton.addEventListener('click', () => this.onSource?.('webcam'));
    this.freezeButton.addEventListener('click', () => this.onFreeze?.());
    this.lockButton.addEventListener('click', () => {
      if (!this.corners) return;
      this.onLock?.(Float64Array.from(this.corners), this.aspect);
    });
    this.unlockButton.addEventListener('click', () => this.onUnlock?.());
    this.matButton.addEventListener('click', () => this.onPrintMat?.());
    this.shape.addEventListener('change', () => {
      this.custom.hidden = this.shape.value !== 'custom';
    });
    this.span.addEventListener('input', () => {
      this.spanOut.textContent = `${Number(this.span.value).toFixed(1).replace(/\.0$/, '')} m`;
      this.onSpan?.(Number(this.span.value));
    });
    const fovChanged = () => {
      const manual = !this.fovAuto.checked;
      this.fov.disabled = !manual;
      this.onFov?.(manual ? Number(this.fov.value) : 0);
    };
    this.fov.addEventListener('input', fovChanged);
    this.fovAuto.addEventListener('change', fovChanged);
    this.fov.disabled = true;
    this.handsAr.addEventListener('click', () => this.onHands?.('ar'));
    this.handsCam.addEventListener('click', () => this.onHands?.('webcam'));
    this.outline.addEventListener('change', () => this.onOutline?.(this.outline.checked));

    // Corner handles. The panel is draggable; a press on a handle is not a
    // drag of the panel, so it stops there.
    for (const handle of this.handles) {
      handle.addEventListener('pointerdown', (event) => {
        event.stopPropagation();
        if (!this.placing || event.button !== 0) return;
        event.preventDefault();
        this._drag = { index: Number(handle.dataset.arHandle), pointer: event.pointerId };
        handle.setPointerCapture(event.pointerId);
        handle.classList.add('is-dragging');
        this._moveHandle(event);
      });
      handle.addEventListener('pointermove', (event) => {
        if (!this._drag || event.pointerId !== this._drag.pointer) return;
        event.stopPropagation();
        this._moveHandle(event);
      });
      const release = (event) => {
        if (!this._drag || event.pointerId !== this._drag.pointer) return;
        event.stopPropagation();
        handle.classList.remove('is-dragging');
        this._drag = null;
        this.loupe.hidden = true;
      };
      handle.addEventListener('pointerup', release);
      handle.addEventListener('pointercancel', release);
    }
    // A click on the picture sends the nearest corner there.
    this.frame.addEventListener('pointerdown', (event) => {
      if (!this.placing || event.button !== 0 || event.target.closest('.ar-handle')) return;
      event.stopPropagation();
      const p = this._toFrame(event.clientX, event.clientY);
      if (!p) return;
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < 4; i++) {
        const d = Math.hypot(this.corners[2 * i] - p.x, this.corners[2 * i + 1] - p.y);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      this.corners[2 * best] = p.x;
      this.corners[2 * best + 1] = p.y;
      this._layout();
    });
  }

  /* ------------------------------------------------------------------ */
  /* Panel state                                                         */
  /* ------------------------------------------------------------------ */

  get aspect() {
    const shape = SHAPES.find((s) => s.id === this.shape.value) ?? SHAPES[0];
    if (shape.id !== 'custom') return shape.aspect;
    const w = Number(this.customW.value) || 1;
    const h = Number(this.customH.value) || 1;
    return Math.max(w, h) / Math.min(w, h);
  }

  /** Reflect a ratio the phone chose. */
  setAspect(aspect) {
    const match = SHAPES.find((s) => s.id !== 'custom' && Math.abs(s.aspect - aspect) < 0.01);
    if (match) {
      this.shape.value = match.id;
      this.custom.hidden = true;
      return;
    }
    this.shape.value = 'custom';
    this.custom.hidden = false;
    this.customW.value = aspect.toFixed(3);
    this.customH.value = '1';
  }

  setVisible(on) {
    this.visible = on;
    this.element.classList.toggle('is-visible', on);
    if (!on) this.endPlacement();
  }

  /** Which camera is feeding the session: 'phone' | 'webcam' | ''. */
  setSource(kind, { phoneLive = false } = {}) {
    this._source = kind;
    this.phoneButton.classList.toggle('is-live', kind === 'phone');
    this.webcamButton.classList.toggle('is-live', kind === 'webcam');
    this.phoneLabel.textContent = phoneLive ? 'Phone · live' : 'Phone';
    // Freezing needs a picture to freeze.
    this.freezeButton.disabled = !kind;
    this.phoneHint.hidden = kind !== 'phone';
    this.placeHint.hidden = kind === 'phone';
    if (kind !== 'phone') this.setRemoteCorners(null);
  }

  setHands(kind) {
    this._hands = kind;
    this.handsAr.classList.toggle('is-live', kind === 'ar');
    this.handsCam.classList.toggle('is-live', kind === 'webcam');
  }

  /** @param {'info'|'warn'|'error'|'live'} [kind] */
  setStatus(text, kind = 'info') {
    if (text === this._statusShown && this.status.dataset.kind === kind) return;
    this._statusShown = text;
    this.status.textContent = text;
    this.status.dataset.kind = kind;
  }

  /* ------------------------------------------------------------------ */
  /* The picture                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Put the session's frame in the slot — the very canvas the stage is
   * composited over, so what is placed on here is placed on that — and
   * shape the frame to it.
   */
  _adopt(session) {
    this._session = session;
    if (session.display.parentElement !== this.slot) this.slot.replaceChildren(session.display);
    const w = session.videoWidth || 4;
    const h = session.videoHeight || 3;
    const key = `${w}x${h}`;
    if (key !== this._frameShown) {
      this._frameShown = key;
      this.frame.style.aspectRatio = `${w} / ${h}`;
      this.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    }
    this.badge.hidden = !!session.videoWidth;
    this.frame.classList.toggle('has-picture', !!session.videoWidth);
  }

  /* ------------------------------------------------------------------ */
  /* Placement                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Show the handles on the frozen frame. The quad starts where it was last
   * placed, or as a rectangle over the middle of the frame.
   */
  beginPlacement(session) {
    this._adopt(session);
    if (!session.videoWidth) return;
    if (!this.corners || !this._cornersFit(session)) {
      const w = session.videoWidth;
      const h = session.videoHeight;
      const rw = w * 0.6;
      const rh = Math.min(h * 0.7, rw / this.aspect);
      this.corners = new Float64Array([
        w / 2 - rw / 2, h / 2 - rh / 2,
        w / 2 + rw / 2, h / 2 - rh / 2,
        w / 2 + rw / 2, h / 2 + rh / 2,
        w / 2 - rw / 2, h / 2 + rh / 2
      ]);
    }
    this.placing = true;
    this.element.classList.add('is-placing');
    for (const handle of this.handles) handle.hidden = false;
    this.lockButton.disabled = false;
    this.freezeButton.textContent = '↻ Freeze again';
    this.unlockButton.hidden = true;
    this._layout();
  }

  endPlacement() {
    this.placing = false;
    this._drag = null;
    this.loupe.hidden = true;
    this.element.classList.remove('is-placing');
    for (const handle of this.handles) handle.hidden = true;
    this.poly.setAttribute('points', '');
    // Locking wants corners placed on the frame that is *now* frozen; after
    // an unlock the way back is another freeze.
    this.lockButton.disabled = true;
  }

  /**
   * The phone's handles, as it drags them (fractions of its frame), drawn
   * here so the big screen can be glanced at. Null clears them.
   */
  setRemoteCorners(corners) {
    if (!corners || !this._session?.videoWidth) {
      this.remotePoly.setAttribute('points', '');
      return;
    }
    const w = this._session.videoWidth;
    const h = this._session.videoHeight;
    const points = [];
    for (let i = 0; i < 4; i++) points.push(`${(corners[2 * i] * w).toFixed(1)},${(corners[2 * i + 1] * h).toFixed(1)}`);
    this.remotePoly.setAttribute('points', points.join(' '));
  }

  _cornersFit(session) {
    for (let i = 0; i < 4; i++) {
      if (this.corners[2 * i] < 0 || this.corners[2 * i] > session.videoWidth) return false;
      if (this.corners[2 * i + 1] < 0 || this.corners[2 * i + 1] > session.videoHeight) return false;
    }
    return true;
  }

  /** Pointer → frame pixels, through the picture's box. */
  _toFrame(clientX, clientY) {
    const session = this._session;
    if (!session?.videoWidth) return null;
    const rect = this.frame.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: Math.max(0, Math.min(session.videoWidth, ((clientX - rect.left) / rect.width) * session.videoWidth)),
      y: Math.max(0, Math.min(session.videoHeight, ((clientY - rect.top) / rect.height) * session.videoHeight))
    };
  }

  _moveHandle(event) {
    const p = this._toFrame(event.clientX, event.clientY);
    if (!p || !this._drag) return;
    const i = this._drag.index;
    this.corners[2 * i] = p.x;
    this.corners[2 * i + 1] = p.y;
    this._layout();
    this._drawLoupe(p.x, p.y, event.clientX, event.clientY);
  }

  _drawLoupe(fx, fy, clientX, clientY) {
    const session = this._session;
    const ctx = this.loupeCtx;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);
    // The same span of the picture whatever its size, so the zoom is the zoom.
    const source = Math.max(LOUPE_SOURCE, session.videoWidth / 16);
    ctx.drawImage(session.display, fx - source / 2, fy - source / 2, source, source, 0, 0, LOUPE_SIZE, LOUPE_SIZE);
    ctx.strokeStyle = 'rgba(127, 214, 255, 0.9)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(LOUPE_SIZE / 2, 0);
    ctx.lineTo(LOUPE_SIZE / 2, LOUPE_SIZE);
    ctx.moveTo(0, LOUPE_SIZE / 2);
    ctx.lineTo(LOUPE_SIZE, LOUPE_SIZE / 2);
    ctx.stroke();
    // Beside the pointer, flipped when that runs off screen.
    let x = clientX - LOUPE_SIZE - 24;
    let y = clientY - LOUPE_SIZE / 2;
    if (x < 0) x = clientX + 24;
    y = Math.max(8, Math.min(window.innerHeight - LOUPE_SIZE - 8, y));
    this.loupe.style.left = `${x}px`;
    this.loupe.style.top = `${y}px`;
    this.loupe.hidden = false;
  }

  /** Handles at their corners, as fractions of the picture; the quad in frame pixels. */
  _layout() {
    if (!this.placing || !this._session?.videoWidth || !this.corners) return;
    const w = this._session.videoWidth;
    const h = this._session.videoHeight;
    const points = [];
    for (let i = 0; i < 4; i++) {
      const handle = this.handles[i];
      handle.style.left = `${(this.corners[2 * i] / w) * 100}%`;
      handle.style.top = `${(this.corners[2 * i + 1] / h) * 100}%`;
      points.push(`${this.corners[2 * i].toFixed(1)},${this.corners[2 * i + 1].toFixed(1)}`);
    }
    this.poly.setAttribute('points', points.join(' '));
  }

  /* ------------------------------------------------------------------ */
  /* Per frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Reflect the session: the picture, the tracked outline, the readout, the lens.
   * @param {import('../ar/ARSession.js').ARSession} session
   */
  update(session) {
    if (!this.visible) return;
    this._adopt(session);

    // The tracked outline, while locked and asked for.
    if (session.locked && this.outline.checked && session.videoWidth) {
      const points = [];
      for (let i = 0; i < 4; i++) points.push(`${session.quad[2 * i].toFixed(1)},${session.quad[2 * i + 1].toFixed(1)}`);
      this.trackPoly.setAttribute('points', points.join(' '));
      this.trackPoly.classList.toggle('is-lost', !session.tracking);
    } else {
      this.trackPoly.setAttribute('points', '');
    }

    this.unlockButton.hidden = !session.locked;
    this.lockButton.hidden = session.locked;
    if (session.locked) this.freezeButton.textContent = '❄ Freeze & place again';

    if (!this.fovAuto.checked) {
      this.fovOut.textContent = `${Number(this.fov.value).toFixed(0)}°`;
    } else if (session.hfov) {
      this.fovOut.textContent = `auto · ${session.hfov.toFixed(0)}°`;
      this.fov.value = session.hfov.toFixed(1);
    } else {
      this.fovOut.textContent = 'auto';
    }

    let line = '';
    if (session.locked) {
      line = session.tracking
        ? `Tracking · ${session.inliers} of ${session.total} points · ${session.fps} fps · ${session.trackMs.toFixed(0)} ms`
        : session.lost
          ? `Lost · looking for the rectangle… (${session.total} points known)`
          : 'Locking on…';
    } else if (session.frozen) {
      line = 'Frame frozen — place the corners';
    } else if (session.attached) {
      line = 'Live · freeze a frame to place the stage';
    }
    if (line !== this._trackShown) {
      this._trackShown = line;
      this.track.textContent = line;
      this.track.dataset.kind = session.tracking ? 'live' : session.lost ? 'warn' : 'info';
    }
  }

  dispose() {
    this._undrag();
  }
}
