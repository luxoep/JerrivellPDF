// SPDX-License-Identifier: MIT OR Apache-2.0
// Original geometry and user-supplied text; no third-party artwork or bundled font.
export type StampShape = 'round' | 'rectangle';

export const DEFAULT_FONT_FAMILY = 'Microsoft YaHei UI';
export function cssFontFamily(family: string): string {
  const safe = family.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 128).trim() || DEFAULT_FONT_FAMILY;
  return `${JSON.stringify(safe)}, sans-serif`;
}

/** Wait for WebView's font resolution before measuring or drawing the export. */
export async function ensureFontReady(family: string, sample: string, bold = false, italic = false): Promise<void> {
  if (!document.fonts) return;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      document.fonts.load(`${italic ? 'italic ' : ''}${bold ? '600' : '400'} 24px ${cssFontFamily(family)}`, sample.slice(0, 300) || 'Aa 中文'),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('FONT_LOAD_TIMEOUT')), 8000); }),
    ]);
  } finally { if (timeout !== undefined) clearTimeout(timeout); }
}

function surface(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('CANVAS_UNAVAILABLE');
  return [canvas, context];
}

function fittedText(context: CanvasRenderingContext2D, text: string, fontSize: number, maxWidth: number, weight = '600', selectedFamily = DEFAULT_FONT_FAMILY) {
  const family = cssFontFamily(selectedFamily);
  let size = fontSize;
  context.font = `${weight} ${size}px ${family}`;
  while (context.measureText(text).width > maxWidth && size > 10) {
    size -= 1; context.font = `${weight} ${size}px ${family}`;
  }
}

export interface TextLayoutOptions {
  italic?: boolean;
  underline?: boolean;
  strikeout?: boolean;
  alignment?: 'left' | 'center' | 'right';
  charSpacing?: number;
  lineHeight?: number;
  /** Fixed text box width in PDF points; absent means natural line width. */
  wrapWidth?: number;
}
export interface TextOverlaySource extends TextLayoutOptions {
  content: string;
  color: string;
  fontSize: number;
  bold: boolean;
  fontFamily: string;
}

function graphemes(text: string): string[] {
  return typeof Intl.Segmenter === 'function'
    ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), item => item.segment)
    : Array.from(text);
}

/** Layout never silently drops text or reduces the requested point size. */
export function createTextPng(text: string, color: string, fontSize: number, bold: boolean, family = DEFAULT_FONT_FAMILY, options: TextLayoutOptions = {}): { dataUrl: string; width: number; height: number; lineCount: number } {
  if (!text.trim() || text.length > 4000 || !Number.isFinite(fontSize) || fontSize < 6 || fontSize > 144) throw new Error('TEXT_LAYOUT_LIMIT');
  const spacing = options.charSpacing ?? 0, leading = options.lineHeight ?? 1.45, wrap = options.wrapWidth;
  if (!Number.isFinite(spacing) || spacing < -2 || spacing > 20 || !Number.isFinite(leading) || leading < .8 || leading > 3 || (wrap !== undefined && (!Number.isFinite(wrap) || wrap < 24 || wrap > 1800))) throw new Error('TEXT_LAYOUT_LIMIT');
  const size = fontSize * 2, padding = Math.ceil(Math.max(16, size * .25));
  const [canvas, context] = surface(1, 1);
  const font = `${options.italic ? 'italic ' : ''}${bold ? '600' : '400'} ${size}px ${cssFontFamily(family)}`;
  context.font = font;
  const measure = (line: string) => context.measureText(line).width + Math.max(0, graphemes(line).length - 1) * spacing * 2;
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (!wrap || measure(paragraph) <= wrap * 2) { lines.push(paragraph); continue; }
    let remaining = graphemes(paragraph);
    while (remaining.length) {
      let end = 1;
      while (end < remaining.length && measure(remaining.slice(0, end + 1).join('')) <= wrap * 2) end++;
      if (end < remaining.length) {
        const wordBreak = remaining.slice(0, end).map((value, index) => /\s/u.test(value) ? index + 1 : 0).filter(Boolean).at(-1);
        if (wordBreak) end = wordBreak;
      }
      const line = remaining.slice(0, end).join('');
      if (measure(line) > wrap * 2 + .01) throw new Error('TEXT_BOX_TOO_NARROW');
      lines.push(line); remaining = remaining.slice(end);
    }
  }
  const widths = lines.map(measure), bodyWidth = wrap ? wrap * 2 : Math.max(1, ...widths);
  const width = Math.ceil(bodyWidth + padding * 2), height = Math.ceil(Math.max(size * 1.3, (lines.length - 1) * size * leading + size * 1.3) + padding * 2);
  if (lines.length > 80 || width > 4096 || height > 8192 || width * height > 8000000) throw new Error('TEXT_LAYOUT_LIMIT');
  canvas.width = width; canvas.height = height;
  context.font = font; context.fillStyle = color; context.strokeStyle = color; context.textBaseline = 'alphabetic';
  context.lineWidth = Math.max(1, size / 18);
  lines.forEach((line, index) => {
    const lineWidth = widths[index], offset = options.alignment === 'center' ? (bodyWidth - lineWidth) / 2 : options.alignment === 'right' ? bodyWidth - lineWidth : 0;
    const x = padding + offset, y = padding + size + index * size * leading;
    if (spacing === 0) context.fillText(line, x, y);
    else {
      let cursor = x;
      const clusters = graphemes(line);
      clusters.forEach((cluster, clusterIndex) => {
        context.fillText(cluster, cursor, y);
        // Prefix differences preserve the browser's measured advance/kerning.
        cursor = x + context.measureText(clusters.slice(0, clusterIndex + 1).join('')).width + (clusterIndex + 1) * spacing * 2;
      });
    }
    for (const decoratedY of [options.underline ? y + size * .1 : null, options.strikeout ? y - size * .33 : null]) {
      if (decoratedY !== null && lineWidth > 0) { context.beginPath(); context.moveTo(x, decoratedY); context.lineTo(x + lineWidth, decoratedY); context.stroke(); }
    }
  });
  return { dataUrl: canvas.toDataURL('image/png'), width, height, lineCount: lines.length };
}

function star(context: CanvasRenderingContext2D, cx: number, cy: number, radius: number) {
  context.beginPath();
  for (let index = 0; index < 10; index++) {
    const angle = -Math.PI / 2 + index * Math.PI / 5;
    const length = index % 2 === 0 ? radius : radius * 0.4;
    const x = cx + Math.cos(angle) * length, y = cy + Math.sin(angle) * length;
    if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
  }
  context.closePath(); context.fill();
}

export function createStampPng(title: string, subtitle: string, color: string, shape: StampShape, family = DEFAULT_FONT_FAMILY) {
  const width = shape === 'round' ? 900 : 1100;
  const height = shape === 'round' ? 900 : 460;
  const [canvas, context] = surface(width, height);
  context.strokeStyle = color; context.fillStyle = color; context.lineWidth = 14;
  context.textAlign = 'center'; context.textBaseline = 'middle';
  if (shape === 'round') {
    context.beginPath(); context.arc(450, 450, 400, 0, Math.PI * 2); context.stroke();
    context.lineWidth = 4; context.beginPath(); context.arc(450, 450, 372, 0, Math.PI * 2); context.stroke();
    const characters = Array.from(title).slice(0, 24);
    const spread = Math.min(Math.PI * 1.22, 0.19 * Math.max(1, characters.length - 1));
    context.font = `${characters.length > 18 ? 40 : 49}px ${cssFontFamily(family)}`;
    characters.forEach((character, index) => {
      const angle = -Math.PI / 2 - spread / 2 + (characters.length === 1 ? spread / 2 : spread * index / (characters.length - 1));
      context.save(); context.translate(450 + Math.cos(angle) * 318, 450 + Math.sin(angle) * 318);
      context.rotate(angle + Math.PI / 2); context.fillText(character, 0, 0); context.restore();
    });
    star(context, 450, 440, 110);
    fittedText(context, subtitle, 52, 540, '600', family);
    context.fillText(subtitle, 450, 640);
  } else {
    context.strokeRect(30, 30, width - 60, height - 60);
    context.lineWidth = 3; context.strokeRect(52, 52, width - 104, height - 104);
    fittedText(context, title, 105, width - 140, '600', family); context.fillText(title, width / 2, subtitle ? 185 : height / 2);
    if (subtitle) { fittedText(context, subtitle, 55, width - 140, '400', family); context.fillText(subtitle, width / 2, 305); }
  }
  return { dataUrl: canvas.toDataURL('image/png'), width, height };
}

export function createShapePng(color: string, style: 'highlight' | 'rectangle' | 'block') {
  const [canvas, context] = surface(1000, style === 'highlight' ? 170 : 600);
  if (style === 'highlight') { context.globalAlpha = 0.30; context.fillStyle = color; context.fillRect(0, 0, canvas.width, canvas.height); }
  else if (style === 'block') { context.fillStyle = color; context.fillRect(0, 0, canvas.width, canvas.height); }
  else { context.strokeStyle = color; context.lineWidth = 10; context.strokeRect(7, 7, canvas.width - 14, canvas.height - 14); }
  return { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height };
}

export function trimmedSignature(canvas: HTMLCanvasElement): { dataUrl: string; width: number; height: number } | null {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  let left = canvas.width, top = canvas.height, right = -1, bottom = -1;
  for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
    if (data[(y * canvas.width + x) * 4 + 3] > 0) {
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  }
  if (right < left) return null;
  const padding = 22;
  const [result, output] = surface(right - left + 1 + padding * 2, bottom - top + 1 + padding * 2);
  output.drawImage(canvas, left, top, right - left + 1, bottom - top + 1, padding, padding, right - left + 1, bottom - top + 1);
  return { dataUrl: result.toDataURL('image/png'), width: result.width, height: result.height };
}
