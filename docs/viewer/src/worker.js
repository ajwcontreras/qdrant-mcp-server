import { expose } from 'comlink';

async function getSvgSize(src) {
  const response = await fetch(src);
  if (!response.ok) {
    throw new Error(`Could not load ${src}`);
  }

  const svgText = await response.text();
  const viewBox = extractViewBox(svgText);
  if (!viewBox) {
    throw new Error(`Missing viewBox in ${src}`);
  }

  const values = viewBox.trim().split(/[\s,]+/).map(Number);
  if (values.length < 4 || values.some((value) => Number.isNaN(value))) {
    throw new Error(`Invalid viewBox in ${src}`);
  }

  return {
    width: values[2],
    height: values[3]
  };
}

function extractViewBox(svgText) {
  if (typeof DOMParser !== 'undefined') {
    const svg = new DOMParser().parseFromString(svgText, 'image/svg+xml').documentElement;
    return svg.getAttribute('viewBox');
  }

  return svgText.match(/\sviewBox=(["'])(.*?)\1/i)?.[2] || null;
}

expose({ getSvgSize });
