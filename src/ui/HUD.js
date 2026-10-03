import { ELEMENTS, ELEMENT_META } from '../config/settings.js';
import { ELEMENT_SIGILS } from './glyphs.js';
import { CONTACT_MARKUP, ContactCard } from './contact.js';
import { CAMERA_MARKUP, CameraPanel } from './CameraPanel.js';
import { AR_MARKUP, ARPanel } from './ARPanel.js';

/**
 * Heads-up display: the ability bar, controls, live stats and toasts.
 *
 * Plain DOM — no framework. The bar is built from `ELEMENTS`, so a new ability
 * appears in it on its own; the slots are the only interactive part, and they
 * mirror the keyboard shortcuts through `onAbility`.
 *
 * The cooldown sweep is a `conic-gradient` driven by a CSS custom property, so
 * updating it every frame is one `setProperty` call and never touches layout.
 */
export class HUD {
  constructor(root) {
    this.root = root;
    this.onAbility = null;
    this._toastTimer = 0;
    this._statsAccumulator = 0;
    this._frames = 0;
    this._fps = 0;
    /** Last sweep ratio pushed to the DOM, per element. */
    this._cooldownShown = new Map();
    this._armedShown = null;

    root.innerHTML = `
      <div class="hud__panel hud__title">
        Elemental Sandbox
        <span data-blurb>Press K, L, I, O, U, ; or ' (or 1–7), aim, click to cast.</span>
        <button class="hud__switch" type="button" data-castle role="switch" aria-checked="true" title="Castle (\`)">
          <span class="hud__switch-track"><span class="hud__switch-thumb"></span></span>
          <span class="hud__switch-label">Castle</span>
          <kbd>\`</kbd>
        </button>
      </div>

      <div class="hud__panel hud__stats">
        <div>FPS <b data-stat="fps">—</b></div>
        <div>Particles <b data-stat="particles">0</b></div>
        <div>Instances <b data-stat="spikes">0</b></div>
        <div>Draw calls <b data-stat="calls">0</b></div>
      </div>

      <div class="hud__panel hud__help">
        <div><strong>K</strong> — Abyssal Maw &nbsp; <strong>L</strong> — Chains of Penance</div>
        <div><strong>I</strong> — Dragonfire Circle &nbsp; <strong>O</strong> — Stormheart Gyroscope</div>
        <div><strong>U</strong> — Amethyst Verdict &nbsp; <strong>;</strong> — Astral Tome</div>
        <div><strong>'</strong> — Wildroot Reliquary &nbsp; <strong>1</strong>–<strong>7</strong> — the same, by slot</div>
        <div class="hud__help-note">Every cast is a far cast — aimed with a circle.</div>
        <div class="hud__help-note">K, L, U and ' are targeted: the circle locks onto the body under the cursor, and that one is taken.</div>
        <div><strong>Move</strong> — aim &nbsp; <strong>Left click</strong> — cast</div>
        <div><strong>Esc / right click</strong> — cancel the cast</div>
        <div><strong>Right drag</strong> — orbit &nbsp; <strong>Scroll</strong> — zoom</div>
        <div style="margin-top:6px">
          <kbd>G</kbd> editor &nbsp; <kbd>P</kbd> pause &nbsp; <kbd>C</kbd> clear
        </div>
        <div><kbd>T</kbd> reset targets &nbsp; <kbd>H</kbd> hide this</div>
        <div><kbd>M</kbd> camera mode &nbsp; <kbd>J</kbd> swap hands</div>
        <div class="hud__help-note">Camera: palm aims, fist casts, point left/right to swap.</div>
        <div class="hud__help-note">No webcam? The panel can use your phone's camera instead — scan the code (local network only).</div>
        <div><kbd>N</kbd> AR mode &nbsp; <kbd>\`</kbd> castle on / off</div>
        <div class="hud__help-note">AR: point a camera at a printed page, drag the corners onto it, lock — the stage stands on it and follows the camera. The arrow sits under your real hand.</div>
        <div class="hud__help-note">Any cast that reaches a target one-shots it.</div>
        <div class="hud__help-note">The Abyssal Maw kicks its target up on a spike of rock, and a shark leaps out of one portal, takes it, and drags it down into the other.</div>
        <div class="hud__help-note">The Dragonfire Circle summons a dragon that flies the circle breathing fire onto its edge; the fire then runs inward and burns everything standing in it.</div>
        <div class="hud__help-note">The Chains of Penance throw a chain out of a portal at every limb, haul the body up, and tear it apart — each piece dragged back through its own portal.</div>
        <div class="hud__help-note">The Stormheart Gyroscope condenses over its circle, charges its rune, and strikes everyone standing in it with lightning that jumps from body to body — then overloads.</div>
        <div class="hud__help-note">The Amethyst Verdict writes a circle round its target with a socket at every point of a star; an amethyst point rises out of each, turns on the body, and they come in one after another and shatter on it.</div>
        <div class="hud__help-note">The Astral Tome is conjured at your shoulder and flies to the circle, swells, and opens an orrery over it; its planets tear free and fall as lights on everyone standing inside.</div>
        <div class="hud__help-note">The Wildroot Reliquary raises an arch of roots over its target and a ring of runestones in it; tendrils take the body by the wrists and ankles and hang it in the ring, the runes light, and the arch drags it down into the earth — leaving a sapling.</div>
        <div class="hud__help-note">Paused still applies every editor change.</div>
      </div>

      <div class="hud__abilities">
        ${ELEMENTS.map((element) => {
          const meta = ELEMENT_META[element];
          return `
            <div class="ability-card" data-element="${element}" style="--accent:${meta.accent}">
              <div class="ability-card__sweep" data-sweep></div>
              <div class="ability-card__key">${meta.key}</div>
              <div class="ability-card__glyph">${ELEMENT_SIGILS[element] ?? ''}</div>
              <div class="ability-card__label">${meta.label}</div>
            </div>`;
        }).join('')}
      </div>

      ${CONTACT_MARKUP}
      ${CAMERA_MARKUP}
      ${AR_MARKUP}

      <div class="hud__toast" data-toast></div>
      <div class="hud__paused" data-paused>Paused</div>
    `;

    this.contact = new ContactCard(root);
    this.camera = new CameraPanel(root);
    this.ar = new ARPanel(root);
    this.cards = new Map();
    for (const card of root.querySelectorAll('.ability-card')) {
      this.cards.set(card.dataset.element, card);
      card.addEventListener('pointerdown', (event) => {
        event.stopPropagation();
        this.onAbility?.(card.dataset.element);
      });
    }

    this.stats = {
      fps: root.querySelector('[data-stat="fps"]'),
      particles: root.querySelector('[data-stat="particles"]'),
      spikes: root.querySelector('[data-stat="spikes"]'),
      calls: root.querySelector('[data-stat="calls"]')
    };
    this.onCastle = null;
    this.castleSwitch = root.querySelector('[data-castle]');
    this.castleSwitch.addEventListener('pointerdown', (event) => event.stopPropagation());
    this.castleSwitch.addEventListener('click', () => this.onCastle?.());
    this._castleShown = null;
    this.help = root.querySelector('.hud__help');
    this.toast = root.querySelector('[data-toast]');
    this.pausedBadge = root.querySelector('[data-paused]');
    this.abilityBar = root.querySelector('.hud__abilities');
  }

  /** @param {{silent?: boolean}} [options] */
  setElement(element, options = {}) {
    for (const [key, card] of this.cards) {
      card.classList.toggle('is-active', key === element);
    }
    const meta = ELEMENT_META[element];
    this.contact.setAccent(meta?.accent);
    if (meta && !options.silent) this.showToast(`${meta.hint} selected`);
  }

  /** Highlight the slot while a cast is armed. */
  setArmed(armed) {
    if (armed === this._armedShown) return;
    this._armedShown = armed;
    this.abilityBar.classList.toggle('is-armed', armed);
  }

  /**
   * Drive one slot's cooldown sweep. Cooldowns are per ability, so this is
   * called once per element each frame.
   *
   * @param {string} element
   * @param {number} remaining seconds left
   * @param {number} total     the full cooldown, for the sweep angle
   */
  setCooldown(element, remaining, total) {
    const card = this.cards.get(element);
    if (!card) return;

    const ratio = Math.max(0, Math.min(1, remaining / Math.max(total, 0.001)));
    const shown = this._cooldownShown.get(element) ?? -1;
    const cooling = ratio > 0.001;
    // Only touch the DOM when the sweep visibly moves — except for the step
    // that starts or ends the cooldown, which always goes through: the last
    // tick to zero is usually smaller than the threshold, and skipping it
    // left a ready slot drawn as disabled.
    if (cooling === shown > 0.001 && Math.abs(ratio - shown) < 0.01) return;
    this._cooldownShown.set(element, ratio);
    card.style.setProperty('--cooldown', ratio);
    card.classList.toggle('is-cooling', cooling);
  }

  /**
   * Swap the bottom-right corner over to the camera readout.
   *
   * The contact card and the preview want the same corner, so this is a class
   * on the HUD root rather than two independent visibilities — there is never
   * a width at which both should be on screen.
   */
  setCameraVisible(on) {
    this.root.classList.toggle('hud--camera', on);
    this.camera.setVisible(on);
  }

  /** The AR panel and its placement overlay. */
  setARVisible(on) {
    this.root.classList.toggle('hud--ar', on);
    this.ar.setVisible(on);
  }

  /** Play the contact card's entrance once the loading veil is clearing. */
  reveal() {
    this.contact.reveal();
  }

  setPaused(paused) {
    this.pausedBadge.classList.toggle('is-visible', paused);
  }

  /** Mirror the castle setting on the switch; cheap to call every frame. */
  setCastle(on) {
    if (on === this._castleShown) return;
    this._castleShown = on;
    this.castleSwitch.classList.toggle('is-on', on);
    this.castleSwitch.setAttribute('aria-checked', String(on));
  }

  toggleHelp() {
    this.help.classList.toggle('is-hidden');
  }

  showToast(message, duration = 1600) {
    this.toast.textContent = message;
    this.toast.classList.add('is-visible');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this.toast.classList.remove('is-visible'), duration);
  }

  /**
   * @param {number} dt
   * @param {() => {particles:number, spikes:number, calls:number}} collect
   *   Called only when the readout actually refreshes, so gathering the numbers
   *   (which means walking the particle pools) stays off the hot path.
   */
  update(dt, collect) {
    this._frames++;
    this._statsAccumulator += dt;
    if (this._statsAccumulator < 0.4) return;

    this._fps = Math.round(this._frames / this._statsAccumulator);
    this._frames = 0;
    this._statsAccumulator = 0;

    const info = collect();
    this.stats.fps.textContent = this._fps;
    this.stats.particles.textContent = info.particles;
    this.stats.spikes.textContent = info.spikes;
    this.stats.calls.textContent = info.calls;
  }
}

/** Boot screen helper. */
export class LoadingScreen {
  constructor() {
    this.element = document.getElementById('loader');
    this.fill = document.getElementById('loader-fill');
    this.status = document.getElementById('loader-status');
  }

  setProgress(ratio, message) {
    this.fill.style.width = `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`;
    if (message) this.status.textContent = message;
  }

  hide() {
    this.setProgress(1);
    setTimeout(() => this.element.classList.add('is-hidden'), 220);
  }

  fail(message) {
    this.status.textContent = message;
    this.status.style.color = '#ff7a6a';
  }
}
