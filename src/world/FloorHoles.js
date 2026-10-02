import { Vector4 } from 'three';

/** How many openings the floor can have at once. Must match `MAX_FLOOR_HOLES` in the ground shader. */
export const MAX_FLOOR_HOLES = 8;

/**
 * Holes in the stage floor.
 *
 * The floor is one opaque plane, and every ability on the stage assumes it:
 * what goes under y = 0 is hidden by it, which is how a whirlpool disposes of a
 * corpse and how a phoenix climbs out of a pyre. The one thing it cannot do is
 * let you *see* down — and a portal of water that a shark leaps out of has to
 * be a hole, with the animal visible in it, not a decal it pops through.
 *
 * So the ground shader reads this table and discards inside every open hole
 * (`Ground`), and whatever an ability draws under the floor — a well of water,
 * the shark in it — shows through that one opening and nowhere else. The
 * stage's depth still does all the hiding everywhere else.
 *
 * Each slot is `(x, z, radius, 0)` in world metres; a radius of 0 is closed.
 * The array is the uniform value itself, handed to the ground shader by
 * reference, so writing a slot is the whole update.
 */
export const floorHoles = {
  uniform: { value: Array.from({ length: MAX_FLOOR_HOLES }, () => new Vector4(0, 0, 0, 0)) },
  _used: new Array(MAX_FLOOR_HOLES).fill(false),

  /** @returns {number} a slot index, or -1 when the floor is already full of holes */
  acquire() {
    const index = this._used.indexOf(false);
    if (index < 0) return -1;
    this._used[index] = true;
    this.uniform.value[index].set(0, 0, 0, 0);
    return index;
  },

  /** Open (or move, or close down to nothing) one hole. Ignores a slot of -1. */
  set(index, x, z, radius) {
    if (index < 0) return;
    this.uniform.value[index].set(x, z, Math.max(0, radius), 0);
  },

  release(index) {
    if (index < 0) return;
    this._used[index] = false;
    this.uniform.value[index].set(0, 0, 0, 0);
  }
};
