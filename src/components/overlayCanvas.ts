// SPDX-License-Identifier: MIT OR Apache-2.0
// Original geometry and user-supplied text; no third-party artwork or bundled font.
export type StampShape = 'round' | 'rectangle';

export const DEFAULT_FONT_FAMILY = 'Century Gothic';
export const finishInlineTextEvent = 'jerrivell-finish-inline-text';
const DEFAULT_FONT_FALLBACKS = ['Microsoft YaHei UI', 'Microsoft YaHei', '微软雅黑', 'Segoe UI', 'Arial'];

export function preferredSystemFont(families: string[]): string | undefined {
  const byName = new Map(families.map(family => [family.toLowerCase(), family]));
  return [DEFAULT_FONT_FAMILY, ...DEFAULT_FONT_FALLBACKS].map(family => byName.get(family.toLowerCase())).find(Boolean) ?? families[0];
}

export function cssFontFamily(family: string): string {
  const safe = family.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 128).trim() || DEFAULT_FONT_FAMILY;
  const stack = safe.toLowerCase() === DEFAULT_FONT_FAMILY.toLowerCase() ? [safe, ...DEFAULT_FONT_FALLBACKS] : [safe];
  return `${stack.map(value => JSON.stringify(value)).join(', ')}, sans-serif`;
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
  /** Explicit padding in PDF points. Absent preserves pre-0.8.5 project layout. */
  padding?: number;
  /** Text container in PDF points, including transparent insets. It never scales glyphs. */
  frame?: { width: number; height: number; autoHeight: boolean };
}
export interface TextOverlaySource extends TextLayoutOptions {
  content: string;
  color: string;
  fontSize: number;
  bold: boolean;
  fontFamily: string;
}
/** Positions are PDF points, including the text container's transparent inset. */
export interface TextLayoutLine { text: string; x: number; y: number; width: number; decorationX?: number }
export interface TextPngResult {
  dataUrl: string; width: number; height: number; lineCount: number;
  requiredHeight: number; requiredWidth?: number; overflow: boolean; layoutLines: TextLayoutLine[];
}

function graphemes(text: string): string[] {
  return typeof Intl.Segmenter === 'function'
    ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), item => item.segment)
    : Array.from(text);
}

/** Layout never silently drops text or reduces the requested point size. */
export function createTextPng(text: string, color: string, fontSize: number, bold: boolean, family = DEFAULT_FONT_FAMILY, options: TextLayoutOptions = {}, measureOnly = false): TextPngResult {
  if (!text.trim() || text.length > 4000 || !Number.isFinite(fontSize) || fontSize < 6 || fontSize > 144) throw new Error('TEXT_LAYOUT_LIMIT');
  if (options.padding !== undefined) return createCompactTextPng(text, color, fontSize, bold, family, options, measureOnly);
  const spacing = options.charSpacing ?? 0, leading = options.lineHeight ?? 1.45;
  const frame = options.frame;
  if (frame && (![frame.width, frame.height].every(Number.isFinite) || frame.width < 24 || frame.width > 2048 || frame.height < 12 || frame.height > 4096 || typeof frame.autoHeight !== 'boolean')) throw new Error('TEXT_LAYOUT_LIMIT');
  const size = fontSize * 2, padding = Math.ceil(Math.max(16, size * .25));
  const wrap = frame ? Math.max(.5, frame.width - padding) : options.wrapWidth;
  if (!Number.isFinite(spacing) || spacing < -2 || spacing > 20 || !Number.isFinite(leading) || leading < .8 || leading > 3 || (wrap !== undefined && (!Number.isFinite(wrap) || wrap <= 0 || (!frame && (wrap < 24 || wrap > 1800)) || wrap > 2048))) throw new Error('TEXT_LAYOUT_LIMIT');
  const [canvas, context] = surface(1, 1);
  const font = `${options.italic ? 'italic ' : ''}${bold ? '600' : '400'} ${size}px ${cssFontFamily(family)}`;
  context.font = font;
  const measured = new Map<string, number>();
  const measure = (line: string) => {
    const cached = measured.get(line); if (cached !== undefined) return cached;
    const width = context.measureText(line).width + Math.max(0, graphemes(line).length - 1) * spacing * 2;
    measured.set(line, width); return width;
  };
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (!wrap || measure(paragraph) <= wrap * 2) { lines.push(paragraph); continue; }
    let remaining = graphemes(paragraph);
    while (remaining.length) {
      // Search line length in logarithmic measurement steps while dragging a box.
      let low = 1, high = remaining.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (measure(remaining.slice(0, middle).join('')) <= wrap * 2) low = middle; else high = middle - 1;
      }
      let end = low;
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
  const width = Math.ceil(frame ? frame.width * 2 : bodyWidth + padding * 2);
  const requiredPixels = Math.ceil(Math.max(size * 1.3, (lines.length - 1) * size * leading + size * 1.3) + padding * 2);
  const height = frame && !frame.autoHeight ? Math.ceil(frame.height * 2) : requiredPixels;
  const overflow = requiredPixels > height;
  const layoutLines = lines.map((line, index) => {
    const lineWidth = widths[index], offset = options.alignment === 'center' ? (bodyWidth - lineWidth) / 2 : options.alignment === 'right' ? bodyWidth - lineWidth : 0;
    return { text: line, x: (padding + offset) / 2, y: (padding + size + index * size * leading) / 2, width: lineWidth / 2 };
  });
  if (lines.length > 80 || width > 4096 || height > 8192 || width * height > 8000000) throw new Error('TEXT_LAYOUT_LIMIT');
  // Interactive resizing only measures a 1×1 surface. Rasterization/PNG encoding
  // happens once when the gesture is committed, never on each pointer move.
  if (measureOnly) return { dataUrl: '', width, height, lineCount: lines.length, requiredHeight: requiredPixels / 2, overflow, layoutLines };
  canvas.width = width; canvas.height = height;
  context.font = font; context.fillStyle = color; context.strokeStyle = color; context.textBaseline = 'alphabetic';
  context.lineWidth = Math.max(1, size / 18);
  layoutLines.forEach(position => {
    const line = position.text, lineWidth = position.width * 2, x = position.x * 2, y = position.y * 2;
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
  return { dataUrl: canvas.toDataURL('image/png'), width, height, lineCount: lines.length, requiredHeight: requiredPixels / 2, overflow, layoutLines };
}

/** Tight glyph bounds let a zero-padding frame reach the PDF edge without
 * clipping accents, italic overhangs, descenders or text decorations. */
function createCompactTextPng(text: string, color: string, fontSize: number, bold: boolean, family: string, options: TextLayoutOptions, measureOnly: boolean): TextPngResult {
  const spacing = options.charSpacing ?? 0, leading = options.lineHeight ?? 1.45, padding = options.padding! * 2;
  const frame = options.frame, size = fontSize * 2;
  if (!Number.isFinite(padding) || padding < 0 || padding > 48 || !Number.isFinite(spacing) || spacing < -2 || spacing > 20 || !Number.isFinite(leading) || leading < .8 || leading > 3
    || frame && (![frame.width, frame.height].every(Number.isFinite) || frame.width < 1 || frame.width > 2048 || frame.height < 1 || frame.height > 4096 || typeof frame.autoHeight !== 'boolean')) throw new Error('TEXT_LAYOUT_LIMIT');
  const wrap = frame ? frame.width * 2 - 2 * padding : options.wrapWidth === undefined ? undefined : options.wrapWidth * 2;
  if (wrap !== undefined && (!Number.isFinite(wrap) || wrap <= 0 || wrap > 4096)) throw new Error('TEXT_BOX_TOO_NARROW');
  const [canvas, context] = surface(1, 1);
  const font = `${options.italic ? 'italic ' : ''}${bold ? '600' : '400'} ${size}px ${cssFontFamily(family)}`;
  context.font = font;
  const finiteMetric = (number: number | undefined, fallback: number) => Number.isFinite(number) ? number! : fallback;
  const sample = context.measureText('Hg国'), fallbackAscent = finiteMetric(sample.actualBoundingBoxAscent, size * .8), fallbackDescent = finiteMetric(sample.actualBoundingBoxDescent, size * .2);
  type Metrics = { left: number; width: number; ascent: number; descent: number };
  const cache = new Map<string, Metrics>();
  const measure = (value: string): Metrics => {
    const known = cache.get(value); if (known) return known;
    const glyphs = graphemes(value), metric = context.measureText(value);
    let left = -finiteMetric(metric.actualBoundingBoxLeft, 0), right = finiteMetric(metric.actualBoundingBoxRight, metric.width);
    let ascent = finiteMetric(metric.actualBoundingBoxAscent, fallbackAscent), descent = finiteMetric(metric.actualBoundingBoxDescent, fallbackDescent);
    if (spacing && glyphs.length) {
      left = Infinity; right = -Infinity; ascent = descent = -Infinity;
      let cursor = 0;
      glyphs.forEach((glyph, index) => {
        const box = context.measureText(glyph);
        if (glyph.trim()) {
          left = Math.min(left, cursor - finiteMetric(box.actualBoundingBoxLeft, 0));
          right = Math.max(right, cursor + finiteMetric(box.actualBoundingBoxRight, box.width));
          ascent = Math.max(ascent, finiteMetric(box.actualBoundingBoxAscent, fallbackAscent)); descent = Math.max(descent, finiteMetric(box.actualBoundingBoxDescent, fallbackDescent));
        }
        cursor = context.measureText(glyphs.slice(0, index + 1).join('')).width + (index + 1) * spacing * 2;
      });
    }
    if (!value.trim()) { left = 0; right = metric.width + Math.max(0, glyphs.length - 1) * spacing * 2; ascent = fallbackAscent; descent = fallbackDescent; }
    else {
      const start = value.match(/^\s+/u)?.[0] ?? '', end = value.match(/\s+$/u)?.[0] ?? '';
      // Preserve intentional indentation/trailing spaces while removing glyph bearings.
      left -= context.measureText(start).width + graphemes(start).length * spacing * 2;
      right += context.measureText(end).width + graphemes(end).length * spacing * 2;
    }
    const result = { left, width: Math.max(0, right - left), ascent, descent }; cache.set(value, result); return result;
  };
  const lines: string[] = [];
  const append = (line: string) => { lines.push(line); if (lines.length > 80) throw new Error('TEXT_LAYOUT_LIMIT'); };
  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (wrap === undefined || measure(paragraph).width <= wrap + .001) { append(paragraph); continue; }
    let remaining = graphemes(paragraph);
    while (remaining.length) {
      let low = 1, high = remaining.length;
      while (low < high) { const middle = Math.ceil((low + high) / 2); if (measure(remaining.slice(0, middle).join('')).width <= wrap + .001) low = middle; else high = middle - 1; }
      let end = low;
      if (end < remaining.length) { const wordBreak = remaining.slice(0, end).map((value, index) => /\s/u.test(value) ? index + 1 : 0).filter(Boolean).at(-1); if (wordBreak) end = wordBreak; }
      const line = remaining.slice(0, end).join(''); if (measure(line).width > wrap + .001) throw new Error('TEXT_BOX_TOO_NARROW');
      append(line); remaining = remaining.slice(end);
    }
  }
  const metrics = lines.map(measure), contentWidth = Math.max(1, ...metrics.map(value => value.width));
  const bodyWidth = wrap ?? contentWidth, stroke = Math.max(1, size / 18);
  let top = Infinity, bottom = -Infinity;
  metrics.forEach((box, index) => {
    const baseline = index * size * leading;
    top = Math.min(top, baseline - box.ascent, options.strikeout ? baseline - size * .33 - stroke / 2 : Infinity);
    bottom = Math.max(bottom, baseline + box.descent, options.underline ? baseline + size * .1 + stroke / 2 : -Infinity);
  });
  const requiredPixels = Math.max(2, Math.ceil(bottom - top + padding * 2)), requiredWidth = Math.max(2, Math.ceil(contentWidth + padding * 2)) / 2;
  const width = Math.max(2, Math.ceil(frame ? frame.width * 2 : bodyWidth + padding * 2)), height = frame && !frame.autoHeight ? Math.ceil(frame.height * 2) : requiredPixels;
  if (width > 4096 || height > 8192 || width * height > 8000000) throw new Error('TEXT_LAYOUT_LIMIT');
  const layoutLines: TextLayoutLine[] = lines.map((line, index) => {
    const box = metrics[index], offset = options.alignment === 'center' ? (bodyWidth - box.width) / 2 : options.alignment === 'right' ? bodyWidth - box.width : 0;
    return { text: line, x: (padding + offset - box.left) / 2, decorationX: (padding + offset) / 2, y: (padding - top + index * size * leading) / 2, width: box.width / 2 };
  });
  const result = { width, height, lineCount: lines.length, requiredHeight: requiredPixels / 2, requiredWidth, overflow: requiredPixels > height, layoutLines };
  if (measureOnly) return { ...result, dataUrl: '' };
  canvas.width = width; canvas.height = height; context.font = font; context.fillStyle = color; context.strokeStyle = color; context.textBaseline = 'alphabetic'; context.lineWidth = stroke;
  for (const line of layoutLines) {
    const x = line.x * 2, y = line.y * 2;
    if (!spacing) context.fillText(line.text, x, y);
    else { let cursor = x; const clusters = graphemes(line.text); clusters.forEach((cluster, index) => { context.fillText(cluster, cursor, y); cursor = x + context.measureText(clusters.slice(0, index + 1).join('')).width + (index + 1) * spacing * 2; }); }
    for (const decoratedY of [options.underline ? y + size * .1 : null, options.strikeout ? y - size * .33 : null]) if (decoratedY !== null && line.width > 0) {
      const start = (line.decorationX ?? line.x) * 2; context.beginPath(); context.moveTo(start, decoratedY); context.lineTo(start + line.width * 2, decoratedY); context.stroke();
    }
  }
  return { ...result, dataUrl: canvas.toDataURL('image/png') };
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
