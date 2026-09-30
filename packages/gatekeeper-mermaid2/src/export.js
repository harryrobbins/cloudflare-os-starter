import { renderASCII } from './engine.js';

const mimeTypes = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

function download(blob, extension) { return { blob, extension }; }

async function rasterize(svgText, scale, opaque) {
  const svg = new DOMParser().parseFromString(svgText, 'image/svg+xml').documentElement;
  if (svg.localName !== 'svg') throw new Error('This diagram is not a valid SVG.');
  for (const image of svg.querySelectorAll('image')) {
    const href = image.getAttribute('href') || image.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
    if (href && !href.startsWith('data:') && !href.startsWith('#')) {
      throw new Error('Image/PDF export needs embedded images. Remove external image references or export SVG instead.');
    }
  }
  const viewBox = svg.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  const width = viewBox?.[2] || parseFloat(svg.getAttribute('width'));
  const height = viewBox?.[3] || parseFloat(svg.getAttribute('height'));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('Could not determine the diagram dimensions.');
  const pixelWidth = Math.ceil(width * scale);
  const pixelHeight = Math.ceil(height * scale);
  if (pixelWidth > 16384 || pixelHeight > 16384 || pixelWidth * pixelHeight > 32_000_000) {
    throw new Error('This image is too large at the selected resolution. Choose a lower export scale or export SVG.');
  }
  svg.setAttribute('width', String(pixelWidth));
  svg.setAttribute('height', String(pixelHeight));
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Your browser could not create an image canvas.');
    if (opaque) { context.fillStyle = '#ffffff'; context.fillRect(0, 0, pixelWidth, pixelHeight); }
    context.drawImage(image, 0, 0, pixelWidth, pixelHeight);
    return canvas;
  } finally { URL.revokeObjectURL(url); }
}

export async function exportDiagram(result, format, scale = 2) {
  if (format === 'svg') return download(new Blob([result.svg], { type: 'image/svg+xml' }), 'svg');
  if (format === 'd2') return download(new Blob([result.d2Source], { type: 'text/plain;charset=utf-8' }), 'd2');
  if (format === 'source') return download(new Blob([result.source], { type: 'text/plain;charset=utf-8' }), result.language === 'mermaid' ? 'mmd' : 'd2');
  if (format === 'ascii') {
    const text = await renderASCII(result.diagram, result.renderOptions);
    return download(new Blob([text], { type: 'text/plain;charset=utf-8' }), 'txt');
  }
  if (format === 'json') return download(new Blob([JSON.stringify({ layout: result.layout, language: result.language, diagram: result.diagram }, null, 2)], { type: 'application/json' }), 'json');
  if (!['png', 'jpeg', 'webp', 'pdf'].includes(format)) throw new Error('Unknown export format.');
  const canvas = await rasterize(result.svg, scale, format === 'jpeg' || format === 'pdf');
  if (format === 'pdf') {
    const { jsPDF } = await import('jspdf');
    // Keep the entire diagram on one page with its original aspect ratio.
    const ratio = Math.min(0.75, 14000 / Math.max(canvas.width, canvas.height));
    const width = canvas.width * ratio;
    const height = canvas.height * ratio;
    const pdf = new jsPDF({ orientation: width > height ? 'landscape' : 'portrait', unit: 'pt', format: [width, height], compress: true });
    pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, width, height);
    return download(pdf.output('blob'), 'pdf');
  }
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, mimeTypes[format], 0.94));
  if (!blob || blob.type !== mimeTypes[format]) throw new Error(`Your browser does not support ${format.toUpperCase()} export.`);
  return download(blob, format === 'jpeg' ? 'jpg' : format);
}
