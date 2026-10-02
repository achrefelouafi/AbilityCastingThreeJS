/**
 * Let a HUD panel be dragged anywhere on screen.
 *
 * A panel starts anchored to a corner via CSS; the first drag converts that
 * to an explicit left/top (`is-placed`) so the anchor no longer fights the
 * pointer, and the position is kept within the viewport on release so the
 * panel cannot be lost off-screen. A press on a control is a click, not the
 * start of a drag — capturing the pointer there would steal the click.
 *
 * @param {HTMLElement} el
 * @returns {() => void} detach
 */
export function makeDraggable(el) {
  let dragPointer = null;
  const offset = { x: 0, y: 0 };

  const place = (x, y) => {
    el.classList.add('is-placed');
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  };

  const clamp = () => {
    const rect = el.getBoundingClientRect();
    const x = Math.min(Math.max(0, rect.left), Math.max(0, window.innerWidth - rect.width));
    const y = Math.min(Math.max(0, rect.top), Math.max(0, window.innerHeight - rect.height));
    place(x, y);
  };

  const down = (event) => {
    event.stopPropagation();
    if (dragPointer !== null || event.button !== 0) return;
    if (event.target.closest('button, a, input, select, label, textarea')) return;
    dragPointer = event.pointerId;
    const rect = el.getBoundingClientRect();
    offset.x = event.clientX - rect.left;
    offset.y = event.clientY - rect.top;
    el.setPointerCapture(event.pointerId);
    el.classList.add('is-dragging');
    place(rect.left, rect.top);
  };

  const move = (event) => {
    if (event.pointerId !== dragPointer) return;
    event.stopPropagation();
    place(event.clientX - offset.x, event.clientY - offset.y);
  };

  const release = (event) => {
    if (event.pointerId !== dragPointer) return;
    event.stopPropagation();
    dragPointer = null;
    el.classList.remove('is-dragging');
    clamp();
  };

  const resize = () => {
    if (el.classList.contains('is-placed')) clamp();
  };

  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
  el.addEventListener('lostpointercapture', release);
  window.addEventListener('resize', resize);

  return () => {
    el.removeEventListener('pointerdown', down);
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', release);
    el.removeEventListener('pointercancel', release);
    el.removeEventListener('lostpointercapture', release);
    window.removeEventListener('resize', resize);
  };
}
