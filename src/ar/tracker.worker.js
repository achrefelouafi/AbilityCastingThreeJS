import { GrayImage, grayFromRGBA, PlanarTracker } from './planar.js';

/**
 * The planar tracker, off the main thread.
 *
 * The render loop cannot afford ten milliseconds of feature tracking a frame,
 * and it does not have to: the tracker only needs pixels in and a matrix out.
 * `ARSession` posts each frame's RGBA (the buffer is *transferred*, not
 * copied) and gets the homography and the quad back, tagged with the frame's
 * id so the video it draws is the frame the pose was computed from.
 *
 * Messages in:
 *   { type: 'reference', width, height, rgba, quad }  freeze this as the plane
 *   { type: 'frame', id, width, height, rgba }        track this one
 *   { type: 'reset' }
 * Messages out:
 *   { type: 'reference', features }                    with the count found
 *   { type: 'result', id, ok, lost, H, quad, inliers, total, ms, rgba }
 *     the buffer comes back with it, for the caller to reuse
 */

const tracker = new PlanarTracker();
/** Two grey buffers alternate: the tracker keeps the previous frame by reference. */
const grays = [null, null];
let slot = 0;

function gray(rgba, width, height) {
  slot ^= 1;
  let img = grays[slot];
  if (!img || img.width !== width || img.height !== height) img = grays[slot] = new GrayImage(width, height);
  return grayFromRGBA(new Uint8ClampedArray(rgba), width, height, img);
}

self.onmessage = (event) => {
  const message = event.data;
  switch (message.type) {
    case 'reference': {
      const img = gray(message.rgba, message.width, message.height);
      const features = tracker.setReference(img, message.quad);
      self.postMessage({ type: 'reference', features, rgba: message.rgba }, [message.rgba]);
      break;
    }
    case 'frame': {
      const started = performance.now();
      const img = gray(message.rgba, message.width, message.height);
      const result = tracker.track(img);
      self.postMessage(
        {
          type: 'result',
          id: message.id,
          ok: result.ok,
          lost: result.lost,
          H: Array.from(result.H),
          quad: Array.from(result.quad),
          inliers: result.inliers,
          total: result.total,
          ms: performance.now() - started,
          rgba: message.rgba
        },
        [message.rgba]
      );
      break;
    }
    case 'reset':
      tracker.ref = null;
      tracker.lost = true;
      break;
    default:
      break;
  }
};
