export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 10;
export const MIN_READABLE_ZOOM = 0.75;
export const KEY_ZOOM_FACTOR = 1.5;
export const CANVAS_PADDING = 24;
export const PAN_STEP = 72;
export const RESIZE_DEBOUNCE_MS = 100;

export const state = Object.create(null);

let activeKey = 'data-models';
let spaceHeld = false;
let ctrlHeld = false;

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function keyFromViewport(vp) {
  return vp.id.replace('vp-', '');
}

export function getParts(key) {
  const vp = document.getElementById('vp-' + key);
  return {
    vp,
    canvas: vp.querySelector('.canvas'),
    slider: vp.querySelector('.zoom-slider'),
    readout: vp.querySelector('.zoom-readout'),
    miniMap: vp.querySelector('.mini-map'),
    viewRect: vp.querySelector('.view-rect')
  };
}

export function getActiveKey() {
  return activeKey;
}

export function markActive(key) {
  activeKey = key;
}

export function isSpaceHeld() {
  return spaceHeld;
}

export function setSpaceHeld(value) {
  spaceHeld = value;
}

export function setCtrlHeld(value) {
  ctrlHeld = value;
  document.body.classList.toggle('ctrl-held', ctrlHeld);
}

export function resetHeldKeys() {
  spaceHeld = false;
  ctrlHeld = false;
  document.body.classList.remove('ctrl-held');
  document.querySelectorAll('.viewport').forEach((vp) => vp.classList.remove('space-ready', 'grabbing'));
}

export function createViewportState() {
  return {
    zoom: 1,
    panX: 0,
    panY: 0,
    dragging: false,
    pointerId: null,
    lastX: 0,
    lastY: 0,
    wheelEvent: null,
    wheelFrame: 0,
    transformController: null,
    transformFrame: 0,
    miniMapController: null,
    miniMapIdleId: 0,
    diagramWidth: 0,
    diagramHeight: 0,
    initialized: false,
    loading: false,
    loadAbortController: null
  };
}
