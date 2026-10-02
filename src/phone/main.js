import { openSignal } from '../input/PhoneSignal.js';

/**
 * The phone end of "use my phone as the camera".
 *
 * Opened from the QR code in the sandbox's camera panel, with the room id in
 * the query string. It asks for the camera, joins the room on the dev
 * server's relay, and sends the desktop a WebRTC offer whenever the desktop
 * says `hello` — on pairing, and again after the sandbox has been reloaded,
 * which is what lets it reconnect without a rescan. The video itself never
 * touches the server: once ICE has a route it goes straight to the PC.
 *
 * The frame it sends is the raw camera frame, front or rear — a camera
 * pointed at the presenter sees their right hand on the image's left either
 * way, which is what the tracker assumes of a webcam. Only the preview here
 * is mirrored, and only for the selfie camera, as every camera app does.
 *
 * Paired from the sandbox's AR panel (`?ar=1`, or a `mode` message once
 * connected) the page opens the *rear* camera in HD instead: the phone is
 * looking at a table, and the print on it has to survive a projector. And
 * the stage is placed *from here*: freeze the preview, drag four thumb-sized
 * handles onto a printed rectangle, tap Place — the frozen frame and the
 * corners go to the desktop, which locks its tracker on exactly that
 * picture. The desktop then sends its rendered view back on a second video
 * track the offer reserved for it, and this page becomes a window onto the
 * stage standing on the table.
 *
 * LOCAL ONLY. The relay is a Vite dev-server plugin; there is no backend.
 * See `tools/vite-plugin-phone-camera.js`.
 */

const $ = (selector) => document.querySelector(selector);
const frame = $('[data-frame]');
const video = $('[data-video]');
const badge = $('[data-badge]');
const statusLine = $('[data-status]');
const startButton = $('[data-start]');
const flipButton = $('[data-flip]');
const stopButton = $('[data-stop]');
const arBox = $('[data-ar]');
const freezeCanvas = $('[data-freeze]');
const quadSvg = $('[data-quad]');
const quadPoly = $('[data-quad-poly]');
const handles = Array.from(document.querySelectorAll('[data-handle]'));
const loupe = $('[data-loupe]');
const shapeSelect = $('[data-ar-shape]');
const customBox = $('[data-ar-custom]');
const customW = $('[data-ar-w]');
const customH = $('[data-ar-h]');
const freezeButton = $('[data-ar-freeze]');
const placeButton = $('[data-ar-place]');
const stageBox = $('[data-stage]');
const stageVideo = $('[data-stage-video]');
const stageStatus = $('[data-stage-status]');
const stageMove = $('[data-stage-move]');

const params = new URLSearchParams(location.search);
const room = params.get('room');
/** AR mode: rear camera, HD, more bitrate. Flipped live by a `mode` message. */
let arMode = params.get('ar') === '1';

/**
 * The same 4:3 the webcam is asked for; the hand model downsamples anyway.
 * AR asks for 720p: the frame is the backdrop of the whole show there.
 */
const CAMERA = (facing) =>
  arMode
    ? { video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: false }
    : { video: { facingMode: facing, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } }, audio: false };
/** A LAN has the headroom; sharp fingers help the tracker, sharp print the AR. */
const MAX_BITRATE = () => (arMode ? 6_000_000 : 2_500_000);
const DISCONNECT_GRACE_MS = 4000;
const RETRY_MS = 3000;
const MAX_RETRIES = 5;

let stream = null;
let facing = arMode ? 'environment' : 'user';
let signal = null;
let pc = null;
let desktopPresent = false;
/** The desktop page load the last offer went to; a new one needs a new offer. */
let desktopInstance = null;
let wakeLock = null;
let retries = 0;
let disconnectTimer = 0;
/**
 * Tags the offer in flight. A `hello` landing while `startCamera` is still
 * awaiting the device can put two offers out; the desktop answers both, and
 * the first answer must not be applied to the second peer.
 */
let offerId = '';
/** Signalling is applied in order — an ICE candidate must follow its answer. */
let chain = Promise.resolve();

/* AR placement state. Corners are fractions of the frame, so the desktop can
   scale them to whatever size the stream arrives at. */
let corners = null;
let placing = false;
let placed = false;
let referenceImage = null;
let drag = null;
let cornersSentAt = 0;
/** The desktop's rendered view, once it arrives on the return line. */
let stageStream = null;
const SHAPE_ASPECT = { a4: 297 / 210, letter: 11 / 8.5, square: 1, wide: 16 / 9 };

/* ------------------------------------------------------------------ */
/* UI                                                                  */
/* ------------------------------------------------------------------ */

function setStatus(text, kind = 'info') {
  statusLine.textContent = text;
  statusLine.dataset.kind = kind;
}

function setBadge(text, live = false) {
  badge.textContent = text;
  frame.classList.toggle('is-live', live);
}

function showRunning(on) {
  startButton.hidden = on;
  startButton.disabled = false;
  flipButton.hidden = !on;
  flipButton.disabled = false;
  stopButton.hidden = !on;
  freezeButton.disabled = !on;
  if (!on) endPlacement();
}

function describeCameraError(error) {
  switch (error?.name) {
    case 'NotAllowedError':
      return 'Camera permission was refused. Allow it for this site in the browser settings, then tap Start again.';
    case 'NotFoundError':
      return 'No camera was found on this device.';
    case 'NotReadableError':
      return 'The camera is busy — another app has it. Close that app and tap Start again.';
    default:
      return `Could not open the camera: ${error?.message ?? error}`;
  }
}

/** True when the page cannot work at all, with the reason on screen. */
function preflight() {
  if (!room) {
    setStatus('Open this page by scanning the QR code in the sandbox’s camera panel — it carries the room id.', 'error');
    return false;
  }
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    setStatus(
      'This browser will not hand over the camera on a plain-HTTP address. On the PC, run `npm run dev:lan` and scan the code again.',
      'error'
    );
    return false;
  }
  if (!('RTCPeerConnection' in window)) {
    setStatus('This browser has no WebRTC, which the video link needs.', 'error');
    return false;
  }
  return true;
}

/**
 * Show the whole frame, whatever its shape — the same picture the desktop
 * gets, so what is in view here is what the tracker sees there. A portrait
 * frame is narrowed to a little over half the screen's height rather than
 * pushing the controls off the bottom.
 */
function fitFrame() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;
  const portrait = vh > vw;
  frame.style.aspectRatio = `${vw} / ${vh}`;
  frame.style.width = portrait ? `${Math.round((window.innerHeight * 0.55 * vw) / vh)}px` : '';
  frame.classList.toggle('is-portrait', portrait);
}
video.addEventListener('loadedmetadata', fitFrame);
video.addEventListener('resize', fitFrame);
window.addEventListener('resize', fitFrame);

/* ------------------------------------------------------------------ */
/* Camera                                                              */
/* ------------------------------------------------------------------ */

async function openCamera() {
  try {
    return await navigator.mediaDevices.getUserMedia(CAMERA(facing));
  } catch (error) {
    // A phone with one camera has no `environment`; take what it has.
    if (error?.name === 'OverconstrainedError') return navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    throw error;
  }
}

async function startCamera() {
  startButton.disabled = true;
  flipButton.disabled = true;
  setStatus('Asking for the camera…');

  let next;
  try {
    next = await openCamera();
  } catch (error) {
    startButton.disabled = false;
    flipButton.disabled = false;
    setStatus(describeCameraError(error), 'error');
    return;
  }

  const previous = stream;
  stream = next;
  const [track] = stream.getVideoTracks();
  // Frame rate over resolution when the link is squeezed: a hand is read
  // from motion, and a sharp frame every 100 ms is worse than a soft one
  // every 33.
  track.contentHint = 'motion';
  track.addEventListener('ended', () => {
    // The OS took the camera — a call came in, or the page went to the
    // background on iOS. The desktop notices on its own; here, offer a way back.
    if (stream?.getVideoTracks()[0] !== track) return;
    setStatus('The camera was stopped by the phone. Tap Start to resume.', 'warn');
    setBadge('Stopped');
    showRunning(false);
  });

  video.srcObject = stream;
  // Never mirrored in AR mode: the corners are placed on the frame as it is sent.
  frame.classList.toggle('is-mirrored', facing === 'user' && !arMode);
  await video.play().catch(() => {});

  if (pc) {
    // Flipping mid-stream: swap the track in the live connection rather than
    // renegotiating, and the desktop never sees a gap. The bitrate follows
    // the mode — HD for AR wants the headroom.
    for (const sender of pc.getSenders()) {
      if (sender.track?.kind !== 'video') continue;
      await sender.replaceTrack(track).catch(() => {});
      try {
        const params = sender.getParameters();
        if (params.encodings?.length) {
          params.encodings[0].maxBitrate = MAX_BITRATE();
          await sender.setParameters(params);
        }
      } catch {
        /* keep whatever was negotiated */
      }
    }
    signal?.send({ type: 'facing', facing }).catch(() => {});
  }
  previous?.getTracks().forEach((t) => t.stop());

  showRunning(true);
  setBadge(pc?.connectionState === 'connected' ? 'Live' : 'Camera on', pc?.connectionState === 'connected');
  await keepAwake();

  if (pc) return;
  if (desktopPresent) await offer();
  else setStatus('Camera on — waiting for the sandbox. Is its camera panel open?');
}

function stopCamera() {
  signal?.send({ type: 'bye' }).catch(() => {});
  closePeer();
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  frame.classList.remove('is-mirrored');
  showRunning(false);
  setBadge('Idle');
  setStatus('Camera off. Tap Start to send it again.');
}

async function keepAwake() {
  // A phone that dims and locks takes the camera with it.
  try {
    wakeLock = (await navigator.wakeLock?.request('screen')) ?? null;
  } catch {
    wakeLock = null;
  }
}

/* ------------------------------------------------------------------ */
/* WebRTC                                                              */
/* ------------------------------------------------------------------ */

function closePeer() {
  clearTimeout(disconnectTimer);
  disconnectTimer = 0;
  if (!pc) return;
  pc.onicecandidate = null;
  pc.onconnectionstatechange = null;
  pc.close();
  pc = null;
}

async function offer() {
  if (!stream || !signal) return;
  closePeer();

  const peer = new RTCPeerConnection({ iceServers: [] });
  pc = peer;
  const id = Math.random().toString(36).slice(2, 10);
  offerId = id;

  const [track] = stream.getVideoTracks();
  const sender = peer.addTrack(track, stream);
  try {
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = MAX_BITRATE();
    params.degradationPreference = 'maintain-framerate';
    await sender.setParameters(params);
  } catch {
    // Not every browser lets these be set before negotiation. Defaults are fine.
  }

  // A second, receive-only video line, reserved for the desktop's rendered
  // view to come back on. Reserving it now means the desktop can attach and
  // detach that track later without a renegotiation this page would have to
  // take part in.
  const returnLine = peer.addTransceiver('video', { direction: 'recvonly' });
  peer.ontrack = (event) => {
    if (event.track.kind !== 'video') return;
    stageStream = event.streams[0] ?? new MediaStream([event.track]);
    stageVideo.srcObject = stageStream;
    stageVideo.play().catch(() => {});
    // A track that goes quiet (the desktop left AR mode) takes the view with it.
    event.track.addEventListener('mute', () => syncStageView());
    event.track.addEventListener('unmute', () => syncStageView());
    event.track.addEventListener('ended', () => {
      stageStream = null;
      syncStageView();
    });
    syncStageView();
  };

  peer.onicecandidate = (event) => {
    if (event.candidate) signal.send({ type: 'ice', candidate: event.candidate.toJSON(), offerId: id }).catch(() => {});
  };

  peer.onconnectionstatechange = () => {
    if (pc !== peer) return;
    switch (peer.connectionState) {
      case 'connected':
        clearTimeout(disconnectTimer);
        retries = 0;
        setStatus('Streaming to the sandbox. Leave this page open.', 'live');
        setBadge('Live', true);
        break;
      case 'disconnected':
        clearTimeout(disconnectTimer);
        disconnectTimer = setTimeout(() => {
          if (pc === peer && peer.connectionState === 'disconnected') setStatus('Connection wobbling…', 'warn');
        }, DISCONNECT_GRACE_MS);
        break;
      case 'failed':
        closePeer();
        setBadge('Camera on');
        if (desktopPresent && retries < MAX_RETRIES) {
          retries += 1;
          setStatus(`Could not reach the PC directly — retrying (${retries}/${MAX_RETRIES})…`, 'warn');
          setTimeout(() => {
            if (!pc && desktopPresent && stream) offer();
          }, RETRY_MS);
        } else {
          setStatus(
            'Could not connect to the PC. Both devices need to be on the same Wi-Fi, and guest networks or "client isolation" block this.',
            'error'
          );
        }
        break;
      default:
        break;
    }
  };

  setStatus('Connecting to the sandbox…');
  setBadge('Connecting');
  const description = await peer.createOffer();
  await peer.setLocalDescription(description);
  await signal.send({ type: 'offer', sdp: peer.localDescription.sdp, facing, offerId: id, returnMid: returnLine.mid });
}

async function handle(message) {
  switch (message.type) {
    case 'hello': {
      // A new instance is a reloaded sandbox: its side of any connection is
      // gone even if ours still says `connected`. The same instance again is
      // only its relay stream reconnecting; a live link is left alone.
      const fresh = message.instance !== desktopInstance;
      desktopInstance = message.instance ?? null;
      desktopPresent = true;
      retries = 0;
      if (!stream) {
        setStatus('The sandbox is ready. Tap Start camera.');
        break;
      }
      if (fresh || pc?.connectionState !== 'connected') await offer();
      break;
    }
    case 'answer':
      if (message.offerId === offerId && pc?.signalingState === 'have-local-offer') {
        await pc.setRemoteDescription({ type: 'answer', sdp: message.sdp });
      }
      break;
    case 'ice':
      if (message.offerId === offerId && pc && message.candidate) {
        try {
          await pc.addIceCandidate(message.candidate);
        } catch {
          // For a connection since replaced. Harmless.
        }
      }
      break;
    case 'mode': {
      // The sandbox went into (or out of) AR mode: swap cameras in place.
      const wanted = !!message.ar;
      if (!wanted) {
        placed = false;
        endPlacement();
        syncStageView();
      }
      if (wanted === arMode && (!stream || facing === (wanted ? 'environment' : 'user'))) break;
      arMode = wanted;
      facing = wanted ? 'environment' : 'user';
      applyModeCopy();
      if (stream) await startCamera();
      break;
    }
    case 'stage': {
      // The desktop's word on the stage: placed, tracking, lost.
      if (message.locked === false && placed) {
        // Taken away from the desktop's side.
        placed = false;
        syncStageView();
        setStatus('The stage was unlocked on the PC. Freeze and place it again when you like.');
        break;
      }
      const text = message.tracking
        ? `Tracking · ${message.inliers} points`
        : message.lost
          ? 'Lost the rectangle — bring it back into view'
          : message.locked
            ? 'Locking on…'
            : '';
      stageStatus.textContent = text;
      stageStatus.dataset.kind = message.tracking ? 'live' : message.lost ? 'warn' : 'info';
      break;
    }
    case 'bye':
      closePeer();
      desktopInstance = null;
      setBadge(stream ? 'Camera on' : 'Idle');
      setStatus(
        stream
          ? 'The sandbox let go of the camera. Leave this open — it reconnects when the panel asks again.'
          : 'The sandbox let go of the camera.',
        'warn'
      );
      break;
    default:
      break;
  }
}

/** The copy on the page: a webcam stand-in, or the AR camera. */
function applyModeCopy() {
  const sub = document.querySelector('.phone__sub');
  const tips = document.querySelector('[data-tips-ar]');
  const tipsCam = document.querySelector('[data-tips-cam]');
  if (sub) sub.textContent = arMode ? 'This phone is the AR camera' : 'This phone is the camera';
  if (tips) tips.hidden = !arMode;
  if (tipsCam) tipsCam.hidden = arMode;
  arBox.hidden = !arMode;
  frame.classList.toggle('is-mirrored', facing === 'user' && !arMode);
}

/* ------------------------------------------------------------------ */
/* AR: placing the stage                                               */
/* ------------------------------------------------------------------ */

function aspectOf() {
  const id = shapeSelect.value;
  if (id !== 'custom') return SHAPE_ASPECT[id] ?? SHAPE_ASPECT.a4;
  const w = Number(customW.value) || 1;
  const h = Number(customH.value) || 1;
  return Math.max(w, h) / Math.min(w, h);
}

/** A rectangle over the middle of the frame, in the chosen shape. */
function defaultCorners() {
  const vw = video.videoWidth || 4;
  const vh = video.videoHeight || 3;
  const rw = 0.6;
  const rh = Math.min(0.7, (rw * vw) / aspectOf() / vh);
  return new Float64Array([0.5 - rw / 2, 0.5 - rh / 2, 0.5 + rw / 2, 0.5 - rh / 2, 0.5 + rw / 2, 0.5 + rh / 2, 0.5 - rw / 2, 0.5 + rh / 2]);
}

/**
 * Hold the picture still and put the handles on it. The frozen frame is
 * also the reference the desktop's tracker will lock on, so it is kept as
 * a JPEG at tracker size right now, before anything moves.
 */
function freeze() {
  if (!stream || !video.videoWidth) return;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  freezeCanvas.width = vw;
  freezeCanvas.height = vh;
  freezeCanvas.getContext('2d').drawImage(video, 0, 0);
  freezeCanvas.hidden = false;

  const ref = document.createElement('canvas');
  ref.width = Math.min(640, vw);
  ref.height = Math.round((vh * ref.width) / vw);
  ref.getContext('2d').drawImage(video, 0, 0, ref.width, ref.height);
  referenceImage = ref.toDataURL('image/jpeg', 0.86);

  if (!corners) corners = defaultCorners();
  quadSvg.setAttribute('viewBox', `0 0 ${vw} ${vh}`);
  placing = true;
  quadSvg.hidden = false;
  for (const handle of handles) handle.hidden = false;
  layoutQuad();
  placeButton.disabled = false;
  freezeButton.textContent = '↻ Freeze again';
  setStatus('Drag the four corners onto the rectangle, then place the stage.');
}

function endPlacement() {
  placing = false;
  drag = null;
  loupe.hidden = true;
  freezeCanvas.hidden = true;
  quadSvg.hidden = true;
  for (const handle of handles) handle.hidden = true;
  placeButton.disabled = true;
  freezeButton.textContent = '❄ Freeze & place';
}

function layoutQuad() {
  if (!corners) return;
  const vw = video.videoWidth || 4;
  const vh = video.videoHeight || 3;
  const points = [];
  for (let i = 0; i < 4; i++) {
    handles[i].style.left = `${corners[2 * i] * 100}%`;
    handles[i].style.top = `${corners[2 * i + 1] * 100}%`;
    points.push(`${(corners[2 * i] * vw).toFixed(1)},${(corners[2 * i + 1] * vh).toFixed(1)}`);
  }
  quadPoly.setAttribute('points', points.join(' '));
}

/** Pointer → fraction of the frame. */
function toFrame(clientX, clientY) {
  const rect = frame.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height))
  };
}

function drawLoupe(fx, fy, clientX, clientY) {
  const vw = freezeCanvas.width;
  const vh = freezeCanvas.height;
  if (!vw) return;
  const ctx = loupe.getContext('2d');
  const source = Math.max(40, vw / 12);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, loupe.width, loupe.height);
  ctx.drawImage(freezeCanvas, fx * vw - source / 2, fy * vh - source / 2, source, source, 0, 0, loupe.width, loupe.height);
  ctx.strokeStyle = 'rgba(127, 214, 255, 0.9)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(loupe.width / 2, 0);
  ctx.lineTo(loupe.width / 2, loupe.height);
  ctx.moveTo(0, loupe.height / 2);
  ctx.lineTo(loupe.width, loupe.height / 2);
  ctx.stroke();
  // Above the thumb, where it can be seen; centred, clamped to the screen.
  let x = clientX - loupe.width / 2;
  let y = clientY - loupe.height - 60;
  x = Math.max(8, Math.min(window.innerWidth - loupe.width - 8, x));
  if (y < 8) y = clientY + 60;
  loupe.style.left = `${x}px`;
  loupe.style.top = `${y}px`;
  loupe.hidden = false;
}

function moveHandle(event) {
  if (!drag) return;
  const p = toFrame(event.clientX, event.clientY);
  corners[2 * drag.index] = p.x;
  corners[2 * drag.index + 1] = p.y;
  layoutQuad();
  drawLoupe(p.x, p.y, event.clientX, event.clientY);
  // The desktop mirrors the handles as they move — a glance at the big
  // screen says whether the corner is on the sheet.
  const now = performance.now();
  if (now - cornersSentAt > 80) {
    cornersSentAt = now;
    signal?.send({ type: 'corners', corners: Array.from(corners) }).catch(() => {});
  }
}

for (const handle of handles) {
  handle.addEventListener('pointerdown', (event) => {
    if (!placing) return;
    event.preventDefault();
    drag = { index: Number(handle.dataset.handle), pointer: event.pointerId };
    handle.setPointerCapture(event.pointerId);
    handle.classList.add('is-dragging');
    moveHandle(event);
  });
  handle.addEventListener('pointermove', (event) => {
    if (drag && event.pointerId === drag.pointer) moveHandle(event);
  });
  const release = (event) => {
    if (!drag || event.pointerId !== drag.pointer) return;
    handle.classList.remove('is-dragging');
    drag = null;
    loupe.hidden = true;
  };
  handle.addEventListener('pointerup', release);
  handle.addEventListener('pointercancel', release);
}

// A tap on the frozen frame sends the nearest corner there.
frame.addEventListener('pointerdown', (event) => {
  if (!placing || event.target.closest('.phone__handle')) return;
  const p = toFrame(event.clientX, event.clientY);
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < 4; i++) {
    const d = Math.hypot(corners[2 * i] - p.x, corners[2 * i + 1] - p.y);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  corners[2 * best] = p.x;
  corners[2 * best + 1] = p.y;
  layoutQuad();
  signal?.send({ type: 'corners', corners: Array.from(corners) }).catch(() => {});
});

/** Send the frozen frame and the corners; the desktop locks on them. */
async function place() {
  if (!placing || !corners || !referenceImage) return;
  placeButton.disabled = true;
  setStatus('Placing the stage…');
  try {
    await signal.send({ type: 'plane', corners: Array.from(corners), aspect: aspectOf(), image: referenceImage });
  } catch (error) {
    setStatus(`Could not send the placement: ${error?.message ?? error}`, 'error');
    placeButton.disabled = false;
    return;
  }
  placed = true;
  endPlacement();
  stageStatus.textContent = 'Locking on…';
  stageStatus.dataset.kind = 'info';
  syncStageView();
  setStatus(stageStream ? 'The stage is on the table. Look through the phone.' : 'Placed. The PC is tracking — its view arrives here when it is in AR mode.', 'live');
}

/** Take the stage away and get the handles back, on a fresh frozen frame. */
function unplace() {
  signal?.send({ type: 'unplace' }).catch(() => {});
  placed = false;
  syncStageView();
  freeze();
}

/** The window onto the table is up while the stage is placed and the desktop's view is flowing. */
function syncStageView() {
  const track = stageStream?.getVideoTracks()[0];
  const flowing = !!track && track.readyState === 'live' && !track.muted;
  stageBox.hidden = !(placed && flowing);
}

shapeSelect.addEventListener('change', () => {
  // The corners stay where they were dragged; the shape only says how the
  // rectangle they outline is proportioned.
  customBox.hidden = shapeSelect.value !== 'custom';
});
freezeButton.addEventListener('click', freeze);
placeButton.addEventListener('click', place);
stageMove.addEventListener('click', unplace);

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

applyModeCopy();
if (preflight()) {
  signal = openSignal({
    room,
    role: 'phone',
    onMessage: (message) => {
      chain = chain.then(() => handle(message)).catch((error) => {
        console.warn('[phone-camera] signalling failed', error);
        setStatus(`Pairing failed: ${error?.message ?? error}`, 'error');
      });
    },
    onPeer: (present) => {
      desktopPresent = present;
      if (present) return;
      // Its relay stream dropped — a reload, or the panel closed. A live
      // video link may well survive the former; the peer connection will
      // say if it does not.
      if (pc) return;
      setStatus(
        stream
          ? 'The sandbox is away. Leave this open — it reconnects when the panel asks again.'
          : 'The sandbox is not listening. Open its camera panel (M) and tap "Use your phone".',
        'warn'
      );
    },
    onOpen: () => {
      if (!stream) setStatus(desktopPresent ? 'The sandbox is ready. Tap Start camera.' : 'Connected to the dev server. Tap Start camera.');
    },
    onError: () => {
      if (!pc) setStatus('Lost the dev server — retrying…', 'warn');
    }
  });

  startButton.addEventListener('click', startCamera);
  stopButton.addEventListener('click', stopCamera);
  flipButton.addEventListener('click', () => {
    facing = facing === 'user' ? 'environment' : 'user';
    startCamera();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && stream) keepAwake();
  });

  // Best effort on the way out, so the desktop's panel says "disconnected"
  // now rather than when ICE gives up.
  window.addEventListener('pagehide', () => {
    if (!stream) return;
    const query = `room=${encodeURIComponent(room)}&role=phone`;
    navigator.sendBeacon?.(`./__phone-cam/send?${query}`, new Blob([JSON.stringify({ type: 'bye' })], { type: 'application/json' }));
  });
} else {
  startButton.disabled = true;
}
