import {
  KEY_ZOOM_FACTOR,
  PAN_STEP,
  getActiveKey,
  resetHeldKeys,
  setCtrlHeld,
  setSpaceHeld
} from './state.js';
import { fitToViewport, panBy, zoomBy } from './controls.js';

export function attachKeyboardHandlers() {
  document.addEventListener('keydown', (event) => {
    const target = event.target;
    const inFormField = target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
    const isArrowKey = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key);
    if (isArrowKey && target && typeof target.blur === 'function') target.blur();
    if (inFormField && !isArrowKey && !(event.ctrlKey || event.metaKey) && event.key.toLowerCase() !== 'f') return;

    if (event.code === 'Space') {
      event.preventDefault();
      setSpaceHeld(true);
      document.querySelectorAll('.viewport').forEach((vp) => vp.classList.add('space-ready'));
      return;
    }

    setCtrlHeld(event.ctrlKey || event.metaKey);
    const activeKey = getActiveKey();

    if ((event.ctrlKey || event.metaKey) && (event.key === '+' || event.key === '=')) {
      event.preventDefault();
      zoomBy(activeKey, KEY_ZOOM_FACTOR, true);
    } else if ((event.ctrlKey || event.metaKey) && event.key === '-') {
      event.preventDefault();
      zoomBy(activeKey, 1 / KEY_ZOOM_FACTOR, true);
    } else if ((event.ctrlKey || event.metaKey) && event.key === '0') {
      event.preventDefault();
      fitToViewport(activeKey, true);
    } else if (event.key.toLowerCase() === 'f') {
      event.preventDefault();
      fitToViewport(activeKey, true);
    } else if (event.key === 'Escape' && document.fullscreenElement) {
      event.preventDefault();
      document.exitFullscreen().catch((error) => console.warn(error));
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      panBy(activeKey, PAN_STEP, 0);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      panBy(activeKey, -PAN_STEP, 0);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      panBy(activeKey, 0, PAN_STEP);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      panBy(activeKey, 0, -PAN_STEP);
    }
  });

  document.addEventListener('keyup', (event) => {
    if (event.code === 'Space') {
      setSpaceHeld(false);
      document.querySelectorAll('.viewport').forEach((vp) => vp.classList.remove('space-ready'));
    }
    setCtrlHeld(event.ctrlKey || event.metaKey);
  });

  window.addEventListener('blur', resetHeldKeys);
}
