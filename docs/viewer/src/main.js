import { wrap } from 'comlink';
import './style.css';
import { attachViewportControls, fitToViewport } from './controls.js';
import { attachKeyboardHandlers } from './keyboard.js';
import {
  RESIZE_DEBOUNCE_MS,
  createViewportState,
  getParts,
  keyFromViewport,
  state
} from './state.js';

const WORKER_IDLE_TIMEOUT_MS = 10_000;

class SvgWorkerBridge {
  _queue = Promise.resolve();
  _worker = null;
  _workerApi = null;
  _workerTimeout = 0;

  _startWorker() {
    this._worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this._workerApi = wrap(this._worker);
  }

  _terminateWorker() {
    if (this._workerTimeout) {
      clearTimeout(this._workerTimeout);
      this._workerTimeout = 0;
    }
    if (!this._worker) return;
    this._worker.terminate();
    this._worker = null;
    this._workerApi = null;
  }

  getSvgSize(signal, src) {
    this._queue = this._queue
      .catch(() => {})
      .then(async () => {
        if (signal.aborted) throw new DOMException('AbortError', 'AbortError');

        clearTimeout(this._workerTimeout);
        this._workerTimeout = 0;
        if (!this._worker) this._startWorker();

        const onAbort = () => this._terminateWorker();
        signal.addEventListener('abort', onAbort, { once: true });

        try {
          return await this._workerApi.getSvgSize(src);
        } finally {
          signal.removeEventListener('abort', onAbort);
          this._workerTimeout = window.setTimeout(() => {
            this._terminateWorker();
          }, WORKER_IDLE_TIMEOUT_MS);
        }
      });

    return this._queue;
  }
}

const svgWorker = new SvgWorkerBridge();
const assetUrls = {
  'data_models.svg': new URL('../data_models.svg', import.meta.url).href,
  'data_flows.svg': new URL('../data_flows.svg', import.meta.url).href,
  'data_pipelines.svg': new URL('../data_pipelines.svg', import.meta.url).href
};

let resizeTimer = 0;

function createSvgObject(src, className, label) {
  const object = document.createElement('object');
  object.type = 'image/svg+xml';
  object.data = src;
  object.className = className;
  object.tabIndex = -1;
  object.setAttribute('aria-label', label);
  return object;
}

async function loadDiagramSize(key) {
  const s = state[key];
  if (s.loading || s.initialized) return;
  s.loading = true;
  s.loadAbortController = new AbortController();

  const { vp, canvas, miniMap } = getParts(key);
  const src = assetUrls[vp.dataset.src];
  const label = vp.dataset.label;
  const diagram = createSvgObject(src, 'diagram', label);
  const miniDiagram = createSvgObject(src, '', label);
  miniDiagram.setAttribute('aria-hidden', 'true');

  canvas.append(diagram);
  miniMap.prepend(miniDiagram);

  try {
    const { width, height } = await svgWorker.getSvgSize(s.loadAbortController.signal, src);
    diagram.style.width = width + 'px';
    diagram.style.height = height + 'px';

    s.diagramWidth = width;
    s.diagramHeight = height;
    s.initialized = true;
    vp.classList.add('is-ready');
    fitToViewport(key, false);
  } finally {
    s.loading = false;
    s.loadAbortController = null;
  }
}

function initViewport(vp) {
  const key = keyFromViewport(vp);
  state[key] = createViewportState();
  attachViewportControls(vp);
}

function setupLazyLoading(viewports) {
  if (!('IntersectionObserver' in window)) {
    viewports.forEach((vp) => loadDiagramSize(keyFromViewport(vp)));
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      observer.unobserve(entry.target);
      loadDiagramSize(keyFromViewport(entry.target)).catch((error) => {
        entry.target.querySelector('.loading').textContent = 'Could not load diagram';
        console.error(error);
      });
    });
  }, { rootMargin: '360px 0px' });

  viewports.forEach((vp) => observer.observe(vp));
}

function attachGlobalHandlers() {
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      Object.keys(state).forEach((key) => fitToViewport(key, true));
    }, RESIZE_DEBOUNCE_MS);
  });

  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) return;
    const key = keyFromViewport(document.fullscreenElement);
    window.setTimeout(() => fitToViewport(key, true), 80);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  const viewports = [...document.querySelectorAll('.viewport')];
  viewports.forEach(initViewport);
  setupLazyLoading(viewports);
  attachKeyboardHandlers();
  attachGlobalHandlers();
});
