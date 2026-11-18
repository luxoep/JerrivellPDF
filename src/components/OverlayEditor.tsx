// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { Check, ChevronDown, ChevronUp, Copy, Download, FileText, Highlighter, ImagePlus, LoaderCircle, LockKeyhole, PenLine, Plus, RotateCw, Stamp, Trash2, Type, Upload, X } from 'lucide-react';
import { backend, errorMessage, isDesktop } from '../backend';
import { useI18n } from '../i18n';
import type { ImageAsset, PageOverlay, PdfStampImage } from '../types';
import { cleanLibraryName, LibraryError, loadStampLibrary, MAX_LIBRARY_ITEMS, pngFileName, saveStampLibrary } from '../stampLibrary';
import type { LibraryItem, LibraryKind } from '../stampLibrary';
import { createShapePng, createStampPng, createTextPng, DEFAULT_FONT_FAMILY, ensureFontReady, trimmedSignature } from './overlayCanvas';
import type { StampShape } from './overlayCanvas';
import { FontPicker } from './FontPicker';
import { alignedOverlay, duplicatedOverlay, MIN_OVERLAY_SIDE, normalizedOverlay, overlayStep, POINTS_PER_MM, resizeOverlay, rotatedOverlay90, translatedOverlay } from '../overlayGeometry';
import type { PageAlignment } from '../overlayGeometry';
import './overlay-editor.css';
import '../overlayEditor.css';

export type Overlay = PageOverlay;
export type { PageOverlay };
export type RegisteredImage = ImageAsset;
export interface OverlayEditorProps {
  pageWidth: number;
  pageHeight: number;
  overlays: Overlay[];
  onChange: (overlays: Overlay[]) => void;
  disabled?: boolean;
  onError: (message: string) => void;
  onClose: () => void;
  onBusyChange?: (busy: boolean) => void;
  onDrawMarks?: () => void;
  selectedId?: string;
  onSelect?: (id: string) => void;
}

type Tab = 'text' | 'image' | 'mark' | 'stamp' | 'signature' | 'library';
type BlendMode = 'normal' | 'multiply';
export interface PdfStampCrop { x: number; y: number; width: number; height: number }
interface PdfStampSource extends PdfStampImage { sourceKey: string }
interface PdfStampFragment extends PdfStampImage { previewKey: string }

export function pdfStampSourceKey(path: string, page: string): string {
  return JSON.stringify([path, Number(page)]);
}
export function pdfStampPreviewKey(path: string, page: string, crop: PdfStampCrop | null, removeWhite: boolean, trim: boolean): string {
  return JSON.stringify([path, Number(page), crop, removeWhite, trim]);
}
export function pdfStampCropFromPoints(start: { x: number; y: number }, end: { x: number; y: number }): PdfStampCrop | null {
  const clamp = (number: number) => Math.max(0, Math.min(1, number));
  if (![start.x, start.y, end.x, end.y].every(Number.isFinite)) return null;
  const x = Math.min(clamp(start.x), clamp(end.x)), y = Math.min(clamp(start.y), clamp(end.y));
  const width = Math.abs(clamp(end.x) - clamp(start.x)), height = Math.abs(clamp(end.y) - clamp(start.y));
  return width >= 0.005 && height >= 0.005 ? { x, y, width, height } : null;
}

function PdfStampSelection({ image, crop, onChange, disabled }: { image: RegisteredImage; crop: PdfStampCrop | null; onChange: (crop: PdfStampCrop | null) => void; disabled: boolean }) {
  const { t } = useI18n();
  const [ghost, setGhost] = useState<PdfStampCrop | null>(null);
  const gesture = useRef<{ pointerId: number; start: { x: number; y: number }; bounds: DOMRect; last: PdfStampCrop | null } | null>(null);
  const surface = useRef<HTMLDivElement>(null);
  useEffect(() => () => { gesture.current = null; }, []);
  const pointerPoint = (event: ReactPointerEvent<HTMLDivElement>, bounds: DOMRect) => ({ x: (event.clientX - bounds.left) / bounds.width, y: (event.clientY - bounds.top) / bounds.height });
  const rectangle = ghost ?? crop;
  return <div className="oe-pdf-crop-frame oe-checker"><div ref={surface} className={`oe-pdf-crop-surface ${disabled ? 'oe-disabled' : ''}`}
    style={{ width: Math.min(285, 230 * image.width / image.height), aspectRatio: `${image.width}/${image.height}` }}
    role="group" aria-label={t('在 PDF 整页预览上拖动框选内容片段，也可使用下方百分比输入框', 'Drag on this PDF page to select a fragment, or use the percentage fields below')}
    onPointerDown={event => {
      if (disabled || event.button !== 0 || gesture.current || !surface.current) return;
      const bounds = surface.current.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
      gesture.current = { pointerId: event.pointerId, start: pointerPoint(event, bounds), bounds, last: null };
      setGhost(null);
    }}
    onPointerMove={event => {
      const active = gesture.current;
      if (!active || event.pointerId !== active.pointerId) return;
      event.preventDefault();
      active.last = pdfStampCropFromPoints(active.start, pointerPoint(event, active.bounds));
      setGhost(active.last);
    }}
    onPointerUp={event => {
      const active = gesture.current;
      if (!active || active.pointerId !== event.pointerId) return;
      const next = pdfStampCropFromPoints(active.start, pointerPoint(event, active.bounds));
      gesture.current = null; setGhost(null);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      if (!disabled && next) onChange(next);
    }}
    onPointerCancel={event => { if (gesture.current?.pointerId === event.pointerId) { gesture.current = null; setGhost(null); } }}
    onLostPointerCapture={event => { if (gesture.current?.pointerId === event.pointerId) { gesture.current = null; setGhost(null); } }}>
    <img src={image.dataUrl} alt={t('PDF 整页预览，可框选区域', 'PDF page preview with selectable region')} draggable={false} />
    {rectangle && <div className="oe-pdf-crop-rectangle" style={{ left: `${rectangle.x * 100}%`, top: `${rectangle.y * 100}%`, width: `${rectangle.width * 100}%`, height: `${rectangle.height * 100}%` }} />}
  </div></div>;
}


function SignaturePad({ color, disabled, resetKey, onChange }: { color: string; disabled: boolean; resetKey: number; onChange: (canvas: HTMLCanvasElement | null) => void }) {
  const { t } = useI18n();
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawingPointer = useRef<number | null>(null);
  const last = useRef({ x: 0, y: 0 });
  useEffect(() => {
    const surface = canvas.current;
    surface?.getContext('2d')?.clearRect(0, 0, surface.width, surface.height);
    drawingPointer.current = null;
    onChange(null);
    // This is an explicit user reset, not a rerender of the panel.
  }, [resetKey]);
  useEffect(() => () => onChange(null), []);
  const point = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - bounds.left) * 900 / bounds.width, y: (event.clientY - bounds.top) * 300 / bounds.height };
  };
  const start = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (disabled || event.button !== 0 || drawingPointer.current !== null) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    const context = event.currentTarget.getContext('2d');
    if (!context) return;
    drawingPointer.current = event.pointerId; last.current = point(event);
    context.fillStyle = color; context.beginPath(); context.arc(last.current.x, last.current.y, 2.5, 0, 2 * Math.PI); context.fill();
    onChange(event.currentTarget);
  };
  const move = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (drawingPointer.current !== event.pointerId || disabled) return;
    const context = event.currentTarget.getContext('2d');
    if (!context) return;
    const current = point(event);
    context.strokeStyle = color; context.lineWidth = 5; context.lineCap = 'round'; context.lineJoin = 'round';
    context.beginPath(); context.moveTo(last.current.x, last.current.y); context.lineTo(current.x, current.y); context.stroke();
    last.current = current; onChange(event.currentTarget);
  };
  const stop = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (drawingPointer.current !== event.pointerId) return;
    drawingPointer.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return <canvas ref={canvas} width={900} height={300} className={`oe-signature-canvas ${disabled ? 'oe-disabled' : ''}`}
    aria-label={t('手写签名绘制区，使用鼠标或触控笔书写', 'Handwriting area. Draw using a mouse or pen.')}
    onPointerDown={start} onPointerMove={move} onPointerUp={stop} onPointerCancel={stop} />;
}

function PercentField({ label, value, maximum, minimum = 0, onChange, disabled }: { label: string; value: number; maximum: number; minimum?: number; onChange: (value: number) => void; disabled: boolean }) {
  return <label className="oe-field oe-percent-field"><span>{label}</span><div><input type="number" min={minimum * 100} max={maximum * 100} step="0.5" value={Math.round(value * 1000) / 10}
    disabled={disabled} onChange={event => { const next = Number(event.target.value); if (event.target.value !== '' && Number.isFinite(next)) onChange(Math.max(minimum, Math.min(maximum, next / 100))); }} /><span>%</span></div></label>;
}

function MeasureField({ label, value, maximum, minimum = 0, extent, unit, onChange, disabled }: { label: string; value: number; maximum: number; minimum?: number; extent: number; unit: '%' | 'mm'; onChange: (value: number) => void; disabled: boolean }) {
  const factor = unit === 'mm' ? extent / POINTS_PER_MM : 100;
  const formatted = String(Math.round(value * factor * 100) / 100);
  const [input, setInput] = useState(formatted);
  useEffect(() => setInput(formatted), [formatted, unit]);
  const commit = () => {
    const next = Number(input);
    if (input.trim() && Number.isFinite(next) && factor > 0) onChange(Math.max(minimum, Math.min(maximum, next / factor)));
    else setInput(formatted);
  };
  return <label className="oe-field oe-percent-field"><span>{label}</span><div><input type="number" aria-label={`${label} ${unit}`} min={Math.round(minimum * factor * 100) / 100} max={Math.round(maximum * factor * 100) / 100} step={unit === 'mm' ? '0.1' : '0.1'} value={input}
    disabled={disabled} onChange={event => setInput(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') { commit(); event.currentTarget.blur(); } }}/><span>{unit}</span></div></label>;
}

export function OverlayEditor(props: OverlayEditorProps) {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('text');
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('');
  const [localSelectedOverlay, setLocalSelectedOverlay] = useState(props.overlays.at(-1)?.id ?? '');
  const selectedOverlay = props.selectedId ?? localSelectedOverlay;
  const setSelectedOverlay = (id: string) => { setLocalSelectedOverlay(id); props.onSelect?.(id); };
  const [text, setText] = useState('');
  const [fontSize, setFontSize] = useState(24);
  const [bold, setBold] = useState(false);
  const [textFont, setTextFont] = useState(DEFAULT_FONT_FAMILY);
  const [textColor, setTextColor] = useState('#242b3e');
  const [markColor, setMarkColor] = useState('#f6ce45');
  const [markStyle, setMarkStyle] = useState<'highlight' | 'rectangle' | 'block'>('highlight');
  const [stampTitle, setStampTitle] = useState('');
  const [stampSubtitle, setStampSubtitle] = useState('');
  const [stampShape, setStampShape] = useState<StampShape>('round');
  const [stampColor, setStampColor] = useState('#bb3038');
  const [stampFont, setStampFont] = useState(DEFAULT_FONT_FAMILY);
  const [stampFontRevision, setStampFontRevision] = useState(0);
  const [stampName, setStampName] = useState('');
  const [stampMode, setStampMode] = useState<'create' | 'pdf'>('create');
  const [pdfStampPath, setPdfStampPath] = useState('');
  const [pdfStampPage, setPdfStampPage] = useState('1');
  const [pdfStampPageCount, setPdfStampPageCount] = useState(0);
  const [pdfStampFullPage, setPdfStampFullPage] = useState<PdfStampSource | null>(null);
  const [pdfStampFragment, setPdfStampFragment] = useState<PdfStampFragment | null>(null);
  const [pdfStampCrop, setPdfStampCrop] = useState<PdfStampCrop | null>(null);
  const [pdfStampRemoveWhite, setPdfStampRemoveWhite] = useState(false);
  const [pdfStampTrim, setPdfStampTrim] = useState(true);
  const [pdfStampBlend, setPdfStampBlend] = useState<BlendMode>('multiply');
  const [pdfStampName, setPdfStampName] = useState('');
  const [signatureName, setSignatureName] = useState('');
  const [signatureColor, setSignatureColor] = useState('#26334d');
  const [signatureReset, setSignatureReset] = useState(0);
  const [signatureReady, setSignatureReady] = useState(false);
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [libraryFilter, setLibraryFilter] = useState<'all' | LibraryKind>('all');
  const [renameDrafts, setRenameDrafts] = useState<Record<string, string>>({});
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<Overlay | null>(null);
  const [measureUnit, setMeasureUnit] = useState<'%' | 'mm'>('mm');
  const [preserveAspect, setPreserveAspect] = useState(true);
  const signatureCanvas = useRef<HTMLCanvasElement | null>(null);
  const alive = useRef(true);
  const pending = useRef(false);
  const releaseBusy = useRef<(() => void) | null>(null);
  const libraryWritable = useRef(true);
  const [libraryUnavailable, setLibraryUnavailable] = useState(false);
  const latest = useRef(props);
  latest.current = props;
  const cache = useRef(new Map<string, RegisteredImage>());
  const objectClipboard = useRef<Overlay | null>(null);
  const locked = Boolean(props.disabled || working);

  const libraryError = (error: unknown): string => {
    if (error instanceof Error && error.message === 'FONT_LOAD_TIMEOUT') return t('所选字体载入超时，请刷新字体列表后重试。', 'The selected font took too long to load. Refresh the font list and try again.');
    if (!(error instanceof LibraryError)) return errorMessage(error);
    switch (error.code) {
      case 'count': return t('图章和签名库最多保存 20 项，请先移除不需要的项目。', 'The local library holds up to 20 items. Remove an unused item first.');
      case 'image-size': return t('图章库单张 PNG 最大为 1 MiB，请先缩小图片。', 'A library PNG must be at most 1 MiB. Resize the image first.');
      case 'storage-size': return t('本机图章库已达到 4 MiB 限制，请移除不需要的项目。', 'The local library has reached its 4 MiB limit. Remove an unused item.');
      case 'invalid': return t('本机图章库数据无效。原有数据未被自动覆盖，可重新导入已导出的 PNG。', 'The local library data is invalid. Existing data was not automatically overwritten. Reimport your exported PNG files.');
      default: return t('无法访问本机图章库。请先导出 PNG 备份，或检查应用存储是否可用。', 'The local library cannot be accessed. Export PNG backups or check application storage.');
    }
  };

  useEffect(() => {
    alive.current = true;
    try { setLibrary(loadStampLibrary()); libraryWritable.current = true; setLibraryUnavailable(false); }
    catch (error) { libraryWritable.current = false; setLibraryUnavailable(true); latest.current.onError(libraryError(error)); }
    return () => { alive.current = false; releaseBusy.current?.(); };
  }, []);
  useEffect(() => {
    if (!props.overlays.some(item => item.id === selectedOverlay)) setSelectedOverlay(props.overlays.at(-1)?.id ?? '');
  }, [props.overlays, selectedOverlay]);

  const execute = async (task: () => Promise<void>) => {
    if (pending.current || latest.current.disabled) return;
    if (!isDesktop()) { latest.current.onError(t('请在 Jerrivell PDF 桌面应用中使用编辑工具。', 'Use the editing tools in the Jerrivell PDF desktop application.')); return; }
    pending.current = true; setWorking(true); setMessage('');
    const busyCallback = latest.current.onBusyChange;
    let released = false;
    const release = () => { if (!released) { released = true; busyCallback?.(false); } };
    releaseBusy.current = release;
    busyCallback?.(true);
    try { await task(); }
    catch (error) { if (alive.current) latest.current.onError(libraryError(error)); }
    finally {
      pending.current = false;
      if (alive.current) setWorking(false);
      release();
      if (releaseBusy.current === release) releaseBusy.current = null;
    }
  };

  const register = async (dataUrl: string): Promise<RegisteredImage> => {
    const previous = cache.current.get(dataUrl);
    if (previous) return previous;
    const asset = await backend<RegisteredImage>('register_image', { dataUrl });
    if (alive.current) cache.current.set(dataUrl, asset);
    return asset;
  };

  const place = (asset: RegisteredImage, name: string, requestedWidth = 0.3, blendMode: BlendMode = 'normal') => {
    if (!alive.current) return;
    const { pageWidth, pageHeight, overlays, onChange } = latest.current;
    if (overlays.length >= 30) throw new Error(t('当前页面最多添加 30 个内容对象。', 'A page can contain up to 30 added objects.'));
    let width = requestedWidth, height = width * pageWidth / pageHeight * asset.height / asset.width;
    if (height > 0.65) { width *= 0.65 / height; height = 0.65; }
    height = Math.max(0.01, height); width = Math.max(0.01, width);
    const overlay: Overlay = { id: crypto.randomUUID(), assetId: asset.id, x: 0.12, y: 0.12, width, height, opacity: 1, rotation: 0, blendMode };
    onChange([...overlays, overlay]); setSelectedOverlay(overlay.id);
    setLabels(previous => ({ ...previous, [overlay.id]: name }));
    setPreviews(previous => ({ ...previous, [asset.id]: asset.dataUrl }));
    setMessage(t('已添加到当前页，可在下方调整位置和大小。', 'Added to this page. Adjust its position and size below.'));
  };

  const persist = (next: LibraryItem[]) => {
    if (!alive.current) return;
    // Do not silently replace corrupt or inaccessible data with an empty library.
    if (!libraryWritable.current) throw new LibraryError('invalid');
    saveStampLibrary(next); setLibrary(next);
  };
  const remember = (asset: RegisteredImage, kind: LibraryKind, name: string, blendMode: BlendMode = 'normal'): LibraryItem => {
    const existing = library.find(item => item.kind === kind && item.dataUrl === asset.dataUrl && (item.blendMode ?? 'normal') === blendMode);
    const item: LibraryItem = {
      id: existing?.id ?? crypto.randomUUID(), kind, name: cleanLibraryName(name) || t(kind === 'stamp' ? '自定义图章' : '手写签名', kind === 'stamp' ? 'Custom stamp' : 'Handwritten signature'),
      dataUrl: asset.dataUrl, width: asset.width, height: asset.height, blendMode, createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    const next = existing ? library.map(value => value.id === existing.id ? item : value) : [...library, item];
    persist(next); if (alive.current) setMessage(t('已保存到本机图章与签名库。', 'Saved in the local stamp and signature library.'));
    return item;
  };

  const importAsset = async (kind?: LibraryKind) => {
    const selected = await open({ multiple: false, title: t('导入 PNG 或 JPEG 图片', 'Import a PNG or JPEG image'), filters: [{ name: t('图片', 'Images'), extensions: ['png', 'jpg', 'jpeg'] }] });
    if (!alive.current || !selected || Array.isArray(selected)) return;
    const asset = await backend<RegisteredImage>('import_image', { path: selected });
    if (!alive.current) return;
    cache.current.set(asset.dataUrl, asset);
    const name = selected.split(/[\\/]/).pop()?.replace(/\.(png|jpe?g)$/i, '') ?? t('导入图片', 'Imported image');
    if (kind) remember(asset, kind, name); else place(asset, name);
  };

  const addText = () => execute(async () => {
    if (!text.trim()) throw new Error(t('请先输入要添加的文字。', 'Enter the text to add.'));
    if (text.replace(/\r/g, '').split('\n').length > 20) throw new Error(t('一段添加文字最多 20 行，请分成多个对象。', 'One text object supports up to 20 lines. Split it into separate objects.'));
    await ensureFontReady(textFont, text, bold);
    if (!alive.current) return;
    const png = createTextPng(text, textColor, fontSize, bold, textFont);
    const asset = await register(png.dataUrl);
    // Canvas uses two pixels per desired PDF point, keeping the initial text size predictable.
    place(asset, t('文字', 'Text'), Math.min(0.85, Math.max(0.05, png.width / 2 / latest.current.pageWidth)));
  });

  const stampPreview = useMemo(() => {
    if (!stampTitle.trim()) return null;
    try { return createStampPng(stampTitle.trim(), stampSubtitle.trim(), stampColor, stampShape, stampFont); }
    catch { return null; }
  }, [stampTitle, stampSubtitle, stampColor, stampShape, stampFont, stampFontRevision]);
  useEffect(() => {
    let cancelled = false;
    // Repaint preview after WebView resolves a newly selected local family.
    void ensureFontReady(stampFont, stampTitle + stampSubtitle).then(() => { if (!cancelled) setStampFontRevision(value => value + 1); }).catch(() => {});
    return () => { cancelled = true; };
  }, [stampFont]);
  const createStamp = (addToPage: boolean) => execute(async () => {
    if (!stampPreview) throw new Error(t('请先输入图章标题。', 'Enter a stamp title first.'));
    await ensureFontReady(stampFont, stampTitle + stampSubtitle);
    if (!alive.current) return;
    const image = createStampPng(stampTitle.trim(), stampSubtitle.trim(), stampColor, stampShape, stampFont);
    const asset = await register(image.dataUrl);
    if (!alive.current) return;
    const name = stampName.trim() || stampTitle.trim();
    if (addToPage) place(asset, name, 0.22); else remember(asset, 'stamp', name);
  });

  const pdfStampValidPage = Number.isSafeInteger(Number(pdfStampPage)) && Number(pdfStampPage) >= 1 && (!pdfStampPageCount || Number(pdfStampPage) <= pdfStampPageCount);
  const pdfStampSource = pdfStampSourceKey(pdfStampPath, pdfStampPage);
  const pdfStampRequest = pdfStampPreviewKey(pdfStampPath, pdfStampPage, pdfStampCrop, pdfStampRemoveWhite, pdfStampTrim);
  const pdfStampFullFresh = Boolean(pdfStampPath && pdfStampValidPage && pdfStampFullPage?.sourceKey === pdfStampSource);
  const pdfStampFresh = Boolean(pdfStampFullFresh && pdfStampFragment?.previewKey === pdfStampRequest);
  const pdfStampDefaultName = `${pdfStampPath.split(/[\\/]/).pop()?.replace(/\.pdf$/i, '') ?? 'PDF'} · ${t(`第 ${pdfStampPage} 页`, `Page ${pdfStampPage}`)}`;
  const readPdfStamp = async (path: string, page: string, crop: PdfStampCrop | null, removeWhite: boolean, trim: boolean) => {
    try {
      return await backend<PdfStampImage>('import_pdf_stamp', { path, pageIndex: Number(page) - 1, crop, removeWhiteBackground: removeWhite, trimTransparentMargins: trim });
    } catch (error) {
      if (errorMessage(error).includes('PASSWORD_REQUIRED:')) throw new Error(t('这份 PDF 已加密，请先使用有权访问的未加密副本制作图章。', 'This PDF is encrypted. Use an unencrypted copy you are entitled to access.'));
      throw error;
    }
  };
  const loadPdfStampPage = async (path: string, page: string) => {
    if (!Number.isSafeInteger(Number(page)) || Number(page) < 1 || (path === pdfStampPath && pdfStampPageCount > 0 && Number(page) > pdfStampPageCount)) {
      throw new Error(t('请输入有效的来源页码。', 'Enter a valid source page number.'));
    }
    const asset = await readPdfStamp(path, page, null, false, false);
    if (!alive.current) return;
    cache.current.set(asset.dataUrl, asset);
    setPdfStampPageCount(asset.pageCount); setPdfStampFullPage({ ...asset, sourceKey: pdfStampSourceKey(path, page) });
    setPdfStampCrop(null); setPdfStampFragment(null);
    setMessage(t('页面已载入。在整页预览上拖动框选区域，然后更新片段预览。', 'Page loaded. Drag to select a region, then update the fragment preview.'));
  };
  const choosePdfStamp = () => execute(async () => {
    const selected = await open({ multiple: false, title: t('选择内容片段来源 PDF', 'Choose a PDF fragment source'), filters: [{ name: t('PDF 文档', 'PDF documents'), extensions: ['pdf'] }] });
    if (!alive.current || !selected || Array.isArray(selected)) return;
    setPdfStampPath(selected); setPdfStampPage('1'); setPdfStampPageCount(0); setPdfStampName('');
    setPdfStampFullPage(null); setPdfStampFragment(null); setPdfStampCrop(null);
    // A newly chosen file must not be checked against the previous file's page count.
    const asset = await readPdfStamp(selected, '1', null, false, false);
    if (!alive.current) return;
    cache.current.set(asset.dataUrl, asset);
    setPdfStampPageCount(asset.pageCount); setPdfStampFullPage({ ...asset, sourceKey: pdfStampSourceKey(selected, '1') });
    setMessage(t('页面已载入。在整页预览上拖动框选区域，然后更新片段预览。', 'Page loaded. Drag to select a region, then update the fragment preview.'));
  });
  const updatePdfStampPreview = () => execute(async () => {
    if (!pdfStampFullFresh) throw new Error(t('请先载入选定的 PDF 页面。', 'Load the selected PDF page first.'));
    const key = pdfStampRequest;
    const asset = await readPdfStamp(pdfStampPath, pdfStampPage, pdfStampCrop, pdfStampRemoveWhite, pdfStampTrim);
    if (!alive.current) return;
    cache.current.set(asset.dataUrl, asset);
    setPdfStampFragment({ ...asset, previewKey: key });
    setMessage(t('片段预览已更新，可叠加到当前页或保存到本机库。', 'Fragment preview updated. Place it on this page or save it to the library.'));
  });
  const usePdfStamp = (addToPage: boolean) => execute(async () => {
    if (!pdfStampFresh || !pdfStampFragment) throw new Error(t('选区或选项已变化，请先更新片段预览。', 'The region or options changed. Update the fragment preview first.'));
    const name = pdfStampName.trim() || pdfStampDefaultName;
    if (addToPage) place(pdfStampFragment, name, 0.3, pdfStampBlend); else remember(pdfStampFragment, 'stamp', name, pdfStampBlend);
  });
  const selectedPdfCrop = pdfStampCrop ?? { x: 0, y: 0, width: 1, height: 1 };
  const updatePdfCrop = (patch: Partial<PdfStampCrop>) => { if (!locked && pdfStampFullFresh) setPdfStampCrop({ ...selectedPdfCrop, ...patch }); };

  const createSignature = (addToPage: boolean) => execute(async () => {
    const image = signatureCanvas.current && trimmedSignature(signatureCanvas.current);
    if (!image) throw new Error(t('请先在签名区域书写。', 'Draw a signature first.'));
    const asset = await register(image.dataUrl);
    if (!alive.current) return;
    const name = signatureName.trim() || t('手写签名', 'Handwritten signature');
    if (addToPage) place(asset, name, 0.25); else remember(asset, 'signature', name);
  });

  const exportLibraryItem = (item: LibraryItem) => execute(async () => {
    const path = await save({ title: t('导出 PNG 图片', 'Export PNG image'), defaultPath: pngFileName(item.name), filters: [{ name: 'PNG', extensions: ['png'] }] });
    if (!alive.current || !path) return;
    const asset = await register(item.dataUrl);
    if (!alive.current) return;
    await backend('export_image', { assetId: asset.id, outputPath: /\.png$/i.test(path) ? path : `${path}.png` });
    if (alive.current) setMessage(t('PNG 已导出；合成方式不包含在 PNG 中。', 'PNG exported. Its PDF blend mode is not included in the PNG.'));
  });

  const rename = (item: LibraryItem) => {
    const draft = renameDrafts[item.id];
    if (draft === undefined || draft === item.name) return;
    const name = cleanLibraryName(draft);
    if (!name) { setRenameDrafts(previous => ({ ...previous, [item.id]: item.name })); return; }
    try { persist(library.map(value => value.id === item.id ? { ...value, name } : value)); }
    catch (error) { latest.current.onError(libraryError(error)); setRenameDrafts(previous => ({ ...previous, [item.id]: item.name })); }
  };

  const current = props.overlays.find(item => item.id === selectedOverlay);
  useEffect(() => { setDraft(current ? { ...current } : null); }, [current]);
  const editable = draft?.id === current?.id ? draft : current;
  const draftChanged = Boolean(current && editable && JSON.stringify(current) !== JSON.stringify(editable));
  const updateDraft = (patch: Partial<Overlay>) => {
    if (!editable || locked || current?.locked) return;
    if (patch.width !== undefined) setDraft(resizeOverlay(editable, 'width', patch.width, preserveAspect));
    else if (patch.height !== undefined) setDraft(resizeOverlay(editable, 'height', patch.height, preserveAspect));
    else setDraft(normalizedOverlay({ ...editable, ...patch }));
  };
  const commitOverlay = (next: Overlay) => {
    if (!current || locked || current.locked) return;
    const normalized = normalizedOverlay(next);
    if (JSON.stringify(current) === JSON.stringify(normalized)) return;
    props.onChange(props.overlays.map(item => item.id === current.id ? normalized : item));
  };
  const applyDraft = () => {
    if (!editable) return;
    commitOverlay(editable);
  };
  const moveCurrent = (direction: number) => {
    if (!current || locked || current.locked) return;
    const index = props.overlays.findIndex(item => item.id === current.id), target = index + direction;
    if (target < 0 || target >= props.overlays.length) return;
    const next = [...props.overlays]; [next[index], next[target]] = [next[target], next[index]]; props.onChange(next);
  };
  const duplicate = (source: Overlay | null = editable ?? null) => {
    if (!source || locked) return;
    if (props.overlays.length >= 30) { props.onError(t('当前页面最多添加 30 个内容对象。', 'A page can contain up to 30 added objects.')); return; }
    const next = duplicatedOverlay(source, crypto.randomUUID(), props.pageWidth, props.pageHeight);
    props.onChange([...props.overlays, next]); setSelectedOverlay(next.id);
    setLabels(previous => ({ ...previous, [next.id]: labels[source.id] || t('对象副本', 'Object copy') }));
  };
  const alignments: { id: PageAlignment; label: string }[] = [
    { id: 'left', label: t('靠左', 'Left') }, { id: 'centerX', label: t('水平居中', 'Center horizontally') }, { id: 'right', label: t('靠右', 'Right') },
    { id: 'top', label: t('靠上', 'Top') }, { id: 'centerY', label: t('垂直居中', 'Center vertically') }, { id: 'bottom', label: t('靠下', 'Bottom') },
  ];
  const tabs: { id: Tab; label: string; icon: typeof Type }[] = [
    { id: 'text', label: t('文字', 'Text'), icon: Type }, { id: 'image', label: t('图片', 'Image'), icon: ImagePlus },
    { id: 'mark', label: t('标记', 'Mark'), icon: Highlighter }, { id: 'stamp', label: t('图章', 'Stamp'), icon: Stamp },
    { id: 'signature', label: t('签名', 'Sign'), icon: PenLine }, { id: 'library', label: t('本机库', 'Library'), icon: Upload },
  ];

  return <aside className="oe-panel overlay-editor" aria-label={t('内容编辑与印章', 'Content editing and stamps')}
    onKeyDown={event => {
      const target = event.target as HTMLElement;
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable;
      if (typing) { if (!event.ctrlKey && !event.metaKey) event.stopPropagation(); return; }
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && ['c', 'v', 'd'].includes(event.key.toLowerCase()) && current) {
        event.preventDefault(); event.stopPropagation();
        if (event.key.toLowerCase() === 'c') objectClipboard.current = { ...(editable ?? current) };
        else duplicate(event.key.toLowerCase() === 'v' ? objectClipboard.current : editable ?? current);
      } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) && editable) {
        event.preventDefault(); event.stopPropagation();
        const dx = overlayStep(props.pageWidth, event.shiftKey), dy = overlayStep(props.pageHeight, event.shiftKey);
        commitOverlay(translatedOverlay(editable, event.key === 'ArrowLeft' ? -dx : event.key === 'ArrowRight' ? dx : 0, event.key === 'ArrowUp' ? -dy : event.key === 'ArrowDown' ? dy : 0));
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && current) {
        event.preventDefault(); event.stopPropagation();
        if (!locked && !current.locked) props.onChange(props.overlays.filter(item => item.id !== current.id));
      } else if (!modifier) event.stopPropagation();
    }}>
    <header className="oe-header"><div><strong>{t('添加内容', 'Add content')}</strong><span>{t('文字、图片、标记与图章', 'Text, images, marks and stamps')}</span></div><button className="oe-icon" aria-label={t('关闭编辑工具', 'Close editing tools')} disabled={working} onClick={props.onClose}><X size={18} /></button></header>
    <nav className="oe-tabs" aria-label={t('添加内容类型', 'Content type')}>{tabs.map(({ id, label, icon: Icon }) => <button key={id} className={id === tab ? 'active' : ''} aria-pressed={id === tab} onClick={() => { setTab(id); setMessage(''); }}><Icon size={16} /><span>{label}</span></button>)}</nav>
    <div className="oe-scroll">
      {libraryUnavailable && <p className="oe-storage-warning" role="status">{t('本机库暂不可用。已保留原有数据；重新启动后可重试，添加到页面仍可使用。', 'The local library is unavailable. Existing data is preserved. Restart to retry; adding content to the page remains available.')}</p>}
      {tab === 'text' && <section className="oe-section"><h3>{t('添加文字', 'Add text')}</h3><label className="oe-field"><span>{t('文字内容', 'Text')}</span><textarea maxLength={1000} rows={4} value={text} disabled={locked} placeholder={t('输入要添加的中文或英文…', 'Enter text to add…')} onChange={event => setText(event.target.value)} /></label><FontPicker value={textFont} onChange={setTextFont} disabled={locked} sample={text}/><div className="oe-fields"><label className="oe-field"><span>{t('字号（pt）', 'Size (pt)')}</span><input type="number" min={8} max={96} value={fontSize} disabled={locked} onChange={event => setFontSize(Math.max(8, Math.min(96, Number(event.target.value) || 24)))} /></label><label className="oe-field oe-color-field"><span>{t('颜色', 'Color')}</span><input type="color" value={textColor} disabled={locked} onChange={event => setTextColor(event.target.value)} /></label><label className="oe-check"><input type="checkbox" checked={bold} disabled={locked} onChange={event => setBold(event.target.checked)} />{t('加粗', 'Bold')}</label></div><button className="oe-action primary" disabled={locked || !text.trim()} onClick={() => void addText()}><Plus size={15} />{t('添加到当前页', 'Add to this page')}</button><p className="oe-note">{t('本版将添加内容保存为透明图片；文字暂不生成可搜索文字层。可在保存前移动、调整和撤销。', 'Added content is saved as a transparent image in this version. Added text has no searchable text layer. Move, resize or undo it before saving.')}</p></section>}
      {tab === 'image' && <section className="oe-section"><h3>{t('添加图片', 'Add an image')}</h3><div className="oe-empty-symbol"><ImagePlus size={34} /></div><p className="oe-description">{t('选择本机 PNG 或 JPEG 图片，放到当前页面上。PNG 透明背景会保留。', 'Choose a local PNG or JPEG image and place it on this page. PNG transparency is preserved.')}</p><button className="oe-action primary" disabled={locked} onClick={() => void execute(() => importAsset())}><Upload size={15} />{t('选择图片', 'Choose image')}</button><p className="oe-note">{t('导入图像会进行尺寸与格式检查，最长边不超过 2400 像素。', 'Imported images are validated and limited to a 2400-pixel longest edge.')}</p></section>}
      {tab === 'mark' && <section className="oe-section"><h3>{t('添加页面标记', 'Add a page mark')}</h3>{props.onDrawMarks && <button className="oe-action primary wide" disabled={locked} onClick={props.onDrawMarks}><Highlighter size={15}/>{t('直接在页面上框选绘制', 'Draw directly on the page')}</button>}<label className="oe-field"><span>{t('标记类型', 'Mark style')}</span><select value={markStyle} disabled={locked} onChange={event => setMarkStyle(event.target.value as 'highlight' | 'rectangle' | 'block')}><option value="highlight">{t('半透明高亮色块', 'Translucent highlight')}</option><option value="rectangle">{t('矩形边框', 'Rectangle outline')}</option><option value="block">{t('实心色块', 'Solid color block')}</option></select></label><label className="oe-field oe-color-field"><span>{t('颜色', 'Color')}</span><input type="color" value={markColor} disabled={locked} onChange={event => setMarkColor(event.target.value)} /></label><button className="oe-action primary" disabled={locked} onClick={() => void execute(async () => { const image = createShapePng(markColor, markStyle); place(await register(image.dataUrl), t('标记', 'Mark'), markStyle === 'highlight' ? 0.45 : 0.35); })}><Plus size={15} />{t('添加到当前页', 'Add to this page')}</button><p className="oe-note">{t('这些是可视标记，保存后成为页面内容；不会移除下方原文，也不是交互批注或真实涂黑。', 'These visual marks become page content when saved. They do not remove underlying text and are not interactive annotations or secure redactions.')}</p></section>}
      {tab === 'stamp' && <section className="oe-section"><div className="oe-stamp-modes"><button className={stampMode === 'create' ? 'active' : ''} aria-pressed={stampMode === 'create'} disabled={locked} onClick={() => setStampMode('create')}>{t('制作文字图章', 'Text stamp')}</button><button className={stampMode === 'pdf' ? 'active' : ''} aria-pressed={stampMode === 'pdf'} disabled={locked} onClick={() => setStampMode('pdf')}>{t('从 PDF 制作片段', 'PDF fragment')}</button></div>{stampMode === 'create' ? <><h3>{t('制作自定义图章', 'Create a custom stamp')}</h3><label className="oe-field"><span>{t('图章标题（最多 24 字）', 'Title (up to 24 characters)')}</span><input maxLength={24} value={stampTitle} disabled={locked} onChange={event => setStampTitle(event.target.value)} placeholder={t('填写自己的图章文字', 'Enter your own stamp text')} /></label><label className="oe-field"><span>{t('副标题', 'Subtitle')}</span><input maxLength={24} value={stampSubtitle} disabled={locked} onChange={event => setStampSubtitle(event.target.value)} placeholder={t('例如：审核通过', 'For example: REVIEWED')} /></label><FontPicker value={stampFont} onChange={setStampFont} disabled={locked} sample={stampTitle + (stampSubtitle ? '\n' + stampSubtitle : '')}/><div className="oe-fields"><label className="oe-field"><span>{t('形状', 'Shape')}</span><select value={stampShape} disabled={locked} onChange={event => setStampShape(event.target.value as StampShape)}><option value="round">{t('圆形', 'Round')}</option><option value="rectangle">{t('矩形', 'Rectangle')}</option></select></label><label className="oe-field oe-color-field"><span>{t('颜色', 'Color')}</span><input type="color" value={stampColor} disabled={locked} onChange={event => setStampColor(event.target.value)} /></label></div><div className="oe-checker oe-stamp-preview">{stampPreview ? <img src={stampPreview.dataUrl} alt={t('图章预览', 'Stamp preview')} /> : <span>{t('输入文字后显示预览', 'Enter text to preview')}</span>}</div><label className="oe-field"><span>{t('库中名称', 'Library name')}</span><input maxLength={80} value={stampName} disabled={locked} onChange={event => setStampName(event.target.value)} placeholder={stampTitle || t('自定义图章', 'Custom stamp')} /></label><div className="oe-button-row"><button className="oe-action primary" disabled={locked || !stampPreview} onClick={() => void createStamp(true)}><Plus size={14} />{t('添加到页面', 'Add to page')}</button><button className="oe-action" disabled={locked || !stampPreview} onClick={() => void createStamp(false)}><Stamp size={14} />{t('保存到本机库', 'Save to library')}</button></div><button className="oe-action wide" disabled={locked} onClick={() => void execute(() => importAsset('stamp'))}><Upload size={14} />{t('导入现有图章图片', 'Import a stamp image')}</button><p className="oe-note">{t('仅使用你有权使用的文字和图章。本机库中的项目可在“本机库”页导出 PNG。', 'Use only text and stamps you are entitled to use. Export library items as PNG from the Library tab.')}</p></> : <><h3>{t('从 PDF 制作内容片段', 'Create a fragment from PDF')}</h3>
          <p className="oe-description">{t('导入另一份 PDF，框选其中的矩形区域，叠加到当前 PDF。', 'Import another PDF and select a rectangular region to overlay on this document.')}</p>
          <button className="oe-action wide" disabled={locked} onClick={() => void choosePdfStamp()}><FileText size={14}/>{pdfStampPath ? t('更换来源 PDF', 'Choose another PDF') : t('选择来源 PDF', 'Choose source PDF')}</button>
          {pdfStampPath && <>
            <p className="oe-pdf-source" title={pdfStampPath}>{pdfStampPath.split(/[\\/]/).pop()}</p>
            <div className="oe-pdf-page-row"><label className="oe-field"><span>{t('来源页码', 'Source page')} {pdfStampPageCount > 0 && `/ ${pdfStampPageCount}`}</span><input aria-label={t('PDF 片段来源页码', 'PDF fragment source page')} type="number" min={1} max={pdfStampPageCount || undefined} value={pdfStampPage} disabled={locked} onChange={event => setPdfStampPage(event.target.value)}/></label><button className="oe-action" disabled={locked || !pdfStampValidPage} onClick={() => void execute(() => loadPdfStampPage(pdfStampPath, pdfStampPage))}>{t('载入此页', 'Load page')}</button></div>
            {pdfStampFullFresh && pdfStampFullPage ? <>
              <p className="oe-note">{t('在下图拖动框选；不框选则使用整页。选区按当前显示方向计算。', 'Drag below to select a region. Without a selection, the whole page is used. Coordinates follow its displayed orientation.')}</p>
              <PdfStampSelection key={pdfStampFullPage.sourceKey} image={pdfStampFullPage} crop={pdfStampCrop} onChange={setPdfStampCrop} disabled={locked}/>
              <div className="oe-pdf-crop-heading"><span>{t('选区占来源页面的百分比', 'Region as a percentage of source page')}</span><button className="oe-small-button" disabled={locked} onClick={() => setPdfStampCrop(null)}>{t('使用整页', 'Use whole page')}</button></div>
              <div className="oe-fields"><PercentField label={t('左边距', 'Left')} value={selectedPdfCrop.x} maximum={1 - selectedPdfCrop.width} disabled={locked} onChange={x => updatePdfCrop({ x })}/><PercentField label={t('上边距', 'Top')} value={selectedPdfCrop.y} maximum={1 - selectedPdfCrop.height} disabled={locked} onChange={y => updatePdfCrop({ y })}/><PercentField label={t('选区宽度', 'Region width')} value={selectedPdfCrop.width} minimum={0.005} maximum={1 - selectedPdfCrop.x} disabled={locked} onChange={width => updatePdfCrop({ width })}/><PercentField label={t('选区高度', 'Region height')} value={selectedPdfCrop.height} minimum={0.005} maximum={1 - selectedPdfCrop.y} disabled={locked} onChange={height => updatePdfCrop({ height })}/></div>
            </> : <p className="oe-pdf-stale" role="status">{t('页码已变化，请先点击“载入此页”。', 'The page changed. Select Load page first.')}</p>}
            <label className="oe-check oe-pdf-check"><input type="checkbox" checked={pdfStampRemoveWhite} disabled={locked} onChange={event => setPdfStampRemoveWhite(event.target.checked)}/>{t('白底转透明', 'Make near-white transparent')}</label>
            <label className="oe-check oe-pdf-check"><input type="checkbox" checked={pdfStampTrim} disabled={locked} onChange={event => setPdfStampTrim(event.target.checked)}/>{t('裁掉透明边缘', 'Trim transparent margins')}</label>
            <button className="oe-action wide" disabled={locked || !pdfStampFullFresh} onClick={() => void updatePdfStampPreview()}><RotateCw size={14}/>{t('更新片段预览', 'Update fragment preview')}</button>
            {pdfStampFragment && <div className={`oe-checker oe-stamp-preview oe-pdf-fragment ${pdfStampFresh ? '' : 'oe-pdf-stale-image'}`}><img src={pdfStampFragment.dataUrl} alt={t('PDF 内容片段预览', 'PDF fragment preview')}/></div>}
            {!pdfStampFresh && pdfStampFragment && <p className="oe-pdf-stale" role="status">{t('选区或选项已变化，更新预览后才能使用。', 'The region or options changed. Update the preview before use.')}</p>}
            <label className="oe-field oe-pdf-blend"><span>{t('合成方式', 'Blend mode')}</span><select value={pdfStampBlend} disabled={locked} onChange={event => setPdfStampBlend(event.target.value as BlendMode)}><option value="multiply">{t('正片叠底', 'Multiply')}</option><option value="normal">{t('正常', 'Normal')}</option></select></label>
            <label className="oe-field"><span>{t('片段名称', 'Fragment name')}</span><input maxLength={80} value={pdfStampName} disabled={locked} onChange={event => setPdfStampName(event.target.value)} placeholder={pdfStampDefaultName}/></label>
            <div className="oe-button-row"><button className="oe-action primary" disabled={locked || !pdfStampFresh} onClick={() => void usePdfStamp(true)}><Plus size={14}/>{t('叠加到当前页', 'Overlay on this page')}</button><button className="oe-action" disabled={locked || !pdfStampFresh} onClick={() => void usePdfStamp(false)}><Stamp size={14}/>{t('保存到本机库', 'Save to library')}</button></div>
          </>}
          <p className="oe-note">{t('片段保存为图像，保留来源页的显示方向；框选区域内的正文也会一起导入。原 PDF 不变，不属于证书数字签名。', 'The fragment is saved as an image in the source page’s displayed orientation. Text inside the selected rectangle is included. The original PDF is unchanged. This is not a certificate-based digital signature.')}</p>
          <p className="oe-note">{t('正片叠底在目标页面应用；这里的预览只显示片段本身。白底转透明会移除近白色，浅色图案建议保留原色并使用正片叠底。', 'Blending is applied on the destination page; this preview shows the fragment alone. The transparency option removes near-white colors. Keep original colors and use Multiply for pale artwork.')}</p></>}</section>}
      {tab === 'signature' && <section className="oe-section"><h3>{t('手写签名', 'Handwritten signature')}</h3><p className="oe-description">{t('用鼠标、触控或触控笔在下方书写。', 'Write below using a mouse, touch or pen.')}</p><SignaturePad color={signatureColor} disabled={locked} resetKey={signatureReset} onChange={value => { signatureCanvas.current = value; setSignatureReady(Boolean(value)); }} /><div className="oe-signature-options"><label className="oe-color-label"><span>{t('笔迹颜色', 'Ink')}</span><input type="color" value={signatureColor} disabled={locked} onChange={event => setSignatureColor(event.target.value)} /></label><button className="oe-small-button" disabled={locked} onClick={() => setSignatureReset(previous => previous + 1)}>{t('清空画布', 'Clear canvas')}</button></div><label className="oe-field"><span>{t('签名名称', 'Signature name')}</span><input maxLength={80} value={signatureName} disabled={locked} onChange={event => setSignatureName(event.target.value)} placeholder={t('我的签名', 'My signature')} /></label><div className="oe-button-row"><button className="oe-action primary" disabled={locked || !signatureReady} onClick={() => void createSignature(true)}><Plus size={14} />{t('添加到页面', 'Add to page')}</button><button className="oe-action" disabled={locked || !signatureReady} onClick={() => void createSignature(false)}><PenLine size={14} />{t('保存到本机库', 'Save to library')}</button></div><button className="oe-action wide" disabled={locked} onClick={() => void execute(() => importAsset('signature'))}><Upload size={14} />{t('导入签名图片', 'Import signature image')}</button><p className="oe-note">{t('图章和签名是可视图片，不是证书数字签名，也不提供签署者身份或文件完整性验证。', 'Stamps and signatures are visual images, not certificate-based digital signatures. They do not verify signer identity or file integrity.')}</p></section>}
      {tab === 'library' && <section className="oe-section"><div className="oe-section-heading"><h3>{t('本机内容库', 'Local content library')}</h3><span>{library.length}/{MAX_LIBRARY_ITEMS}</span></div><label className="oe-field"><span>{t('显示', 'Show')}</span><select value={libraryFilter} onChange={event => setLibraryFilter(event.target.value as typeof libraryFilter)}><option value="all">{t('全部', 'All')}</option><option value="stamp">{t('图章与片段', 'Stamps and fragments')}</option><option value="signature">{t('签名', 'Signatures')}</option></select></label><div className="oe-button-row"><button className="oe-action" disabled={locked} onClick={() => void execute(() => importAsset('stamp'))}><Upload size={14} />{t('导入图章', 'Import stamp')}</button><button className="oe-action" disabled={locked} onClick={() => void execute(() => importAsset('signature'))}><Upload size={14} />{t('导入签名', 'Import signature')}</button></div><p className="oe-note">{t('库保存在本机应用存储，不会上传。重要图章和签名请导出 PNG 备份；清除应用数据会移除库。', 'Stored only in this application on this device. Export important items as PNG backups. Clearing application data removes the library.')}</p><div className="oe-library-list">{library.filter(item => libraryFilter === 'all' || item.kind === libraryFilter).map(item => <article className="oe-library-item" key={item.id}><div className="oe-checker oe-library-preview"><img src={item.dataUrl} alt={item.name} /></div><label className="oe-field"><span>{item.kind === 'stamp' ? t('图章或片段名称', 'Stamp or fragment name') : t('签名名称', 'Signature name')}</span><input aria-label={t('重命名：', 'Rename: ') + item.name} value={renameDrafts[item.id] ?? item.name} maxLength={80} disabled={locked} onChange={event => setRenameDrafts(previous => ({ ...previous, [item.id]: event.target.value }))} onBlur={() => rename(item)} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></label><div className="oe-library-actions"><button disabled={locked} onClick={() => void execute(async () => place(await register(item.dataUrl), item.name, item.kind === 'stamp' ? 0.22 : 0.25, item.blendMode ?? 'normal'))}><Plus size={13} />{t('加到页面', 'Place')}</button><button disabled={locked} onClick={() => void exportLibraryItem(item)}><Download size={13} />PNG</button><button className="oe-danger" disabled={locked} aria-label={t('从本机库移除：', 'Remove from local library: ') + item.name} onClick={() => { try { persist(library.filter(value => value.id !== item.id)); } catch (error) { latest.current.onError(libraryError(error)); } }}><Trash2 size={13} /></button></div></article>)}</div>{!library.some(item => libraryFilter === 'all' || item.kind === libraryFilter) && <div className="oe-library-empty"><Stamp size={30} /><p>{t('还没有保存的项目', 'No saved items yet')}</p><span>{t('制作图章、书写签名，或导入已有图片。', 'Create a stamp, draw a signature or import an image.')}</span></div>}</section>}
      {message && <div className="oe-message" role="status"><Check size={14} />{message}</div>}
      <section className="oe-section oe-object-section">
        <div className="oe-section-heading"><h3>{t('当前页添加的内容', 'Added objects on this page')}</h3><span>{props.overlays.length}/30</span></div>
        {props.overlays.length === 0 ? <p className="oe-note">{t('添加内容后，可以在这里选择对象并调整位置和大小。', 'Add an object, then select it here to adjust position and size.')}</p> : <>
          <div className="oe-object-list">{props.overlays.map((item, index) => <button key={item.id} className={item.id === selectedOverlay ? 'selected' : ''} disabled={locked} onClick={() => setSelectedOverlay(item.id)}><span className="oe-object-thumb">{previews[item.assetId] ? <img src={previews[item.assetId]} alt=""/> : <ImagePlus size={14}/>}</span><span>{labels[item.id] || `${t('对象', 'Object')} ${index + 1}`}</span>{item.locked && <LockKeyhole size={11}/>}<small>{index + 1}</small></button>)}</div>
          {current && editable && <div className="oe-object-properties">
            <div className="oe-unit-row"><span>{t('坐标与尺寸单位', 'Position and size units')}</span><select aria-label={t('坐标与尺寸单位', 'Position and size units')} value={measureUnit} disabled={locked} onChange={event => setMeasureUnit(event.target.value as '%' | 'mm')}><option value="mm">{t('毫米 (mm)', 'Millimeters (mm)')}</option><option value="%">{t('页面百分比 (%)', 'Page percentage (%)')}</option></select></div>
            <div className="oe-fields">
              <MeasureField label={t('左边距', 'Left')} value={editable.x} maximum={1 - editable.width} extent={props.pageWidth} unit={measureUnit} disabled={locked || Boolean(current.locked)} onChange={x => updateDraft({ x })}/>
              <MeasureField label={t('上边距', 'Top')} value={editable.y} maximum={1 - editable.height} extent={props.pageHeight} unit={measureUnit} disabled={locked || Boolean(current.locked)} onChange={y => updateDraft({ y })}/>
              <MeasureField label={t('宽度', 'Width')} value={editable.width} minimum={MIN_OVERLAY_SIDE} maximum={1 - editable.x} extent={props.pageWidth} unit={measureUnit} disabled={locked || Boolean(current.locked)} onChange={width => updateDraft({ width })}/>
              <MeasureField label={t('高度', 'Height')} value={editable.height} minimum={MIN_OVERLAY_SIDE} maximum={1 - editable.y} extent={props.pageHeight} unit={measureUnit} disabled={locked || Boolean(current.locked)} onChange={height => updateDraft({ height })}/>
            </div>
            <label className="oe-check"><input type="checkbox" checked={preserveAspect} disabled={locked || Boolean(current.locked)} onChange={event => setPreserveAspect(event.target.checked)}/>{t('调整尺寸时保持比例', 'Keep aspect ratio when resizing')}</label>
            <label className="oe-field"><span>{t('合成方式', 'Blend mode')}</span><select value={editable.blendMode ?? 'normal'} disabled={locked || Boolean(current.locked)} onChange={event => updateDraft({ blendMode: event.target.value as BlendMode })}><option value="normal">{t('正常', 'Normal')}</option><option value="multiply">{t('正片叠底', 'Multiply')}</option></select></label>
            <label className="oe-field oe-opacity"><span>{t('不透明度', 'Opacity')} <b>{Math.round(editable.opacity * 100)}%</b></span><input type="range" min="5" max="100" value={Math.round(editable.opacity * 100)} disabled={locked || Boolean(current.locked)} onChange={event => updateDraft({ opacity: Number(event.target.value) / 100 })}/></label>
            <button className="oe-action primary wide" disabled={locked || Boolean(current.locked) || !draftChanged} onClick={applyDraft}><Check size={14}/>{t('应用位置与大小', 'Apply position and size')}</button>
            <div className="oe-align-grid" aria-label={t('相对页面对齐', 'Align relative to page')}>{alignments.map(alignment => <button key={alignment.id} disabled={locked || Boolean(current.locked)} onClick={() => commitOverlay(alignedOverlay(editable, alignment.id))}>{alignment.label}</button>)}</div>
            <div className="oe-object-tools"><button className="oe-action" disabled={locked || props.overlays.length >= 30} onClick={() => duplicate()}><Copy size={13}/>{t('复制对象', 'Duplicate object')}</button><button className="oe-action" disabled={locked || Boolean(current.locked)} onClick={() => commitOverlay(rotatedOverlay90(editable, props.pageWidth, props.pageHeight))}><RotateCw size={13}/>{t('旋转 90°', 'Rotate 90°')}</button></div>
            <label className="oe-check oe-object-lock"><input type="checkbox" checked={Boolean(current.locked)} disabled={locked} onChange={event => props.onChange(props.overlays.map(item => item.id === current.id ? { ...item, locked: event.target.checked } : item))}/><LockKeyhole size={12}/>{t('锁定对象，防止移动和误删', 'Lock object against movement and deletion')}</label>
            <div className="oe-button-row"><button className="oe-action" title={t('向下一层', 'Move one layer down')} disabled={locked || Boolean(current.locked) || props.overlays[0].id === editable.id} onClick={() => moveCurrent(-1)}><ChevronDown size={14}/>{t('下移', 'Lower')}</button><button className="oe-action" title={t('向上一层', 'Move one layer up')} disabled={locked || Boolean(current.locked) || props.overlays.at(-1)?.id === editable.id} onClick={() => moveCurrent(1)}><ChevronUp size={14}/>{t('上移', 'Raise')}</button><button className="oe-action oe-danger" disabled={locked || Boolean(current.locked)} onClick={() => props.onChange(props.overlays.filter(item => item.id !== editable.id))}><Trash2 size={14}/>{t('移除', 'Remove')}</button></div>
            <div className="oe-rotation-readout"><RotateCw size={12}/>{t('对象方向：', 'Object orientation: ')}{editable.rotation ?? 0}°</div>
            <p className="oe-note">{t('方向键微移 0.1 mm，Shift + 方向键移动 1 mm；Ctrl+C / Ctrl+V 在本编辑面板内复制粘贴对象，Ctrl+D 复制。输入框内保留文字快捷键。锁定只在当前工作区有效。', 'Arrow keys move 0.1 mm; Shift + arrows move 1 mm. Ctrl+C / Ctrl+V copy and paste objects within this editor; Ctrl+D duplicates. Text fields keep text shortcuts. Locks apply only to this workspace.')}</p>
          </div>}
        </>}
      </section>
    </div>
    {working && <div className="oe-working" role="status"><LoaderCircle size={15} className="spin" />{t('正在处理内容…', 'Processing content…')}</div>}
    <footer className="oe-footer">{t('页面内容可撤销；保存副本会将内容写入 PDF。', 'Page edits can be undone. Save a copy to write them into the PDF.')}</footer>
  </aside>;
}

export default OverlayEditor;
