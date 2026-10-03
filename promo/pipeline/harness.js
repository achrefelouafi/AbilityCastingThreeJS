// Injected into the sandbox page. Takes the app off its rAF loop and drives it
// one fixed 1/60 s step at a time, with a scripted camera, so every frame of the
// capture is identical in timing no matter how long it takes to render.
window.__cap = (() => {
  const app = window.app;
  const STEP = 1 / 60;
  let THREE = null;

  const state = {
    cam: null, // (frameIndex) => { pos:[x,y,z], look:[x,y,z], fov }
    frame: 0,
    out: null,
    ctx: null
  };

  async function setup({ width, height, ratio }) {
    app.stop();
    // The app may hold an HMR-stamped copy (settings.js?t=...); use exactly the one it loaded.
    const loaded = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /\/src\/config\/settings\.js/.test(n));
    let mod = null;
    for (const url of loaded.reverse()) {
      const m = await import(url);
      if (app.aim.config === m.settings[app.aim.element]) { mod = m; break; }
    }
    if (!mod) throw new Error('could not find the live settings module');
    state.settings = mod.settings;
    mod.settings.dummies.respawnDelay = 999;
    mod.settings.dummies.corpseTime = 999;

    // Fixed timestep.
    app.time.tick = function () {
      this.delta = STEP;
      this.elapsed += STEP;
      return STEP;
    };

    // Clean frame: no HUD, editor, toasts, aim indicator.
    document.getElementById('hud').style.display = 'none';
    document.getElementById('loader')?.remove();
    app.editor.setHidden(true);
    document.querySelectorAll('.lil-gui').forEach((el) => (el.style.display = 'none'));
    app.aim.cancel();
    app.aim.object3D.visible = false;
    app.aim.update = () => {};

    // Supersample.
    app.renderer.targetPixelRatio = () => ratio;
    app.renderer.handleResize();

    // Scripted camera replaces the orbit rig.
    const rig = app.rig;
    rig.pan = () => {};
    rig.update = function () {
      const cam = this.camera;
      if (state.cam) {
        const c = state.cam(state.frame);
        cam.position.set(c.pos[0], c.pos[1], c.pos[2]);
        cam.lookAt(c.look[0], c.look[1], c.look[2]);
        if (c.fov && cam.fov !== c.fov) {
          cam.fov = c.fov;
          cam.updateProjectionMatrix();
        }
      }
      this.controls.target.copy(cam.position); // keep OrbitControls inert
      if (this.shakeOffset.lengthSq() > 0) {
        cam.position.add(this.shakeOffset);
        cam.rotateZ(this.shakeRoll);
      }
    };

    // Output canvas at the final size.
    state.out = document.createElement('canvas');
    state.out.width = width;
    state.out.height = height;
    state.ctx = state.out.getContext('2d');
    state.ctx.imageSmoothingEnabled = true;
    state.ctx.imageSmoothingQuality = 'high';
    return { w: app.renderer.gl.domElement.width, h: app.renderer.gl.domElement.height };
  }

  function setCamera(spec) {
    // spec: { look:[x,y,z], yaw0, yaw1, dist0, dist1, height0, height1, fov, frames, lookLift }
    const ease = (t) => t * t * (3 - 2 * t);
    state.cam = (f) => {
      const t = Math.min(1, Math.max(0, (f - (spec.start ?? 0)) / spec.frames));
      const e = spec.linear ? t : ease(t);
      const yaw = spec.yaw0 + (spec.yaw1 - spec.yaw0) * e;
      const dist = spec.dist0 + (spec.dist1 - spec.dist0) * e;
      const h = spec.height0 + (spec.height1 - spec.height0) * e;
      const L0 = spec.look0 ?? spec.look;
      const L1 = spec.look1 ?? spec.look;
      const look = [0, 1, 2].map((i) => L0[i] + (L1[i] - L0[i]) * e);
      return {
        pos: [look[0] + Math.sin(yaw) * dist, look[1] + h, look[2] + Math.cos(yaw) * dist],
        look,
        fov: spec.fov
      };
    };
  }

  /** Stand the bodies where the shot wants them, facing the caster. */
  function placeDummies(spots) {
    const field = app.dummies;
    const s = app.settings ?? null;
    field.update(0, app.character.position); // make sure slots exist
    const slots = field.slots;
    for (let i = 0; i < slots.length; i++) {
      const d = slots[i].dummy;
      slots[i].wait = 0;
      const spot = spots[i] ?? [80 + i * 3, 80]; // park extras far off-stage
      const yaw = Math.atan2(-spot[0], -spot[1]);
      d.place(spot[0], spot[1], yaw);
    }
  }

  function cast(element, target) {
    app.clearEffects();
    app.selectAbility(element, { silent: true });
    const origin = app.character.position.clone().setY(0);
    const dir = origin.clone().set(target[0] - origin.x, 0, target[1] - origin.z);
    const dist = dir.length();
    dir.normalize();
    app.aim.yaw = Math.atan2(dir.x, dir.z);
    app.aim.direction?.copy?.(dir);
    app._cast(origin, dir, dist);
    app.cooldowns.set(element, 0);
  }

  function step(n = 1) {
    for (let i = 0; i < n; i++) {
      app.frame();
      state.frame++;
    }
  }

  function grab(type = 'image/png', quality) {
    const src = app.renderer.gl.domElement;
    state.ctx.drawImage(src, 0, 0, state.out.width, state.out.height);
    return state.out.toDataURL(type, quality);
  }

  function resetFrame() {
    state.frame = 0;
  }

  return { setup, setCamera, placeDummies, cast, step, grab, resetFrame, state };
})();
