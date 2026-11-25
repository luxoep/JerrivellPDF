// SPDX-License-Identifier: MIT OR Apache-2.0
import { useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { RegionSelection } from './RegionSelection';
import { PreviewZoom } from './PreviewZoom';
import { useFragmentPreview } from '../useFragmentPreview';
import { FragmentTray } from './FragmentTray';
import { fragmentOverlays, fragmentSelections, mergeFragments } from '../pdfFragments';
import type { FragmentDrop, PdfFragmentItem } from '../pdfFragments';
import { ImageEditDialog } from './ImageEditDialog';
import type { ImageSelection, SelectionShape } from '../imageGeometry';
import { transformSelection } from '../imageGeometry';
import './image-workbench.css';
import { open, save } from '@tauri-apps/plugin-dialog';
import { Check, ChevronDown, ChevronUp, Copy, Download, FileText, ImagePlus, LoaderCircle, LockKeyhole, PenLine, Plus, RotateCw, Stamp, Trash2, Type, Upload, X } from 'lucide-react';
import { backend, errorMessage, isDesktop } from '../backend';
import { useI18n } from '../i18n';
import type { ImageAsset, PageOverlay, PdfStampImage } from '../types';
import { cleanLibraryName, LibraryError, loadStampLibrary, MAX_LIBRARY_ITEMS, pngFileName, saveStampLibrary } from '../stampLibrary';
import type { LibraryItem, LibraryKind } from '../stampLibrary';
import { createStampPng, createTextPng, createTypedSignaturePng, DEFAULT_FONT_FAMILY, ensureFontReady, finishInlineTextEvent, SIGNATURE_SCRIPT_FONT, timestampedSignaturePng, trimmedSignature } from './overlayCanvas';
import type { StampShape, TextOverlaySource } from './overlayCanvas';
import { FontPicker } from './FontPicker';
import { alignedOverlay, duplicatedOverlay, MIN_OVERLAY_SIDE, normalizedOverlay, overlayStep, POINTS_PER_MM, resizeOverlay, rotatedOverlay90, translatedOverlay } from '../overlayGeometry';
import type { PageAlignment } from '../overlayGeometry';
import { fitTextFrame, resizeTextFrame } from '../textFrame';
import { useNumberDraft } from '../useNumberDraft';
import './overlay-editor.css';
import '../overlayEditor.css';

export type Overlay = PageOverlay;
export type { PageOverlay };
export type RegisteredImage = ImageAsset;
export interface OverlayEditorProps {
  fragments?: PdfFragmentItem[];
  onFragmentsChange?: (items: PdfFragmentItem[]) => void;
  onPlaceFragments?: (items: PdfFragmentItem[], drop?: FragmentDrop) => Promise<void>;
  initialTab?: Tab;
  onTabChange?: (tab: Tab) => void;
  onDrawText?: () => void;
  drawingText?: boolean;
  onTextStyleChange?: (style: TextOverlaySource) => void;
  onTextEditingChange?: (editing: boolean) => void;
  pageWidth: number;
  pageHeight: number;
  overlays: Overlay[];
  onChange: (overlays: Overlay[]) => boolean | void;
  disabled?: boolean;
  onError: (message: string) => void;
  onClose: () => void;
  onBusyChange?: (busy: boolean) => void;
  selectedId?: string;
  onSelect?: (id: string) => void;
}

export type Tab = 'text' | 'image' | 'stamp' | 'signature' | 'library';
type BlendMode = 'normal' | 'multiply';
export type PdfStampCrop = ImageSelection;
interface PdfStampSource extends PdfStampImage { sourceKey: string }

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

function PdfStampSelection(props: { image: RegisteredImage; crop: PdfStampCrop | null; shape: SelectionShape; onChange: (crop: PdfStampCrop | null) => void; onPreview: (crop: PdfStampCrop | null) => void; disabled: boolean }) {
  return <div className="pdf-fragment-fit"><RegionSelection {...props} allowMultiple zoomable/></div>;
}

function PdfFragmentPreview({ source, crop, removeWhite, trim, index }: { source: ImageAsset; crop: ImageSelection; removeWhite: boolean; trim: boolean; index: number }) {
  const { t } = useI18n();
  const { image, error } = useFragmentPreview(source, crop, removeWhite, trim);
  return <div className="pdf-fragment-result-card"><span>{t(`片段 ${index + 1}`, `Fragment ${index + 1}`)}</span><div className="oe-checker pdf-fragment-result">{image && <PreviewZoom width={image.width} height={image.height} resetKey={`${source.id}-${index}`} label={t('PDF 片段可缩放结果预览', 'Zoomable PDF fragment result')}><img src={image.dataUrl} alt={t(`片段 ${index + 1} 预览`, `Fragment ${index + 1} preview`)}/></PreviewZoom>}</div>{error && <p role="alert">{error}</p>}</div>;
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
  const number = useNumberDraft(value * 100, next => onChange(next / 100), { min: minimum * 100, max: maximum * 100, step: .5 });
  return <label className="oe-field oe-percent-field"><span>{label}</span><div><input {...number} disabled={disabled}/><span>%</span></div></label>;
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
  const [tab, setLocalTab] = useState<Tab>(props.initialTab ?? 'text');
  const setTab = (value: Tab) => { setLocalTab(value); props.onTabChange?.(value); };
  const [localFragments, setLocalFragments] = useState<PdfFragmentItem[]>([]);
  const fragments = props.fragments ?? localFragments;
  const setFragments = (items: PdfFragmentItem[]) => { if (props.onFragmentsChange) props.onFragmentsChange(items); else setLocalFragments(items); };
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
  const [italic, setItalic] = useState(false);
  const [underline, setUnderline] = useState(false);
  const [strikeout, setStrikeout] = useState(false);
  const [textAlignment, setTextAlignment] = useState<'left' | 'center' | 'right'>('left');
  const [charSpacing, setCharSpacing] = useState(0);
  const [lineHeight, setLineHeight] = useState(1.45);
  const [textWrap, setTextWrap] = useState(true);
  const [textBoxWidth, setTextBoxWidth] = useState(100);
  const [textBoxHeight, setTextBoxHeight] = useState(30);
  const [textAutoHeight, setTextAutoHeight] = useState(true);
  const [textPadding, setTextPadding] = useState<number | undefined>(0);
  const selectedObject = props.overlays.find(item => item.id === selectedOverlay);
  const selectedTextSource = selectedObject?.textSource;
  const pendingText = useRef<{ id: string; source: TextOverlaySource } | null>(null);
  const [hasTextDraft, setHasTextDraft] = useState(false);
  const [composingText, setComposingText] = useState(false);
  const [textCommitError, setTextCommitError] = useState('');
  const textPreviewSource = useRef<TextOverlaySource | null>(null);
  const finishTextRef = useRef<() => boolean>(() => true);
  const editText = <T,>(setter: (value: T) => void) => (value: T) => {
    if (selectedTextSource && !selectedObject?.locked && !props.drawingText) {
      if (!pendingText.current) {
        pendingText.current = { id: selectedOverlay, source: selectedTextSource };
        setHasTextDraft(true);
        props.onTextEditingChange?.(true);
      }
      if (textCommitError) setTextCommitError('');
    }
    setter(value);
  };
  const numberKey = selectedOverlay;
  const sizeInput = useNumberDraft(fontSize, editText(setFontSize), { min: 6, max: 144, resetKey: numberKey });
  const leadingInput = useNumberDraft(lineHeight, editText(setLineHeight), { min: .8, max: 3, step: .05, resetKey: numberKey });
  const spacingInput = useNumberDraft(charSpacing, editText(setCharSpacing), { min: -2, max: 20, step: .1, resetKey: numberKey });
  const widthInput = useNumberDraft(textBoxWidth, editText(setTextBoxWidth), { min: 1 / POINTS_PER_MM, max: props.pageWidth / POINTS_PER_MM, step: .1, resetKey: numberKey });
  const heightInput = useNumberDraft(textBoxHeight, editText(setTextBoxHeight), { min: 1 / POINTS_PER_MM, max: props.pageHeight / POINTS_PER_MM, step: .1, resetKey: numberKey });
  const paddingInput = useNumberDraft(textPadding ?? Math.ceil(Math.max(16, fontSize * .5)) / 2, editText(setTextPadding), { min: 0, max: 24, step: .5, resetKey: numberKey });
  const [textPreview, setTextPreview] = useState<ReturnType<typeof createTextPng> | null>(null);
  const [textPreviewError, setTextPreviewError] = useState('');
  const textSource = useMemo<TextOverlaySource>(() => ({ content: text, color: textColor, fontSize, bold, fontFamily: textFont,
    italic, underline, strikeout, alignment: textAlignment, charSpacing, lineHeight, ...(textPadding === undefined ? {} : { padding: textPadding }),
    ...(textWrap ? { frame: { width: Math.min(Math.max(textPadding === undefined ? 24 : 1, textBoxWidth * POINTS_PER_MM), Math.floor(props.pageWidth * 2) / 2),
      height: Math.min(Math.max(textPadding === undefined ? 12 : 1, textBoxHeight * POINTS_PER_MM), Math.floor(props.pageHeight * 2) / 2), autoHeight: textAutoHeight } } : {}),
  }), [text, textColor, fontSize, bold, textFont, italic, underline, strikeout, textAlignment, charSpacing, lineHeight, textWrap, textBoxWidth, textBoxHeight, textAutoHeight, textPadding, props.pageWidth, props.pageHeight]);
  useEffect(() => { props.onTextStyleChange?.(textSource); }, [textSource, props.onTextStyleChange]);
  useEffect(() => {
    let cancelled = false;
    if (!textSource.content.trim()) { setTextPreview(null); setTextPreviewError(''); return; }
    const timer = window.setTimeout(() => {
      void ensureFontReady(textSource.fontFamily, textSource.content, textSource.bold, textSource.italic).then(() => {
        if (cancelled) return;
        const result = createTextPng(textSource.content, textSource.color, textSource.fontSize, textSource.bold, textSource.fontFamily, textSource);
        textPreviewSource.current = textSource;
        setTextPreview(result); setTextPreviewError('');
      }).catch(error => { if (!cancelled) { setTextPreview(null); setTextPreviewError(error instanceof Error ? error.message : 'TEXT_LAYOUT_LIMIT'); } });
    }, 160);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [textSource]);
  const loadTextSettings = (source: TextOverlaySource) => {
    setTab('text'); setText(source.content); setTextColor(source.color); setFontSize(source.fontSize); setBold(source.bold); setTextFont(source.fontFamily);
    setItalic(source.italic ?? false); setUnderline(source.underline ?? false); setStrikeout(source.strikeout ?? false);
    setTextAlignment(source.alignment ?? 'left'); setCharSpacing(source.charSpacing ?? 0); setLineHeight(source.lineHeight ?? 1.45);
    setTextPadding(source.padding);
    setTextWrap(Boolean(source.frame) || source.wrapWidth !== undefined);
    if (source.frame) { setTextBoxWidth(source.frame.width / POINTS_PER_MM); setTextBoxHeight(source.frame.height / POINTS_PER_MM); setTextAutoHeight(source.frame.autoHeight); }
    else { setTextAutoHeight(true); if (source.wrapWidth !== undefined) setTextBoxWidth((source.wrapWidth + Math.ceil(Math.max(16, source.fontSize * .5))) / POINTS_PER_MM); }
  };
  // A page drag can change the frame without touching the editor controls. Keep
  // those controls current so a later format change cannot restore an old size.
  useEffect(() => {
    cancelTextDraft();
    if (selectedTextSource) loadTextSettings(selectedTextSource);
  }, [selectedOverlay, selectedTextSource]);
  const [stampTitle, setStampTitle] = useState('');
  const [stampSubtitle, setStampSubtitle] = useState('');
  const [stampShape, setStampShape] = useState<StampShape>('round');
  const [stampColor, setStampColor] = useState('#bb3038');
  const [stampFont, setStampFont] = useState(DEFAULT_FONT_FAMILY);
  const [stampFontRevision, setStampFontRevision] = useState(0);
  const [stampName, setStampName] = useState('');
  const [stampMode, setStampMode] = useState<'create' | 'pdf'>(props.fragments?.length ? 'pdf' : 'create');
  const [pdfStampPath, setPdfStampPath] = useState('');
  const [pdfStampPage, setPdfStampPage] = useState('1');
  const [pdfStampPageCount, setPdfStampPageCount] = useState(0);
  const [pdfStampFullPage, setPdfStampFullPage] = useState<PdfStampSource | null>(null);
  const [pdfStampCombined, setPdfStampCombined] = useState(false);
  const [pdfStampCrop, setPdfStampCrop] = useState<PdfStampCrop | null>(null);
  const pdfDialog=useRef<HTMLElement>(null);
  const [pdfStampOpen, setPdfStampOpen] = useState(false), [pdfStampShape, setPdfStampShape] = useState<SelectionShape>('rectangle');
  const [pdfStampGhost, setPdfStampGhost] = useState<PdfStampCrop | null>(null);
  const [imageEdit, setImageEdit] = useState<{ id: string; asset: RegisteredImage } | null>(null);
  useEffect(()=>{if(pdfStampOpen)pdfDialog.current?.focus();},[pdfStampOpen]);

  const [pdfStampRemoveWhite, setPdfStampRemoveWhite] = useState(false);
  const [pdfStampTrim, setPdfStampTrim] = useState(true);
  const [pdfStampBlend, setPdfStampBlend] = useState<BlendMode>('multiply');
  const [pdfStampName, setPdfStampName] = useState('');
  const [signatureName, setSignatureName] = useState('');
  const [signatureMode, setSignatureMode] = useState<'draw' | 'type'>('draw');
  const [signatureText, setSignatureText] = useState('');
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
  const textLocked = locked || Boolean(selectedObject?.locked && selectedTextSource && !props.drawingText);

  function cancelTextDraft() {
    if (!pendingText.current) return;
    pendingText.current = null;
    setHasTextDraft(false); setTextCommitError('');
    latest.current.onTextEditingChange?.(false);
  }

  function applyTextDraft(): boolean {
    const pending = pendingText.current;
    if (!pending) return true;
    const current = latest.current.overlays.find(item => item.id === pending.id);
    if (!current || selectedOverlay !== pending.id || current.textSource !== pending.source || current.locked) {
      cancelTextDraft();
      return true;
    }
    if (textLocked || composingText) return false;
    if (!text.trim() || textPreviewError || (textPreviewSource.current === textSource && textPreview?.overflow)) {
      setTextCommitError(t('文字为空或超出文本框。请调整内容，或按 Esc 放弃本次修改。', 'Text is empty or does not fit. Adjust the text or press Esc to discard this edit.'));
      return false;
    }
    if (!textPreview || textPreviewSource.current !== textSource) return false;

    const { pageWidth, pageHeight, overlays, onChange } = latest.current;
    const quarterTurn = Math.abs(current.rotation ?? 0) % 180 === 90;
    const width = (quarterTurn ? textPreview.height : textPreview.width) / (2 * pageWidth);
    const height = (quarterTurn ? textPreview.width : textPreview.height) / (2 * pageHeight);
    if (width > 1 || height > 1) {
      setTextCommitError(t('文字超出页面。请缩短内容或按 Esc 放弃修改。', 'Text exceeds the page. Shorten it or press Esc to discard this edit.'));
      return false;
    }
    const source = textSource.frame ? { ...textSource, frame: { ...textSource.frame, width: textPreview.width / 2, height: textPreview.height / 2 } } : textSource;
    const overlay = normalizedOverlay({ ...current, width, height, textSource: source });
    if (onChange(overlays.map(item => item.id === overlay.id ? overlay : item)) === false) {
      setTextCommitError(t('文字修改尚未应用。请调整内容，或按 Esc 放弃本次修改。', 'Text changes were not applied. Adjust the text or press Esc to discard this edit.'));
      return false;
    }
    cancelTextDraft();
    return true;
  }
  finishTextRef.current = applyTextDraft;
  useEffect(() => {
    if (!hasTextDraft || composingText || textLocked || textPreviewSource.current !== textSource) return;
    const timer = window.setTimeout(() => finishTextRef.current(), 400);
    return () => window.clearTimeout(timer);
  }, [hasTextDraft, textSource, textPreview, composingText, textLocked]);
  useEffect(() => {
    if (!latest.current.onTextEditingChange) return;
    const finish = () => { if (pendingText.current) flushSync(() => { finishTextRef.current(); }); };
    window.addEventListener(finishInlineTextEvent, finish);
    return () => {
      window.removeEventListener(finishInlineTextEvent, finish);
      if (pendingText.current) { pendingText.current = null; latest.current.onTextEditingChange?.(false); }
    };
  }, []);

  const libraryError = (error: unknown): string => {
    const fragmentErrors: Record<string, [string, string]> = {
      FRAGMENT_COUNT_LIMIT: ['片段列表最多保留 48 项，请删除不需要的片段。', 'The fragment list holds 48 items. Remove unused fragments.'],
      FRAGMENT_MEMORY_LIMIT: ['片段列表已达到 24 MiB，请先导出或保存，再移除不需要的片段。', 'The fragment list has reached 24 MiB. Export or save items before removing them.'],
      FRAGMENT_PAGE_LIMIT: ['插入后会超过每页 30 个内容对象，请分批放到其他页面。', 'This insertion would exceed 30 added objects per page. Place some on another page.'],
      FRAGMENT_PIXEL_LIMIT: ['片段解码量超过 64 MiB，请减少本次插入数量。', 'The fragments exceed 64 MiB decoded. Insert fewer at a time.'],
    };
    if (error instanceof Error && fragmentErrors[error.message]) return t(...fragmentErrors[error.message]);
    if (error instanceof Error && ['TEXT_LAYOUT_LIMIT', 'TEXT_BOX_TOO_NARROW', 'TEXT_PAGE_OVERFLOW', 'TEXT_FRAME_OVERFLOW'].includes(error.message)) return t('文字超出文本框或页面范围。请增大文本框、启用自动高度或调整字号；内容不会被自动截断。', 'Text exceeds the text box or page. Enlarge the frame, enable automatic height or adjust the font size. Text is never silently truncated.');
    if (error instanceof Error && error.message === 'FONT_LOAD_TIMEOUT') return t('所选字体载入超时，请刷新字体列表后重试。', 'The selected font took too long to load. Refresh the font list and try again.');
    if (error instanceof Error && error.message === 'SIGNATURE_IMAGE_INVALID') return t('无法读取签名图像。请重新制作或导入签名。', 'The signature image could not be read. Recreate or import the signature.');
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

  const place = (asset: RegisteredImage, name: string, requestedWidth = 0.3, blendMode: BlendMode = 'normal', textSource?: TextOverlaySource) => {
    if (!alive.current) return;
    const { pageWidth, pageHeight, overlays, onChange } = latest.current;
    if (overlays.length >= 30) throw new Error(t('当前页面最多添加 30 个内容对象。', 'A page can contain up to 30 added objects.'));
    let width = requestedWidth, height = width * pageWidth / pageHeight * asset.height / asset.width;
    if (textSource && (width > 1 || height > 1)) throw new Error('TEXT_PAGE_OVERFLOW');
    if (!textSource && height > 0.65) { width *= 0.65 / height; height = 0.65; }
    height = Math.max(textSource ? .001 : .01, height); width = Math.max(textSource ? .001 : .01, width);
    const overlay: Overlay = normalizedOverlay({ id: crypto.randomUUID(), assetId: asset.id, x: 0.12, y: 0.12, width, height, opacity: 1, rotation: 0, blendMode, ...(textSource ? { textSource } : {}) });
    if (onChange([...overlays, overlay]) === false) return;
    setSelectedOverlay(overlay.id);
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
    if (kind) {
      remember(asset, kind, name);
      if (kind === 'signature') { setLibraryFilter('signature'); setTab('library'); }
    } else place(asset, name);
  };

  const addText = (replaceId?: string, fit = false) => execute(async () => {
    if (!text.trim()) throw new Error(t('请先输入要添加的文字。', 'Enter the text to add.'));
    let source = { ...textSource };
    await ensureFontReady(source.fontFamily, source.content, source.bold, source.italic);
    if (!alive.current) return;
    let fitted: Overlay | undefined;
    if (fit && replaceId) {
      const previous = latest.current.overlays.find(item => item.id === replaceId);
      if (!previous?.textSource || previous.locked) return;
      fitted = fitTextFrame({ ...previous, textSource: source }, latest.current.pageWidth, latest.current.pageHeight);
      source = fitted.textSource!;
    }
    const png = createTextPng(source.content, source.color, source.fontSize, source.bold, source.fontFamily, source);
    if (png.overflow) throw new Error('TEXT_FRAME_OVERFLOW');
    if (source.frame) source.frame = { ...source.frame, width: png.width / 2, height: png.height / 2 };
    const width = png.width / 2 / latest.current.pageWidth, height = png.height / 2 / latest.current.pageHeight;
    if (width > 1 || height > 1) throw new Error('TEXT_PAGE_OVERFLOW');
    const asset = await register(png.dataUrl);
    if (!alive.current) return;
    if (replaceId) {
      const previous = latest.current.overlays.find(item => item.id === replaceId);
      if (!previous?.textSource || previous.locked) return;
      const quarterTurn = Math.abs(previous.rotation ?? 0) % 180 === 90;
      const visibleWidth = quarterTurn ? png.height / 2 / latest.current.pageWidth : width;
      const visibleHeight = quarterTurn ? png.width / 2 / latest.current.pageHeight : height;
      if (visibleWidth > 1 || visibleHeight > 1) throw new Error('TEXT_PAGE_OVERFLOW');
      latest.current.onChange(latest.current.overlays.map(item => item.id === replaceId ? normalizedOverlay({ ...item, ...(fitted ? { x: fitted.x, y: fitted.y } : {}), assetId: asset.id, width: visibleWidth, height: visibleHeight, textSource: source }) : item));
      setPreviews(values => ({ ...values, [asset.id]: asset.dataUrl }));
      setMessage(t('已更新选中文字，可撤销。', 'Selected text updated. Undo is available.'));
    } else place(asset, t('文字', 'Text'), width, 'normal', source);
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
  const pdfStampFullFresh = Boolean(pdfStampPath && pdfStampValidPage && pdfStampFullPage?.sourceKey === pdfStampSource);
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
    setPdfStampCrop(null); setPdfStampGhost(null);
    setMessage(t('页面已载入。拖动选择区域，预览会自动更新。', 'Page loaded. Drag to select regions; previews update automatically.'));
  };
  const choosePdfStamp = () => execute(async () => {
    const selected = await open({ multiple: false, title: t('选择内容片段来源 PDF', 'Choose a PDF fragment source'), filters: [{ name: t('PDF 文档', 'PDF documents'), extensions: ['pdf'] }] });
    if (!alive.current || !selected || Array.isArray(selected)) return;
    setPdfStampPath(selected); setPdfStampPage('1'); setPdfStampPageCount(0); setPdfStampName('');
    setPdfStampFullPage(null); setPdfStampCrop(null); setPdfStampGhost(null);
    // A newly chosen file must not be checked against the previous file's page count.
    const asset = await readPdfStamp(selected, '1', null, false, false);
    if (!alive.current) return;
    cache.current.set(asset.dataUrl, asset);
    setPdfStampPageCount(asset.pageCount); setPdfStampFullPage({ ...asset, sourceKey: pdfStampSourceKey(selected, '1') });
    setMessage(t('页面已载入。拖动选择区域，预览会自动更新。', 'Page loaded. Drag to select regions; previews update automatically.'));
  });
  const placeFragmentItems = async (items: PdfFragmentItem[], drop?: FragmentDrop) => {
    if (latest.current.onPlaceFragments) { await latest.current.onPlaceFragments(items, drop); return; }
    const current = latest.current;
    const added = fragmentOverlays(items, current.pageWidth, current.pageHeight, current.overlays, drop);
    current.onChange([...current.overlays, ...added]); setSelectedOverlay(added.at(-1)!.id);
  };
  const saveFragmentItems = (items: PdfFragmentItem[]) => {
    const next = [...library];
    for (const item of items) {
      const existing = next.find(value => value.kind === 'stamp' && value.dataUrl === item.image.dataUrl && (value.blendMode ?? 'normal') === item.blendMode);
      if (existing) continue;
      next.push({ id: crypto.randomUUID(), name: cleanLibraryName(item.name) || 'PDF', kind: 'stamp', dataUrl: item.image.dataUrl,
        width: item.image.width, height: item.image.height, blendMode: item.blendMode, createdAt: new Date().toISOString() });
    }
    persist(next);
  };
  const usePdfStamp = (mode: 'tray' | 'insert' | 'library') => execute(async () => {
    if (!pdfStampFullFresh || !pdfStampFullPage) throw new Error(t('请先载入选定的 PDF 页面。', 'Load the selected PDF page first.'));
    const crops = fragmentSelections(pdfStampCrop, pdfStampCombined);
    if (mode === 'insert' && latest.current.overlays.length + crops.length > 30) throw new Error('FRAGMENT_PAGE_LIMIT');
    const assets = await backend<ImageAsset[]>('create_image_fragments', { assetId: pdfStampFullPage.id, crops, removeWhiteBackground: pdfStampRemoveWhite, trimTransparentMargins: pdfStampTrim });
    if (!alive.current) return;
    if (assets.length !== crops.length) throw new Error('BACKEND_RESPONSE_INVALID: 片段数量与选区不一致。');
    const generated = assets.map((image, index): PdfFragmentItem => ({ id: crypto.randomUUID(),
      key: JSON.stringify([pdfStampPath, Number(pdfStampPage), pdfStampFullPage.id, crops[index], pdfStampRemoveWhite, pdfStampTrim, pdfStampBlend]),
      name: (pdfStampName.trim() || pdfStampDefaultName).slice(0, 72) + (crops.length > 1 ? ` · ${index + 1}` : ''), image, blendMode: pdfStampBlend }));
    const next = mergeFragments(latest.current.fragments ?? localFragments, generated);
    const items = generated.map(item => next.find(value => value.key === item.key)!);
    if (mode === 'insert') await placeFragmentItems(items);
    if (!alive.current) return;
    if (mode === 'library') saveFragmentItems(items);
    setFragments(next);
    if (mode !== 'library') setPdfStampOpen(false);
    setMessage(t(`已生成 ${items.length} 个独立片段，可在片段列表中拖放和管理。`, `${items.length} separate fragments ready. Drag and manage them in the list.`));
  });
  const selectedPdfCrop = pdfStampCrop ?? { x: 0, y: 0, width: 1, height: 1 };
  const previewCrops = fragmentSelections(pdfStampGhost ?? pdfStampCrop, pdfStampCombined);

  const updatePdfCrop = (patch: Partial<PdfStampCrop>) => { if (!locked && pdfStampFullFresh) setPdfStampCrop(transformSelection(selectedPdfCrop, { ...selectedPdfCrop, ...patch })); };

  const typedSignaturePreview = useMemo(() => {
    if (tab !== 'signature' || signatureMode !== 'type' || !signatureText.trim()) return null;
    try { return createTypedSignaturePng(signatureText, signatureColor); }
    catch { return null; }
  }, [tab, signatureMode, signatureText, signatureColor]);
  const canCreateSignature = signatureMode === 'draw' ? signatureReady : Boolean(typedSignaturePreview);

  const placeSignature = async (image: string, name: string, when: Date, blendMode: BlendMode = 'normal') => {
    const appearance = await timestampedSignaturePng(image, when);
    if (!alive.current) return;
    place(await register(appearance.dataUrl), name, 0.30, blendMode);
  };

  const createSignature = (addToPage: boolean) => execute(async () => {
    const when = new Date();
    let image;
    if (signatureMode === 'type') {
      await ensureFontReady(SIGNATURE_SCRIPT_FONT, signatureText, false, true);
      if (!alive.current) return;
      image = createTypedSignaturePng(signatureText, signatureColor);
    } else image = signatureCanvas.current && trimmedSignature(signatureCanvas.current);
    if (!image) throw new Error(t('请先书写或输入签名。', 'Draw or type a signature first.'));
    const name = signatureName.trim() || (signatureMode === 'type' ? signatureText.trim() : t('手写签名', 'Handwritten signature'));
    if (addToPage) await placeSignature(image.dataUrl, name, when);
    else remember(await register(image.dataUrl), 'signature', name);
  });

  const placeLibraryItem = (item: LibraryItem) => execute(async () => {
    if (item.kind === 'signature') await placeSignature(item.dataUrl, item.name, new Date(), item.blendMode);
    else place(await register(item.dataUrl), item.name, 0.22, item.blendMode);
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
  const [featureColor, setFeatureColor] = useState('#244b70');
  const recolorFeature = (item: Overlay, restore = false) => execute(async () => {
    if (!item.featureSource || item.locked) return;
    const asset = restore ? await backend<RegisteredImage>('get_image_asset', { assetId: item.featureSource.assetId }, 3)
      : await backend<RegisteredImage>('edit_feature', { request: { kind: 'tint', assetId: item.featureSource.assetId, color: featureColor } }, 3);
    const { overlays, onChange } = latest.current;
    if (!alive.current || !overlays.some(value => value.id === item.id && value.assetId === item.assetId && !value.locked)) return;
    if (onChange(overlays.map(value => value.id === item.id ? { ...value, assetId: asset.id } : value)) !== false) {
      setPreviews(previous => ({ ...previous, [asset.id]: asset.dataUrl }));
    }
  });
  useEffect(() => { setDraft(current ? { ...current } : null); }, [current]);
  const editable = draft?.id === current?.id ? draft : current;
  const draftChanged = Boolean(current && editable && JSON.stringify(current) !== JSON.stringify(editable));
  const updateDraft = (patch: Partial<Overlay>) => {
    if (!editable || locked || current?.locked) return;
    if (editable.textSource && (patch.width !== undefined || patch.height !== undefined)) setDraft(resizeTextFrame(editable, { ...editable, ...patch }, props.pageWidth, props.pageHeight));
    else if (patch.width !== undefined) setDraft(resizeOverlay(editable, 'width', patch.width, preserveAspect));
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
    { id: 'stamp', label: t('图章', 'Stamp'), icon: Stamp },
    { id: 'signature', label: t('签名', 'Sign'), icon: PenLine }, { id: 'library', label: t('本机库', 'Library'), icon: Upload },
  ];

  return <aside className="oe-panel overlay-editor" aria-label={t('内容编辑与印章', 'Content editing and stamps')}
    onKeyDown={event => {
      const target = event.target as HTMLElement;
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable;
      if (hasTextDraft && !composingText && event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); cancelTextDraft();
        if (selectedTextSource) loadTextSettings(selectedTextSource);
        return;
      }
      if (hasTextDraft && (event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault(); event.stopPropagation(); applyTextDraft(); return;
      }
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
    <header className="oe-header"><div><strong>{t('添加内容', 'Add content')}</strong><span>{t('文字、图片与图章', 'Text, images and stamps')}</span></div><button className="oe-icon" aria-label={t('关闭编辑工具', 'Close editing tools')} disabled={working} onClick={props.onClose}><X size={18} /></button></header>
    <nav className="oe-tabs" aria-label={t('添加内容类型', 'Content type')}>{tabs.map(({ id, label, icon: Icon }) => <button key={id} className={id === tab ? 'active' : ''} aria-pressed={id === tab} onClick={() => { setTab(id); setMessage(''); }}><Icon size={16} /><span>{label}</span></button>)}</nav>
    <div className="oe-scroll">
      {libraryUnavailable && <p className="oe-storage-warning" role="status">{t('本机库暂不可用。已保留原有数据；重新启动后可重试，添加到页面仍可使用。', 'The local library is unavailable. Existing data is preserved. Restart to retry; adding content to the page remains available.')}</p>}
      {tab === 'text' && <section className="oe-section oe-active-text" data-inline-text-edit
        onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) applyTextDraft(); }}>
        <h3>{selectedTextSource && !props.drawingText ? t('编辑选中文字', 'Edit selected text') : t('多行文字框', 'Multiline text box')}</h3>
        {props.onDrawText && <button className={`button ${props.drawingText?'primary':'secondary'} oe-draw-text`} aria-pressed={props.drawingText} disabled={locked} onClick={() => { if (applyTextDraft()) props.onDrawText?.(); }}><Type size={16}/>{props.drawingText?t('取消画文字框','Cancel drawing'):t('在页面上画文字框','Draw text box on page')}</button>}
        <label className="oe-field"><span>{t('文字内容', 'Text')}</span><textarea maxLength={4000} rows={3} value={text} disabled={textLocked} placeholder={t('输入中文或英文…', 'Enter text…')} onCompositionStart={() => setComposingText(true)} onCompositionEnd={() => setComposingText(false)} onChange={event => editText(setText)(event.target.value)} /></label>
        {textCommitError ? <p className="oe-note oe-text-edit-status" role="alert">{textCommitError}</p> : selectedTextSource && !props.drawingText && <p className="oe-note oe-text-edit-status">{hasTextDraft ? t('正在更新…', 'Updating…') : t('修改自动应用，可撤销。', 'Changes apply automatically and can be undone.')}</p>}
        <FontPicker value={textFont} onChange={editText(setTextFont)} disabled={textLocked} sample={text} resolveDefault={!selectedTextSource} compact/>
        <div className="oe-fields"><label className="oe-field"><span>{t('字号（pt）', 'Size (pt)')}</span><input {...sizeInput} disabled={textLocked}/></label><label className="oe-field oe-color-field"><span>{t('颜色', 'Color')}</span><input type="color" value={textColor} disabled={textLocked} onChange={event => editText(setTextColor)(event.target.value)} /></label></div>
        <div className="oe-text-styles">{[{ label: t('加粗', 'Bold'), value: bold, change: setBold }, { label: t('斜体', 'Italic'), value: italic, change: setItalic }, { label: t('下划线', 'Underline'), value: underline, change: setUnderline }, { label: t('删除线', 'Strikeout'), value: strikeout, change: setStrikeout }].map(style => <label className="oe-check" key={style.label}><input type="checkbox" checked={style.value} disabled={textLocked} onChange={event => editText(style.change)(event.target.checked)}/>{style.label}</label>)}</div>
        <details className="oe-text-options"><summary>{t('排版与边框', 'Layout and frame')}</summary>
        <div className="oe-fields"><label className="oe-field"><span>{t('段内对齐', 'Line alignment')}</span><select value={textAlignment} disabled={textLocked} onChange={event => editText(setTextAlignment)(event.target.value as typeof textAlignment)}><option value="left">{t('左对齐', 'Left')}</option><option value="center">{t('居中', 'Center')}</option><option value="right">{t('右对齐', 'Right')}</option></select></label><label className="oe-field"><span>{t('行距倍数', 'Line spacing')}</span><input {...leadingInput} disabled={textLocked}/></label></div>
        <div className="oe-fields"><label className="oe-field"><span>{t('字距（pt）', 'Character spacing (pt)')}</span><input {...spacingInput} disabled={textLocked}/></label><label className="oe-field"><span>{t('框宽（mm）', 'Box width (mm)')}</span><input {...widthInput} disabled={textLocked || !textWrap}/></label></div>
        <label className="oe-check"><input type="checkbox" checked={textWrap} disabled={textLocked} onChange={event => editText(setTextWrap)(event.target.checked)}/>{t('按框宽自动换行', 'Wrap to box width')}</label>
        {textWrap && <><label className="oe-check"><input type="checkbox" checked={textAutoHeight} disabled={textLocked} onChange={event => editText(setTextAutoHeight)(event.target.checked)}/>{t('高度随文字自动增长', 'Grow height to fit text')}</label><label className="oe-field"><span>{t('框高（mm）', 'Box height (mm)')}</span><input {...heightInput} disabled={textLocked || textAutoHeight}/></label></>}
        <div className="oe-text-frame-tools"><label className="oe-field"><span>{t('内边距（pt）', 'Padding (pt)')}</span><input {...paddingInput} disabled={textLocked}/></label>{current?.textSource && <button className="oe-action" disabled={textLocked || hasTextDraft || !text.trim() || !!textPreviewError} title={t('收紧文字边框，保留字号与文字位置。', 'Tighten the frame while retaining font size and position.')} onClick={() => void addText(current.id, true)}>{t('贴合文字', 'Fit to text')}</button>}</div>
        <p className="oe-note oe-frame-hint">{t('内边距可设为 0，文字可贴近页边；超出 PDF 的部分不能提交。数值输入可清空后重填。', 'Use zero padding to position text at page edges. Content must stay inside the PDF. Numeric fields can be cleared and retyped.')}</p>
        <div className="oe-checker oe-text-preview">{textPreview ? <PreviewZoom width={textPreview.width} height={textPreview.height} resetKey="added-text" label={t('文字排版预览', 'Text layout preview')}><img src={textPreview.dataUrl} alt={t('修改后文字', 'Edited text')}/></PreviewZoom> : <span>{textPreviewError ? t('排版超出限制，请调整字号或文本框。', 'Layout exceeds limits. Adjust size or box width.') : t('输入文字后显示预览', 'Enter text to preview')}</span>}</div>
        {textPreview && <p className="oe-note" role={textPreview.overflow ? 'alert' : undefined}>{textPreview.overflow ? t(`文字溢出：至少需要 ${(textPreview.requiredHeight / POINTS_PER_MM).toFixed(1)} mm 高度。请增高文本框或启用自动高度。`, `Text overflows: at least ${(textPreview.requiredHeight / POINTS_PER_MM).toFixed(1)} mm height is required. Enlarge the box or enable automatic height.`) : t(`共 ${textPreview.lineCount} 行 · 拖动框边改变排版，字号保持不变`, `${textPreview.lineCount} lines · Resizing the frame reflows text without changing its font size`)}</p>}
        </details>
        <div className="oe-text-actions"><button className="oe-action primary wide" disabled={locked || hasTextDraft || !text.trim() || !!textPreviewError || Boolean(textPreview?.overflow)} onClick={() => void addText()}><Plus size={15}/>{selectedTextSource ? t('另加一份文字', 'Add another text box') : t('添加到当前页', 'Add to this page')}</button></div>
      </section>}
      {tab === 'image' && <section className="oe-section"><h3>{t('添加图片', 'Add an image')}</h3><div className="oe-empty-symbol"><ImagePlus size={34} /></div><p className="oe-description">{t('选择本机 PNG 或 JPEG 图片，放到当前页面上。PNG 透明背景会保留。', 'Choose a local PNG or JPEG image and place it on this page. PNG transparency is preserved.')}</p><button className="oe-action primary" disabled={locked} onClick={() => void execute(() => importAsset())}><Upload size={15} />{t('选择图片', 'Choose image')}</button><p className="oe-note">{t('导入图像会进行尺寸与格式检查，最长边不超过 2400 像素。', 'Imported images are validated and limited to a 2400-pixel longest edge.')}</p></section>}
      {tab === 'stamp' && <section className="oe-section"><div className="oe-stamp-modes"><button className={stampMode === 'create' ? 'active' : ''} aria-pressed={stampMode === 'create'} disabled={locked} onClick={() => setStampMode('create')}>{t('制作文字图章', 'Text stamp')}</button><button className={stampMode === 'pdf' ? 'active' : ''} aria-pressed={stampMode === 'pdf'} disabled={locked} onClick={() => { setStampMode('pdf'); setPdfStampOpen(true); }}>{t('从 PDF 制作片段', 'PDF fragment')}</button></div>{stampMode === 'create' ? <><h3>{t('制作自定义图章', 'Create a custom stamp')}</h3><label className="oe-field"><span>{t('图章标题（最多 24 字）', 'Title (up to 24 characters)')}</span><input maxLength={24} value={stampTitle} disabled={locked} onChange={event => setStampTitle(event.target.value)} placeholder={t('填写自己的图章文字', 'Enter your own stamp text')} /></label><label className="oe-field"><span>{t('副标题', 'Subtitle')}</span><input maxLength={24} value={stampSubtitle} disabled={locked} onChange={event => setStampSubtitle(event.target.value)} placeholder={t('例如：审核通过', 'For example: REVIEWED')} /></label><FontPicker value={stampFont} onChange={setStampFont} disabled={locked} sample={stampTitle + (stampSubtitle ? '\n' + stampSubtitle : '')}/><div className="oe-fields"><label className="oe-field"><span>{t('形状', 'Shape')}</span><select value={stampShape} disabled={locked} onChange={event => setStampShape(event.target.value as StampShape)}><option value="round">{t('圆形', 'Round')}</option><option value="rectangle">{t('矩形', 'Rectangle')}</option></select></label><label className="oe-field oe-color-field"><span>{t('颜色', 'Color')}</span><input type="color" value={stampColor} disabled={locked} onChange={event => setStampColor(event.target.value)} /></label></div><div className="oe-checker oe-stamp-preview">{stampPreview ? <PreviewZoom width={stampPreview.width} height={stampPreview.height} resetKey="text-stamp" label={t('图章可缩放预览','Zoomable stamp preview')}><img src={stampPreview.dataUrl} alt={t('图章预览', 'Stamp preview')} /></PreviewZoom> : <span>{t('输入文字后显示预览', 'Enter text to preview')}</span>}</div><label className="oe-field"><span>{t('库中名称', 'Library name')}</span><input maxLength={80} value={stampName} disabled={locked} onChange={event => setStampName(event.target.value)} placeholder={stampTitle || t('自定义图章', 'Custom stamp')} /></label><div className="oe-button-row"><button className="oe-action primary" disabled={locked || !stampPreview} onClick={() => void createStamp(true)}><Plus size={14} />{t('添加到页面', 'Add to page')}</button><button className="oe-action" disabled={locked || !stampPreview} onClick={() => void createStamp(false)}><Stamp size={14} />{t('保存到本机库', 'Save to library')}</button></div><button className="oe-action wide" disabled={locked} onClick={() => void execute(() => importAsset('stamp'))}><Upload size={14} />{t('导入现有图章图片', 'Import a stamp image')}</button><p className="oe-note">{t('仅使用你有权使用的文字和图章。本机库中的项目可在“本机库”页导出 PNG。', 'Use only text and stamps you are entitled to use. Export library items as PNG from the Library tab.')}</p></> : <><h3>{t('从 PDF 制作内容片段', 'Create a fragment from PDF')}</h3><p className="oe-description">{t('在独立大窗口中框选、套索或点击多边形，实时检查透明裁切结果。', 'Use a large workspace for rectangular, freehand or polygon selections and live transparent previews.')}</p><button className="oe-action primary wide" disabled={locked} onClick={() => setPdfStampOpen(true)}><FileText size={15}/>{t('打开 PDF 片段工作台', 'Open PDF fragment workspace')}</button></>}{(stampMode === 'pdf' || fragments.length > 0) && <FragmentTray items={fragments} disabled={locked} onChange={setFragments} onPlace={(items, drop) => void execute(() => placeFragmentItems(items, drop))} onSave={item => void execute(async () => { saveFragmentItems([item]); setMessage(t('已保存到本机库。', 'Saved to the local library.')); })} onExport={item => void exportLibraryItem({ id: item.id, name: item.name, kind: 'stamp', dataUrl: item.image.dataUrl, width: item.image.width, height: item.image.height, blendMode: item.blendMode, createdAt: '' })}/>}</section>}
      {tab === 'signature' && <section className="oe-section">
        <h3>{t('制作签名', 'Create a signature')}</h3>
        <div className="oe-stamp-modes">
          <button className={signatureMode === 'draw' ? 'active' : ''} aria-pressed={signatureMode === 'draw'} disabled={locked} onClick={() => setSignatureMode('draw')}>{t('手写', 'Draw')}</button>
          <button className={signatureMode === 'type' ? 'active' : ''} aria-pressed={signatureMode === 'type'} disabled={locked} onClick={() => setSignatureMode('type')}>{t('键入姓名', 'Type your name')}</button>
        </div>
        <div hidden={signatureMode !== 'draw'}>
          <p className="oe-description">{t('用鼠标、触控或触控笔在下方书写。', 'Write below using a mouse, touch or pen.')}</p>
          <SignaturePad color={signatureColor} disabled={locked} resetKey={signatureReset} onChange={value => { signatureCanvas.current = value; setSignatureReady(Boolean(value)); }} />
        </div>
        {signatureMode === 'type' && <>
          <label className="oe-field"><span>{t('签名文字', 'Signature text')}</span><input maxLength={80} value={signatureText} disabled={locked} onChange={event => setSignatureText(event.target.value)} /></label>
          <div className="oe-checker oe-typed-signature">{typedSignaturePreview ? <img src={typedSignaturePreview.dataUrl} alt={t('签名预览', 'Signature preview')}/> : <span>{t('输入姓名以预览', 'Enter your name to preview')}</span>}</div>
        </>}
        <div className="oe-signature-options">
          <label className="oe-color-label"><span>{t('笔迹颜色', 'Ink')}</span><input type="color" value={signatureColor} disabled={locked} onChange={event => setSignatureColor(event.target.value)} /></label>
          {signatureMode === 'draw' && <button className="oe-small-button" disabled={locked} onClick={() => setSignatureReset(previous => previous + 1)}>{t('清空画布', 'Clear canvas')}</button>}
        </div>
        <label className="oe-field"><span>{t('模板名称（可选）', 'Template name (optional)')}</span><input maxLength={80} value={signatureName} disabled={locked} onChange={event => setSignatureName(event.target.value)} placeholder={t('我的签名', 'My signature')} /></label>
        <div className="oe-button-row">
          <button className="oe-action primary" disabled={locked || !canCreateSignature} onClick={() => void createSignature(true)}><Plus size={14} />{t('签名到当前页', 'Sign this page')}</button>
          <button className="oe-action" disabled={locked || !canCreateSignature} onClick={() => void createSignature(false)}><PenLine size={14} />{t('保存到本机库', 'Save to library')}</button>
        </div>
        <button className="oe-action wide" disabled={locked} onClick={() => void execute(() => importAsset('signature'))}><Upload size={14} />{t('导入签名图片', 'Import signature image')}</button>
        <p className="oe-note">{t('签名放入页面时记录本机日期、时间和 UTC 偏移。此时间随可见签名保存，属于本机时间记录。', 'Placing the signature records the device date, time and UTC offset. This local time is saved as part of the visible signature.')}</p>
      </section>}
      {tab === 'library' && <section className="oe-section"><div className="oe-section-heading"><h3>{t('本机内容库', 'Local content library')}</h3><span>{library.length}/{MAX_LIBRARY_ITEMS}</span></div><label className="oe-field"><span>{t('显示', 'Show')}</span><select value={libraryFilter} onChange={event => setLibraryFilter(event.target.value as typeof libraryFilter)}><option value="all">{t('全部', 'All')}</option><option value="stamp">{t('图章与片段', 'Stamps and fragments')}</option><option value="signature">{t('签名', 'Signatures')}</option></select></label><div className="oe-button-row"><button className="oe-action" disabled={locked} onClick={() => void execute(() => importAsset('stamp'))}><Upload size={14} />{t('导入图章', 'Import stamp')}</button><button className="oe-action" disabled={locked} onClick={() => void execute(() => importAsset('signature'))}><Upload size={14} />{t('导入签名', 'Import signature')}</button></div><p className="oe-note">{t('库保存在本机应用存储，不会上传。重要图章和签名请导出 PNG 备份；清除应用数据会移除库。', 'Stored only in this application on this device. Export important items as PNG backups. Clearing application data removes the library.')}</p><div className="oe-library-list">{library.filter(item => libraryFilter === 'all' || item.kind === libraryFilter).map(item => <article className="oe-library-item" key={item.id}><div className="oe-checker oe-library-preview"><img src={item.dataUrl} alt={item.name} /></div><label className="oe-field"><span>{item.kind === 'stamp' ? t('图章或片段名称', 'Stamp or fragment name') : t('签名名称', 'Signature name')}</span><input aria-label={t('重命名：', 'Rename: ') + item.name} value={renameDrafts[item.id] ?? item.name} maxLength={80} disabled={locked} onChange={event => setRenameDrafts(previous => ({ ...previous, [item.id]: event.target.value }))} onBlur={() => rename(item)} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></label><div className="oe-library-actions"><button disabled={locked} onClick={() => void placeLibraryItem(item)}><Plus size={13} />{t('加到页面', 'Place')}</button><button disabled={locked} onClick={() => void exportLibraryItem(item)}><Download size={13} />PNG</button><button className="oe-danger" disabled={locked} aria-label={t('从本机库移除：', 'Remove from local library: ') + item.name} onClick={() => { try { persist(library.filter(value => value.id !== item.id)); } catch (error) { latest.current.onError(libraryError(error)); } }}><Trash2 size={13} /></button></div></article>)}</div>{!library.some(item => libraryFilter === 'all' || item.kind === libraryFilter) && <div className="oe-library-empty"><Stamp size={30} /><p>{t('还没有保存的项目', 'No saved items yet')}</p><span>{t('制作图章、书写签名，或导入已有图片。', 'Create a stamp, draw a signature or import an image.')}</span></div>}</section>}
      {message && <div className="oe-message" role="status"><Check size={14} />{message}</div>}
      <section className="oe-section oe-object-section">
        <div className="oe-section-heading"><h3>{t('当前页添加的内容', 'Added objects on this page')}</h3><span>{props.overlays.length}/30</span></div>
        {props.overlays.length === 0 ? <p className="oe-note">{t('添加内容后，可以在这里选择对象并调整位置和大小。', 'Add an object, then select it here to adjust position and size.')}</p> : <>
          <div className="oe-object-list">{props.overlays.map((item, index) => <button key={item.id} className={item.id === selectedOverlay ? 'selected' : ''} disabled={locked} onClick={() => setSelectedOverlay(item.id)}><span className="oe-object-thumb">{previews[item.assetId] ? <img src={previews[item.assetId]} alt=""/> : <ImagePlus size={14}/>}</span><span>{labels[item.id] || `${t('对象', 'Object')} ${index + 1}`}</span>{item.locked && <LockKeyhole size={11}/>}<small>{index + 1}</small></button>)}</div>
          {current && editable && <div className="oe-object-properties">
            {current.featureSource && <><label className="oe-color-label"><span>{t('片段笔迹颜色', 'Feature ink color')}</span><input type="color" value={featureColor} disabled={locked || Boolean(current.locked)} onChange={event => setFeatureColor(event.target.value)}/></label><div className="oe-button-row"><button className="oe-action" disabled={locked || Boolean(current.locked)} onClick={() => void recolorFeature(current)}>{t('应用片段颜色', 'Apply feature color')}</button><button className="oe-action" disabled={locked || Boolean(current.locked) || current.assetId === current.featureSource.assetId} onClick={() => void recolorFeature(current, true)}>{t('恢复原色', 'Restore original color')}</button></div></>}
            <div className="oe-unit-row"><span>{t('坐标与尺寸单位', 'Position and size units')}</span><select aria-label={t('坐标与尺寸单位', 'Position and size units')} value={measureUnit} disabled={locked} onChange={event => setMeasureUnit(event.target.value as '%' | 'mm')}><option value="mm">{t('毫米 (mm)', 'Millimeters (mm)')}</option><option value="%">{t('页面百分比 (%)', 'Page percentage (%)')}</option></select></div>
            <div className="oe-fields">
              <MeasureField label={t('左边距', 'Left')} value={editable.x} maximum={1 - editable.width} extent={props.pageWidth} unit={measureUnit} disabled={locked || Boolean(current.locked)} onChange={x => updateDraft({ x })}/>
              <MeasureField label={t('上边距', 'Top')} value={editable.y} maximum={1 - editable.height} extent={props.pageHeight} unit={measureUnit} disabled={locked || Boolean(current.locked)} onChange={y => updateDraft({ y })}/>
              <MeasureField label={t('宽度', 'Width')} value={editable.width} minimum={MIN_OVERLAY_SIDE} maximum={1 - editable.x} extent={props.pageWidth} unit={measureUnit} disabled={locked || Boolean(current.locked)} onChange={width => updateDraft({ width })}/>
              <MeasureField label={t('高度', 'Height')} value={editable.height} minimum={MIN_OVERLAY_SIDE} maximum={1 - editable.y} extent={props.pageHeight} unit={measureUnit} disabled={locked || Boolean(current.locked)} onChange={height => updateDraft({ height })}/>
            </div>
            {current.textSource ? <p className="oe-note">{t('文字框宽高独立调整，文字自动重排，字号保持不变。', 'Text box dimensions change independently. Text reflows at the same font size.')}</p> : <label className="oe-check"><input type="checkbox" checked={preserveAspect} disabled={locked || Boolean(current.locked)} onChange={event => setPreserveAspect(event.target.checked)}/>{t('调整尺寸时保持比例', 'Keep aspect ratio when resizing')}</label>}
            <label className="oe-field"><span>{t('合成方式', 'Blend mode')}</span><select value={editable.blendMode ?? 'normal'} disabled={locked || Boolean(current.locked)} onChange={event => updateDraft({ blendMode: event.target.value as BlendMode })}><option value="normal">{t('正常', 'Normal')}</option><option value="multiply">{t('正片叠底', 'Multiply')}</option></select></label>
            <label className="oe-field oe-opacity"><span>{t('不透明度', 'Opacity')} <b>{Math.round(editable.opacity * 100)}%</b></span><input type="range" min="5" max="100" value={Math.round(editable.opacity * 100)} disabled={locked || Boolean(current.locked)} onChange={event => updateDraft({ opacity: Number(event.target.value) / 100 })}/></label>
            <button className="oe-action primary wide" disabled={locked || Boolean(current.locked) || !draftChanged} onClick={applyDraft}><Check size={14}/>{t('应用位置与大小', 'Apply position and size')}</button>
            <div className="oe-align-grid" aria-label={t('相对页面对齐', 'Align relative to page')}>{alignments.map(alignment => <button key={alignment.id} disabled={locked || Boolean(current.locked)} onClick={() => commitOverlay(alignedOverlay(editable, alignment.id))}>{alignment.label}</button>)}</div>
            {!current.textSource && !current.markSource && !current.leaderFor && <button className="oe-action wide" disabled={locked || Boolean(current.locked)} onClick={() => void execute(async () => { const asset = await backend<RegisteredImage>('get_image_asset',{assetId:current.assetId},3); if (alive.current) setImageEdit({ id: current.id, asset }); })}>{t('裁切 / 橡皮擦','Crop / Eraser')}</button>}
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
    {imageEdit && <ImageEditDialog image={imageEdit.asset} title={labels[imageEdit.id] || t('当前图像对象', 'Current image object')} onClose={() => setImageEdit(null)} onBusyChange={props.onBusyChange} onApply={image => {
      const { overlays, onChange } = latest.current;
      if (!overlays.some(item => item.id === imageEdit.id && item.assetId === imageEdit.asset.id && !item.locked && !item.textSource && !item.markSource && !item.leaderFor)) return;
      if (onChange(overlays.map(item => item.id === imageEdit.id ? { ...item, assetId: image.id } : item)) !== false) setPreviews(previous => ({ ...previous, [image.id]: image.dataUrl }));
    }}/>} 
    {pdfStampOpen && <div className="image-workbench-backdrop" onKeyDown={event => { event.stopPropagation(); if ((event.ctrlKey || event.metaKey) && ['s','o','p'].includes(event.key.toLowerCase())) event.preventDefault(); if (event.key === 'Escape' && !locked) setPdfStampOpen(false); }}><section ref={pdfDialog} tabIndex={-1} className="image-workbench pdf-fragment-workbench" role="dialog" aria-modal="true" aria-label={t('PDF 片段工作台', 'PDF fragment workspace')}>
      <header><div><h2>{t('从 PDF 制作内容片段', 'Create a fragment from PDF')}</h2><p>{t('矩形、椭圆、多边形或自由套索，最多 16 区；默认每个选区独立生成。', 'Select up to 16 rectangle, ellipse, polygon or freehand regions. Each becomes a separate fragment by default.')}</p></div><button disabled={locked} onClick={() => setPdfStampOpen(false)} aria-label={t('关闭片段工作台','Close fragment workspace')}><X size={20}/></button></header>
      <div className="image-workbench-body"><aside className="image-workbench-options">
        <button className="oe-action wide" disabled={locked} onClick={() => void choosePdfStamp()}><FileText size={15}/>{pdfStampPath ? t('更换来源 PDF','Change source PDF') : t('选择来源 PDF','Choose source PDF')}</button>
        {pdfStampPath && <><p className="oe-note">{pdfStampPath.split(/[\\/]/).pop()}</p><label className="oe-field"><span>{t('来源页码','Source page')} / {pdfStampPageCount}</span><input aria-label={t('PDF 片段来源页码','PDF fragment source page')} type="number" min={1} max={pdfStampPageCount || undefined} disabled={locked} value={pdfStampPage} onChange={event => setPdfStampPage(event.target.value)}/></label><button className="oe-action wide" disabled={locked || !pdfStampValidPage} onClick={() => void execute(() => loadPdfStampPage(pdfStampPath,pdfStampPage))}>{t('载入此页','Load page')}</button></>}
        <label className="oe-field"><span>{t('选区形状','Selection shape')}</span><select value={pdfStampShape} disabled={locked} onChange={event => setPdfStampShape(event.target.value as SelectionShape)}>{(['rectangle','ellipse','polygon','lasso'] as const).map((value,n) => <option key={value} value={value}>{[t('矩形','Rectangle'),t('椭圆','Ellipse'),t('多边形','Polygon'),t('自由套索','Freehand lasso')][n]}</option>)}</select></label>
        <button className="oe-small-button" disabled={locked} onClick={() => setPdfStampCrop(null)}>{t('使用整页','Use whole page')}</button>
        <div className="oe-fields"><PercentField label={t('左边距','Left')} value={selectedPdfCrop.x} maximum={1-selectedPdfCrop.width} disabled={locked} onChange={x => updatePdfCrop({x})}/><PercentField label={t('上边距','Top')} value={selectedPdfCrop.y} maximum={1-selectedPdfCrop.height} disabled={locked} onChange={y => updatePdfCrop({y})}/><PercentField label={t('选区宽度','Region width')} value={selectedPdfCrop.width} minimum={.002} maximum={1-selectedPdfCrop.x} disabled={locked} onChange={width => updatePdfCrop({width})}/><PercentField label={t('选区高度','Region height')} value={selectedPdfCrop.height} minimum={.002} maximum={1-selectedPdfCrop.y} disabled={locked} onChange={height => updatePdfCrop({height})}/></div>
        <label className="oe-check"><input type="checkbox" checked={pdfStampRemoveWhite} disabled={locked} onChange={event => setPdfStampRemoveWhite(event.target.checked)}/>{t('白底转透明','Make near-white transparent')}</label><label className="oe-check"><input type="checkbox" checked={pdfStampTrim} disabled={locked} onChange={event => setPdfStampTrim(event.target.checked)}/>{t('裁掉透明边缘','Trim transparent margins')}</label>
        <label className="oe-check fragment-combine-option"><input type="checkbox" checked={pdfStampCombined} disabled={locked} onChange={event => setPdfStampCombined(event.target.checked)}/>{t('将选区合成为一个整体（默认关闭）', 'Combine regions into one item (off by default)')}</label>
        <label className="oe-field"><span>{t('合成方式','Blend mode')}</span><select aria-label={t('片段合成方式','Fragment blend mode')} value={pdfStampBlend} disabled={locked} onChange={event => setPdfStampBlend(event.target.value as BlendMode)}><option value="multiply">{t('正片叠底','Multiply')}</option><option value="normal">{t('正常','Normal')}</option></select></label>
        <label className="oe-field"><span>{t('片段名称','Fragment name')}</span><input maxLength={80} value={pdfStampName} disabled={locked} placeholder={pdfStampDefaultName} onChange={event => setPdfStampName(event.target.value)}/></label>
        <p className="oe-note">{t('内容片段是透明图像；来源 PDF 保持原样。浅色内容建议保留原色并使用正片叠底。','Fragments are images; source PDFs stay unchanged. Keep pale colors and use Multiply when appropriate.')}</p>
      </aside><main className="image-workbench-stage pdf-fragment-source">{pdfStampFullFresh && pdfStampFullPage ? <PdfStampSelection key={pdfStampFullPage.sourceKey} image={pdfStampFullPage} crop={pdfStampCrop} shape={pdfStampShape} onChange={setPdfStampCrop} onPreview={setPdfStampGhost} disabled={locked}/> : <div className="dt-empty"><FileText size={42}/><p>{pdfStampPath ? t('页码已变化，请先载入此页。','The page changed. Load this page first.') : t('选择来源 PDF 后在此处显示整页。','Choose a source PDF to display its page here.')}</p></div>}</main>
      <aside className="image-workbench-result"><h3>{t(`实时预览 · ${previewCrops.length} 个独立片段`, `Live preview · ${previewCrops.length} separate fragments`)}</h3><div className="pdf-fragment-result-list">{pdfStampFullFresh && pdfStampFullPage && previewCrops.map((crop, index) => <PdfFragmentPreview key={`${pdfStampFullPage.id}-${index}`} source={pdfStampFullPage} crop={crop} index={index} removeWhite={pdfStampRemoveWhite} trim={pdfStampTrim}/>)}</div><p>{t('预览自动更新，无需手动刷新。默认每个选区分别生成、分别插入；列表保留后可多次拖放。', 'Previews update automatically. Each region generates and inserts separately by default; reuse the list to drag fragments onto pages.')}</p></aside></div>
      <footer><span>{t('生成后在右侧片段列表中管理；原 PDF 不变。', 'Manage generated fragments in the right-hand list. Source PDF is retained.')}</span><button className="button secondary" disabled={locked || !pdfStampFullFresh} onClick={() => void usePdfStamp('library')}>{t('保存到本机库','Save to library')}</button><button className="button secondary" disabled={locked || !pdfStampFullFresh} onClick={() => void usePdfStamp('insert')}><Plus size={15}/>{t('分别插入当前页','Insert each fragment')}</button><button className="button primary" disabled={locked || !pdfStampFullFresh} onClick={() => void usePdfStamp('tray')}>{t('生成到片段列表','Create fragment list')}</button></footer>
    </section></div>}
    <footer className="oe-footer">{t('页面内容可撤销；保存副本会将内容写入 PDF。', 'Page edits can be undone. Save a copy to write them into the PDF.')}</footer>
  </aside>;
}

export default OverlayEditor;
