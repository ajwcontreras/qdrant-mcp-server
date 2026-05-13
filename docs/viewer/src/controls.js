import {
  CANVAS_PADDING,
  MAX_ZOOM,
  MIN_READABLE_ZOOM,
  MIN_ZOOM,
  clamp,
  getParts,
  isSpaceHeld,
  keyFromViewport,
  markActive,
  state
} from './state.js';

const requestIdle = window.requestIdleCallback || ((callback) => window.setTimeout(callback, 1));
const cancelIdle = window.cancelIdleCallback || ((id) => window.clearTimeout(id));

export function setAnimated(key, enabled) {
  const { canvas } = getParts(key);
  canvas.classList.toggle('is-animating', enabled);
  if (!enabled) return;
  window.setTimeout(() => canvas.classList.remove('is-animating'), 230);
}

export function updateTransform(key) {
  const s = state[key];
  const { vp, slider, readout } = getParts(key);
  if (s.transformController) s.transformController.abort();

  const controller = new AbortController();
  s.transformController = controller;
  s.transformFrame = requestAnimationFrame(() => {
    if (controller.signal.aborted) return;
    s.transformFrame = 0;
    s.transformController = null;
    vp.style.setProperty('--x', s.panX + 'px');
    vp.style.setProperty('--y', s.panY + 'px');
    vp.style.setProperty('--scale', String(s.zoom));
    scheduleMiniMapUpdate(key, controller.signal);
  });
  controller.signal.addEventListener('abort', () => {
    if (s.transformFrame) {
      cancelAnimationFrame(s.transformFrame);
      s.transformFrame = 0;
    }
  }, { once: true });

  const percent = Math.round(s.zoom * 100);
  slider.value = String(clamp(percent, Number(slider.min), Number(slider.max)));
  readout.textContent = percent + '%';
}

export function scheduleMiniMapUpdate(key, signal) {
  const s = state[key];
  if (!s) return;
  if (s.miniMapController) s.miniMapController.abort();
  if (s.miniMapIdleId) cancelIdle(s.miniMapIdleId);

  const controller = new AbortController();
  s.miniMapController = controller;
  const abortMiniMap = () => controller.abort();
  signal?.addEventListener('abort', abortMiniMap, { once: true });

  s.miniMapIdleId = requestIdle(() => {
    s.miniMapIdleId = 0;
    signal?.removeEventListener('abort', abortMiniMap);
    if (signal?.aborted) return;
    if (controller.signal.aborted) return;
    updateMiniMap(key);
  });
}

function updateMiniMap(key) {
  const s = state[key];
  const { vp, miniMap, viewRect } = getParts(key);
  if (!s.diagramWidth || !s.diagramHeight) return;

  const mapW = miniMap.clientWidth;
  const mapH = miniMap.clientHeight;
  const scale = Math.min(mapW / s.diagramWidth, mapH / s.diagramHeight);
  const drawW = s.diagramWidth * scale;
  const drawH = s.diagramHeight * scale;
  const offsetX = (mapW - drawW) / 2;
  const offsetY = (mapH - drawH) / 2;

  const visibleLeft = (-s.panX / s.zoom) - CANVAS_PADDING;
  const visibleTop = (-s.panY / s.zoom) - CANVAS_PADDING;
  const visibleW = vp.clientWidth / s.zoom;
  const visibleH = vp.clientHeight / s.zoom;

  const x = offsetX + clamp(visibleLeft, 0, s.diagramWidth) * scale;
  const y = offsetY + clamp(visibleTop, 0, s.diagramHeight) * scale;
  const w = clamp(visibleW * scale, 10, drawW);
  const h = clamp(visibleH * scale, 8, drawH);

  viewRect.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  viewRect.style.width = Math.max(10, Math.min(w, mapW - x)) + 'px';
  viewRect.style.height = Math.max(8, Math.min(h, mapH - y)) + 'px';
}

export function clampPan(key) {
  const s = state[key];
  if (!s || !s.diagramWidth || !s.diagramHeight) return;
  const { vp } = getParts(key);
  const contentWidth = (s.diagramWidth + CANVAS_PADDING * 2) * s.zoom;
  const contentHeight = (s.diagramHeight + CANVAS_PADDING * 2) * s.zoom;

  if (contentWidth <= vp.clientWidth) {
    s.panX = (vp.clientWidth - contentWidth) / 2;
  } else {
    s.panX = clamp(s.panX, vp.clientWidth - contentWidth, 0);
  }

  if (contentHeight <= vp.clientHeight) {
    s.panY = (vp.clientHeight - contentHeight) / 2;
  } else {
    s.panY = clamp(s.panY, vp.clientHeight - contentHeight, 0);
  }
}

export function setZoomAt(key, newZoom, originX, originY, animate) {
  const s = state[key];
  if (!s || !s.diagramWidth || !s.diagramHeight) return;
  const nextZoom = clamp(newZoom, MIN_ZOOM, MAX_ZOOM);
  const anchorX = clamp((originX - s.panX) / s.zoom - CANVAS_PADDING, 0, s.diagramWidth) + CANVAS_PADDING;
  const anchorY = clamp((originY - s.panY) / s.zoom - CANVAS_PADDING, 0, s.diagramHeight) + CANVAS_PADDING;
  s.panX = originX - anchorX * nextZoom;
  s.panY = originY - anchorY * nextZoom;
  s.zoom = nextZoom;
  setAnimated(key, Boolean(animate));
  clampPan(key);
  updateTransform(key);
}

export function zoomBy(key, factor, animate) {
  const s = state[key];
  if (!s || !s.initialized) return;
  const { vp } = getParts(key);
  setZoomAt(key, s.zoom * factor, vp.clientWidth / 2, vp.clientHeight / 2, animate);
}

export function fitToViewport(key, animate = false) {
  const s = state[key];
  if (!s || !s.diagramWidth || !s.diagramHeight) return;
  const { vp } = getParts(key);
  const availableWidth = Math.max(1, vp.clientWidth - CANVAS_PADDING * 2);
  const availableHeight = Math.max(1, vp.clientHeight - CANVAS_PADDING * 2);
  const overviewZoom = Math.min(1, availableWidth / s.diagramWidth, availableHeight / s.diagramHeight);
  const fitZoom = clamp(Math.max(overviewZoom, MIN_READABLE_ZOOM), MIN_ZOOM, MAX_ZOOM);

  s.zoom = fitZoom;
  if (fitZoom > overviewZoom) {
    s.panX = CANVAS_PADDING;
    s.panY = CANVAS_PADDING;
  } else {
    s.panX = (vp.clientWidth - s.diagramWidth * fitZoom) / 2 - CANVAS_PADDING * fitZoom;
    s.panY = (vp.clientHeight - s.diagramHeight * fitZoom) / 2 - CANVAS_PADDING * fitZoom;
  }
  setAnimated(key, animate);
  updateTransform(key);
}

export function panBy(key, dx, dy) {
  const s = state[key];
  if (!s || !s.initialized) return;
  s.panX += dx;
  s.panY += dy;
  clampPan(key);
  updateTransform(key);
}

export function jumpFromMiniMap(key, event) {
  const s = state[key];
  if (!s || !s.initialized) return;
  const { vp, miniMap } = getParts(key);
  const rect = miniMap.getBoundingClientRect();
  const mapW = miniMap.clientWidth;
  const mapH = miniMap.clientHeight;
  const scale = Math.min(mapW / s.diagramWidth, mapH / s.diagramHeight);
  const drawW = s.diagramWidth * scale;
  const drawH = s.diagramHeight * scale;
  const offsetX = (mapW - drawW) / 2;
  const offsetY = (mapH - drawH) / 2;
  const diagramX = clamp((event.clientX - rect.left - offsetX) / scale, 0, s.diagramWidth);
  const diagramY = clamp((event.clientY - rect.top - offsetY) / scale, 0, s.diagramHeight);

  s.panX = vp.clientWidth / 2 - (diagramX + CANVAS_PADDING) * s.zoom;
  s.panY = vp.clientHeight / 2 - (diagramY + CANVAS_PADDING) * s.zoom;
  setAnimated(key, true);
  clampPan(key);
  updateTransform(key);
  vp.focus({ preventScroll: true });
}

export async function toggleFullscreen(key) {
  const { vp } = getParts(key);
  if (document.fullscreenElement === vp) {
    await document.exitFullscreen();
  } else {
    await vp.requestFullscreen();
  }
}

export function attachViewportControls(vp) {
  const key = keyFromViewport(vp);

  vp.addEventListener('pointerenter', () => markActive(key));
  vp.addEventListener('focus', () => markActive(key));

  vp.addEventListener('wheel', (event) => {
    event.preventDefault();
    const s = state[key];
    if (!s || !s.initialized) return;
    markActive(key);
    s.wheelEvent = event;
    if (s.wheelFrame) return;
    s.wheelFrame = requestAnimationFrame(() => {
      const wheelEvent = s.wheelEvent;
      s.wheelFrame = 0;
      const rect = vp.getBoundingClientRect();
      const cursorX = wheelEvent.clientX - rect.left;
      const cursorY = wheelEvent.clientY - rect.top;
      const zoomFactor = 1 + Math.min(0.12, Math.abs(wheelEvent.deltaY) * 0.0012);
      setZoomAt(key, wheelEvent.deltaY < 0 ? s.zoom * zoomFactor : s.zoom / zoomFactor, cursorX, cursorY, false);
    });
  }, { passive: false });

  vp.addEventListener('pointerdown', (event) => {
    const s = state[key];
    if (!s || !s.initialized) return;
    if (event.target.closest('.floating-controls') || event.target.closest('.mini-map')) return;
    if (!isSpaceHeld() && event.button !== 1) return;
    event.preventDefault();
    markActive(key);
    s.dragging = true;
    s.pointerId = event.pointerId;
    s.lastX = event.clientX;
    s.lastY = event.clientY;
    vp.classList.add('grabbing');
    vp.setPointerCapture(event.pointerId);
  });

  vp.addEventListener('pointermove', (event) => {
    const s = state[key];
    if (!s || !s.dragging || s.pointerId !== event.pointerId) return;
    panBy(key, event.clientX - s.lastX, event.clientY - s.lastY);
    s.lastX = event.clientX;
    s.lastY = event.clientY;
  });

  function endDrag(event) {
    const s = state[key];
    if (!s || !s.dragging || (event.pointerId && s.pointerId !== event.pointerId)) return;
    s.dragging = false;
    s.pointerId = null;
    vp.classList.remove('grabbing');
  }

  vp.addEventListener('pointerup', endDrag);
  vp.addEventListener('pointercancel', endDrag);
  vp.addEventListener('lostpointercapture', endDrag);

  vp.addEventListener('dblclick', (event) => {
    if (event.target.closest('.floating-controls') || event.target.closest('.mini-map')) return;
    fitToViewport(key, true);
  });

  vp.addEventListener('input', (event) => {
    if (!event.target.matches('.zoom-slider')) return;
    setZoomAt(key, Number(event.target.value) / 100, vp.clientWidth / 2, vp.clientHeight / 2, false);
  });

  vp.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'fit') {
      fitToViewport(key, true);
      return;
    }
    if (action === 'fullscreen') {
      toggleFullscreen(key).catch((error) => console.warn(error));
      return;
    }
    if (event.target.closest('.mini-map')) {
      jumpFromMiniMap(key, event);
    }
  });
}
