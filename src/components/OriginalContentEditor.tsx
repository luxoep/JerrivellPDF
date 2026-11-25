// SPDX-License-Identifier: MIT OR Apache-2.0
import { useEffect, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { Check, CircleAlert, Copy, FileText, ImagePlus, LoaderCircle, RefreshCw, RotateCcw, Scissors, Trash2, X } from 'lucide-react';
import { backend, errorMessage } from '../backend';
import { useI18n } from '../i18n';
import { contentEditFor, contentObjectId, geometryFromMillimeters, MAX_CONTENT_EDITS, POINTS_PER_MILLIMETER, removeContentEdit, upsertContentEdit } from '../originalContent';
import type { ContentBounds, ContentChange, ContentEdit, ContentLayer, ContentObject } from '../originalContent';
import { FontPicker } from './FontPicker';
import { DEFAULT_FONT_FAMILY, finishInlineTextEvent } from './overlayCanvas';
import { ImageEditDialog } from './ImageEditDialog';
import type { ImageAsset, PageRef } from '../types';
import './original-content.css';

export interface OriginalContentEditorProps {
  page?: PageRef;
  eraseMode?: boolean;
  onEraseMode?: (value: boolean) => void;
  layer?: ContentLayer;
  onLayerChange?: (value: ContentLayer) => void;
  pageWidth: number;
  pageHeight: number;
  objects: ContentObject[];
  contentEdits: ContentEdit[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onChange: ContentChange;
  inspectionKey?: string;
  loading?: boolean;
  error?: string;
  warnings?: string[];
  truncated?: boolean;
  totalObjects?: number;
  disabled?: boolean;
  onRefresh?: () => void;
  onClose: () => void;
  onError: (message: string) => void;
  onBusyChange?: (busy: boolean) => void;
  onTextEditingChange?: (editing: boolean) => void;
  onEditLines?: () => void;
  onExtractFeature?: () => void;
}
type GeometryDraft = { x: string; y: string; width: string; height: string };
type Draft = { text: string; fontSize: string; fillColor: string; replaceFont: boolean; fontFamily: string; fontChoiceChanged: boolean; bold: boolean; italic: boolean; opacity: string; geometry: GeometryDraft; geometryChanged: boolean };
const formatMillimeters = (fraction: number, points: number) => (fraction * points / POINTS_PER_MILLIMETER).toFixed(2);
function geometryDraft(bounds: ContentBounds, width: number, height: number): GeometryDraft {
  return { x: formatMillimeters(bounds.x, width), y: formatMillimeters(bounds.y, height), width: formatMillimeters(bounds.width, width), height: formatMillimeters(bounds.height, height) };
}
function initialDraft(object: ContentObject, edit: ContentEdit | undefined, width: number, height: number, keepSourceFont: boolean): Draft {
  return { text: object.text ?? '', fontSize: object.fontSize == null ? '' : String(object.fontSize), fillColor: object.fillColor ?? '#000000',
    replaceFont: !keepSourceFont || Boolean(edit?.fontFamily), fontFamily: edit?.fontFamily ?? DEFAULT_FONT_FAMILY, fontChoiceChanged: false,
    bold: edit?.bold ?? object.bold ?? false, italic: edit?.italic ?? object.italic ?? false,
    opacity: String(Math.round((object.opacity ?? 1) * 100)),
    geometry: geometryDraft(object.bounds, width, height), geometryChanged: false };
}

export function OriginalContentEditor(props: OriginalContentEditorProps) {
  const { t } = useI18n();
  const filter = props.layer ?? 'all';
  const [draft, setDraft] = useState<Draft | null>(null);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('');
  const [validationError, setValidationError] = useState('');
  const [imageEdit, setImageEdit] = useState<{asset: ImageAsset; object: ContentObject; inspectionKey?: string} | null>(null);
  const alive = useRef(true);
  const pending = useRef(false);
  const pendingText = useRef(false);
  const keepSourceFontFor = useRef<string | null>(null);
  const composingText = useRef(false);
  const applyTextRef = useRef<() => void>(() => {});
  const releaseBusy = useRef<(() => void) | null>(null);
  const latest = useRef(props); latest.current = props;
  const object = props.objects.find(item => contentObjectId(item) === props.selectedId);
  const sourceEdit = object ? contentEditFor(props.contentEdits, object) : undefined;
  const objectKey = object ? `${object.objectIndex}:${object.fingerprint}` : '';
  const objectSignature = object ? JSON.stringify([object, sourceEdit]) : '';
  const blocked = Boolean(props.disabled || props.loading || working);
  const canEdit = Boolean(object?.editable && !object.deleted && !blocked);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; releaseBusy.current?.(); };
  }, []);
  useEffect(() => {
    if (keepSourceFontFor.current !== objectKey) keepSourceFontFor.current = null;
    releaseTextDraft();
    setDraft(object ? initialDraft(object, sourceEdit, props.pageWidth, props.pageHeight, keepSourceFontFor.current === objectKey) : null);
  }, [objectKey, objectSignature, props.pageWidth, props.pageHeight]);
  useEffect(() => { setMessage(''); setValidationError(''); }, [props.selectedId, object?.fingerprint]);

  const execute = async (task: () => Promise<void>) => {
    if (pending.current || latest.current.disabled || latest.current.loading) return;
    pending.current = true; setWorking(true); setMessage(''); setValidationError('');
    const callback = latest.current.onBusyChange;
    let released = false;
    const release = () => { if (!released) { released = true; callback?.(false); } };
    releaseBusy.current = release; callback?.(true);
    try { await task(); }
    catch (reason) { if (alive.current) { const explanation = errorMessage(reason); setValidationError(explanation); latest.current.onError(explanation); } }
    finally { pending.current = false; if (alive.current) setWorking(false); release(); if (releaseBusy.current === release) releaseBusy.current = null; }
  };
  function releaseTextDraft() {
    if (!pendingText.current) return;
    pendingText.current = false;
    latest.current.onTextEditingChange?.(false);
  }
  const editText = (patch: Partial<Draft>) => {
    if (!pendingText.current) {
      pendingText.current = true;
      latest.current.onTextEditingChange?.(true);
    }
    if (validationError) setValidationError('');
    setDraft(current => current ? { ...current, ...patch } : current);
  };
  const commit = async (next: ContentEdit[], success: string) => {
    if (next.length > MAX_CONTENT_EDITS) throw new Error(t('每页最多修改 128 个原有对象，请恢复部分对象或分批处理。', 'A page supports edits to at most 128 original objects. Reset some objects or use smaller groups.'));
    const result = await latest.current.onChange(next);
    if (result !== false && alive.current) setMessage(success);
    return result !== false;
  };
  const apply = () => execute(async () => {
    if (!object || !draft || !object.editable || object.deleted) return;
    const patch: Partial<Omit<ContentEdit, 'objectIndex' | 'fingerprint'>> = {};
    if (draft.geometryChanged) {
      try { patch.bounds = geometryFromMillimeters(draft.geometry, props.pageWidth, props.pageHeight); }
      catch { throw new Error(t('位置与尺寸须为有效毫米数值，且对象应位于页面范围内。', 'Enter valid millimeter values with the object inside the page.')); }
    }
    const appliesText = object.kind === 'text' && pendingText.current;
    if (appliesText) {
      if (draft.text !== (object.text ?? '')) {
        if (!draft.text.trim() || [...draft.text].length > 2000 || /[\u0000-\u001f\u007f]/.test(draft.text)) throw new Error(t('每个文字对象须为 1～2000 个字符的单行文字；清空内容请使用删除对象。', 'Use one line of 1–2000 characters per text object. Delete the object to remove its text.'));
        patch.text = draft.text;
      }
      if (draft.fontSize.trim() !== '' && Number(draft.fontSize) !== object.fontSize) {
        const size = Number(draft.fontSize);
        if (!Number.isFinite(size) || size < 1 || size > 512) throw new Error(t('字号必须为 1～512 pt。', 'Font size must be between 1 and 512 pt.'));
        patch.fontSize = size;
      }
      if (draft.fillColor.toLowerCase() !== (object.fillColor ?? '#000000').toLowerCase()) patch.fillColor = draft.fillColor;
      const opacity = Number(draft.opacity) / 100;
      if (!draft.opacity.trim() || !Number.isFinite(opacity) || opacity < .05 || opacity > 1) throw new Error(t('不透明度须为 5%～100%。', 'Opacity must be between 5% and 100%.'));
      if (Number(draft.opacity) !== Math.round((object.opacity ?? 1) * 100)) patch.opacity = opacity;
      if (draft.fontChoiceChanged || patch.text !== undefined || patch.fontSize !== undefined || patch.fillColor !== undefined || patch.opacity !== undefined) {
        if (draft.replaceFont) {
          if (draft.fontFamily !== sourceEdit?.fontFamily) patch.fontFamily = draft.fontFamily;
          if (draft.bold !== (sourceEdit?.bold ?? false)) patch.bold = draft.bold;
          if (draft.italic !== (sourceEdit?.italic ?? false)) patch.italic = draft.italic;
        } else if (sourceEdit?.fontFamily) {
          patch.fontFamily = undefined; patch.bold = undefined; patch.italic = undefined;
        }
      }
    }
    const previousFontPreference = keepSourceFontFor.current;
    if (appliesText) keepSourceFontFor.current = draft.replaceFont ? null : objectKey;
    let applied = false;
    try {
      applied = !Object.keys(patch).length || await commit(upsertContentEdit(props.contentEdits, object, patch), t('原文已更新，可撤销。', 'Original text updated. Undo is available.'));
      if (applied) releaseTextDraft();
      else if (alive.current && pendingText.current) setValidationError(t('修改未通过校验，草稿仍保留。请选择支持所需字形的本机字体、取消更换字体，或按 Esc 放弃。', 'The edit could not be validated. Choose an installed font with the required characters, keep the source font, or press Esc to discard.'));
    } finally {
      if (!applied && appliesText) keepSourceFontFor.current = previousFontPreference;
    }
  });
  applyTextRef.current = () => { if (pendingText.current && !composingText.current) void apply(); };
  useEffect(() => {
    if (!latest.current.onTextEditingChange) return;
    const finish = () => applyTextRef.current();
    window.addEventListener(finishInlineTextEvent, finish);
    return () => { window.removeEventListener(finishInlineTextEvent, finish); releaseTextDraft(); };
  }, []);
  const replaceImage = () => execute(async () => {
    if (!object?.editable || object.deleted || object.kind !== 'image') return;
    const path = await open({ multiple: false, directory: false, title: t('替换原有图片', 'Replace original image'), filters: [{ name: t('图片', 'Images'), extensions: ['png', 'jpg', 'jpeg'] }] });
    if (!path || !alive.current) return;
    const asset = await backend<{ id: string }>('import_image', { path: Array.isArray(path) ? path[0] : path });
    if (!alive.current) return;
    await commit(upsertContentEdit(props.contentEdits, object, { replacementAssetId: asset.id }), t('图片已替换，当前位置与边界框保留。', 'Image replaced, retaining its placement and bounds.'));
  });
  const toggleDeleted = () => execute(async () => {
    if (!object?.editable) return;
    await commit(upsertContentEdit(props.contentEdits, object, { deleted: !object.deleted }), object.deleted ? t('对象已恢复。', 'Object restored.') : t('对象已从页面内容中移除，可撤销或恢复。', 'Object removed from page content. Undo or restore it to recover.'));
  });
  const restore = () => execute(async () => {
    if (!object) return;
    await commit(removeContentEdit(props.contentEdits, object), t('该对象已恢复为来源中的原始状态。', 'This object was restored to its original source state.'));
  });
  const clearBounds = () => execute(async () => {
    if (!object?.editable || object.deleted) return;
    await commit(upsertContentEdit(props.contentEdits, object, { bounds: undefined }), t('已清除手动位置与尺寸；文字及字体修改保留，使用来源位置与自然文字尺寸。', 'Manual placement and size cleared. Text and font changes remain, using the source placement and natural text dimensions.'));
  });
  const copyText = async () => {
    if (!object || object.kind !== 'text') return;
    try { await navigator.clipboard.writeText(draft?.text ?? object.text ?? ''); if (alive.current) setMessage(t('文字已复制。', 'Text copied.')); }
    catch (reason) { if (alive.current) latest.current.onError(errorMessage(reason)); }
  };
  const geometryFields: { key: keyof GeometryDraft; label: string }[] = [
    { key: 'x', label: t('左边距', 'Left') }, { key: 'y', label: t('上边距', 'Top') }, { key: 'width', label: t('宽度', 'Width') }, { key: 'height', label: t('高度', 'Height') },
  ];
  const filtered = props.objects.filter(item => filter === 'all' || item.kind === filter);
  const kindName = (kind: ContentObject['kind']) => kind === 'text' ? t('文字', 'Text') : kind === 'image' ? t('图片', 'Image') : kind === 'path' ? t('矢量线条与形状', 'Vector paths') : t('其他内容', 'Other content');
  const editPixels = () => void execute(async () => {
    if (!props.page || !object || object.kind !== 'image' || !object.editable || object.deleted) return;
    const asset = await backend<ImageAsset>('extract_content_image',{page:props.page,objectIndex:object.objectIndex,fingerprint:object.fingerprint},3);
    if (alive.current && latest.current.inspectionKey === props.inspectionKey && latest.current.selectedId === contentObjectId(object)) {
      setImageEdit({asset, object, inspectionKey:props.inspectionKey});
    }
  });
  return <aside className="original-editor" aria-label={t('编辑 PDF 原有内容', 'Edit original PDF content')} onKeyDown={event =>
    {
    const target = event.target as HTMLElement;
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable;
    if (pendingText.current && !composingText.current && !pending.current && event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); releaseTextDraft(); setValidationError('');
      if (object) setDraft(initialDraft(object, sourceEdit, props.pageWidth, props.pageHeight, keepSourceFontFor.current === objectKey));
      return;
    }
    if (pendingText.current && (event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault(); event.stopPropagation(); applyTextRef.current(); return;
    }
    if (!event.ctrlKey && !event.metaKey) event.stopPropagation();
    if (!typing && (event.key === 'Delete' || event.key === 'Backspace')) { event.preventDefault(); if (object?.editable && !object.deleted && !blocked) void toggleDeleted(); }
  }}>
    <header className="oc-header"><div><strong>{t('编辑原文', 'Edit original content')}</strong><span>{t('分别处理文字、矢量和图片对象', 'Work with text, vectors and images separately')}</span></div><button aria-label={t('关闭原文编辑', 'Close original content editor')} disabled={working} onClick={props.onClose}><X size={18}/></button></header>
    <div className="oc-object-tools">
      <label className="oc-field"><span>{t('对象图层','Object layer')}</span><select value={filter} disabled={blocked} onChange={event=>props.onLayerChange?.(event.target.value as ContentLayer)}>
        <option value="all">{t('所有对象','All objects')}</option>
        {(['text','path','image','unsupported'] as const).map(kind=><option key={kind} value={kind}>{kindName(kind)}</option>)}
      </select></label>
      {props.onEraseMode && <label className="oc-erase-mode"><input type="checkbox" checked={Boolean(props.eraseMode)} disabled={blocked} onChange={event=>props.onEraseMode?.(event.target.checked)}/>{t('点击删除整个对象','Click to delete an object')}</label>}
      {object?.kind === 'image' && <button className="oc-action oc-wide" disabled={!canEdit || !props.page} onClick={editPixels}>{t('图片裁切 / 橡皮擦','Image crop / Eraser')}</button>}
    </div>
    <div className="oc-scroll">{props.onEditLines && <section className="oc-section"><button className="oe-action wide" disabled={blocked} onClick={props.onEditLines}><FileText size={14}/>{t('文字行排版与修改后预览', 'Text-line formatting and result preview')}</button><p className="oc-note">{t('文字行工具提供字距、对齐、装饰线与目标框；保留可搜索的 PDF 文字。', 'The line tool provides spacing, alignment, decoration strokes and a target frame while retaining searchable PDF text.')}</p></section>}
      {props.onExtractFeature && <section className="oc-section"><button className="oe-action wide" disabled={blocked} onClick={props.onExtractFeature}><Scissors size={15}/>{t('提取或剪切特征','Extract or cut feature')}</button></section>}
      <section className="oc-section"><div className="oc-section-heading"><h3>{t('本页原有对象', 'Original page objects')}</h3><button disabled={blocked} onClick={props.onRefresh} aria-label={t('重新读取原有对象', 'Refresh original objects')}><RefreshCw size={13}/></button></div>
        {props.loading && <p className="oc-status" role="status"><LoaderCircle className="spin" size={14}/>{t('正在读取原有内容…', 'Reading original content…')}</p>}
        {props.error && <p className="oc-error" role="alert"><CircleAlert size={14}/>{props.error}</p>}
        {!props.loading && !props.error && !props.objects.length && <p className="oc-note">{t('未找到可列出的页面对象。扫描图片中的文字需要 OCR；轮廓字与嵌套内容不能按普通文字修改。', 'No page objects were listed. Text in scans requires OCR; outlined text and nested content cannot be edited as ordinary text.')}</p>}
        <div className="oc-object-list" aria-label={t('原有对象列表', 'Original object list')}>{filtered.map(item => <button key={`${item.objectIndex}:${item.fingerprint}`} className={`${contentObjectId(item) === props.selectedId ? 'selected' : ''} ${item.deleted ? 'oc-deleted' : ''}`} disabled={blocked} aria-pressed={contentObjectId(item) === props.selectedId} onClick={() => props.onSelect(contentObjectId(item))}>
          {item.kind === 'image' ? <ImagePlus size={15}/> : <FileText size={15}/>}<span><b>{kindName(item.kind)} {item.objectIndex + 1}{item.deleted && ` · ${t('已删除', 'Deleted')}`}</b><small>{item.kind === 'text' ? item.text || item.originalText || t('空文字对象', 'Empty text object') : item.reason || (item.kind === 'image' ? t('页面图像', 'Page image') : item.kind === 'path' ? t('选择后可删除整个对象', 'Select to delete the whole path') : t('暂不支持修改', 'Editing unavailable'))}</small></span>{!item.editable && <CircleAlert size={12}/>}</button>)}</div>
        {!props.loading && filter === 'image' && !filtered.length && <p className="oc-note">{t('本页没有独立图片对象。文字和线条可在对应图层删除。','No standalone images on this page. Use the text or vector layer to remove objects.')}</p>}
        <p className="oc-note">{t(`显示 ${filtered.length} 个对象 / 页面共 ${props.totalObjects ?? props.objects.length} 个。`, `${filtered.length} objects listed / ${props.totalObjects ?? props.objects.length} on the page.`)}{props.truncated && ' ' + t('对象较多，列表已截断。', 'The object list was truncated.')}</p>
        {props.warnings?.map((warning, index) => <p key={index} className="oc-note oc-warning">{warning}</p>)}
      </section>
      {object && draft && <section className="oc-section oc-properties"><div className="oc-section-heading"><h3>{kindName(object.kind)} {object.objectIndex + 1}</h3>{sourceEdit && <span>{t('已有修改', 'Modified')}</span>}</div>
        {!object.editable && <p className="oc-warning">{object.reason || t('此对象结构暂不支持直接编辑。', 'This object structure does not support direct editing.')}</p>}
        {object.deleted && <p className="oc-warning">{t('该对象已从当前页面移除，可使用下方按钮恢复。', 'This object is removed from the current page. Restore it below.')}</p>}
        {object.kind === 'text' && <div className="oc-text-fields" data-inline-text-edit onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) applyTextRef.current(); }}>
          <label className="oc-field"><span>{t('文字内容（单行）', 'Text content (single line)')}</span><textarea value={draft.text} disabled={!canEdit} maxLength={2000} onCompositionStart={() => { composingText.current = true; }} onCompositionEnd={() => { composingText.current = false; }} onChange={event => editText({ text: event.target.value })}/></label>
          <p className="oc-note oc-text-auto-note">{t('离开文字区自动应用，Esc 放弃修改。', 'Changes apply when you leave the text fields. Press Esc to discard.')}</p>
          <button className="oc-action oc-copy" disabled={blocked} onClick={() => void copyText()}><Copy size={12}/>{t('复制文字', 'Copy text')}</button>
          <details className="oc-original-text"><summary>{t('查看来源原文', 'View original source text')}</summary><p>{object.originalText ?? object.text ?? ''}</p></details>
          <p className="oc-note">{t('当前 PDF 字体：', 'Current PDF font: ')}<b>{object.fontFamily || t('未知字体', 'Unknown font')}</b></p>
          <div className="oc-fields"><label className="oc-field"><span>{t('字号（PDF pt）', 'Font size (PDF pt)')}</span><input type="number" min="1" max="512" step="0.1" value={draft.fontSize} disabled={!canEdit} onChange={event => editText({ fontSize: event.target.value })}/></label><label className="oc-field"><span>{t('文字颜色', 'Text color')}</span><input type="color" value={draft.fillColor} disabled={!canEdit} onChange={event => editText({ fillColor: event.target.value })}/></label></div>
          <label className="oc-checkbox"><input type="checkbox" disabled={!canEdit} checked={draft.replaceFont} onChange={event => editText({ replaceFont: event.target.checked, fontChoiceChanged: true })}/>{t('更换为本机字体', 'Replace with an installed font')}</label>
          {draft.replaceFont && <FontPicker value={draft.fontFamily} onChange={fontFamily => editText({ fontFamily, fontChoiceChanged: true })} onDefaultResolved={fontFamily => setDraft(current => current && { ...current, fontFamily })} disabled={!canEdit} sample={draft.text} embedForOriginal resolveDefault={!sourceEdit?.fontFamily} compact/>}
          {draft.replaceFont && <div className="oc-fields"><label className="oc-checkbox"><input type="checkbox" checked={draft.bold} disabled={!canEdit} onChange={event => editText({ bold: event.target.checked, fontChoiceChanged: true })}/>{t('粗体', 'Bold')}</label><label className="oc-checkbox"><input type="checkbox" checked={draft.italic} disabled={!canEdit} onChange={event => editText({ italic: event.target.checked, fontChoiceChanged: true })}/>{t('斜体', 'Italic')}</label></div>}
          <label className="oc-field"><span>{t('文字不透明度（%）', 'Text opacity (%)')}</span><input type="number" min="5" max="100" step="1" value={draft.opacity} disabled={!canEdit} onChange={event => editText({ opacity: event.target.value })}/></label>
          {Number(draft.opacity) < 100 && <p className="oc-note">{t('透明文字保存后仍可搜索。重新打开时，因透明度/蒙版的保护限制，可能无法再次直接编辑该原文对象；请保留原稿。', 'Transparent text remains searchable after saving. On reopening, transparency/mask safeguards may prevent direct re-editing of this object; retain the original.')}</p>}
          <p className="oc-note">{t('保留原字体时，新增字符可能不在原字体子集中。遇到缺字提示，请选择允许嵌入的本机字体；更换字体可能改变文字宽度。', 'With the original font, added characters may be absent from its subset. If glyphs are missing, choose an embeddable installed font; changing fonts may alter text width.')}</p>
        </div>}
        {object.kind === 'image' && <button className="oc-action oc-wide" disabled={!canEdit} onClick={() => void replaceImage()}><ImagePlus size={14}/>{t('替换图片，保留位置', 'Replace image, keep placement')}</button>}
        {object.editable && object.kind !== 'path' && <><h4>{t('精确位置与尺寸（mm）', 'Exact position and size (mm)')}</h4><div className="oc-fields">{geometryFields.map(field => <label key={field.key} className="oc-field"><span>{field.label}</span><input aria-label={`${field.label} mm`} type="number" step="0.1" min={field.key === 'width' || field.key === 'height' ? '0.01' : '0'} value={draft.geometry[field.key]} disabled={!canEdit} onChange={event => setDraft({ ...draft, geometry: { ...draft.geometry, [field.key]: event.target.value }, geometryChanged: true })}/></label>)}</div>
          <p className="oc-note">{object.kind === 'text' ? t('未设定边界框时，文字内容或字号修改使用自然宽度。已有位置/尺寸修改会继续保留；调整宽高会缩放对象外形，请检查相邻内容。', 'Without explicit bounds, text or font-size changes use natural width. Existing placement/size edits are retained; changing dimensions scales the object, so inspect neighboring content.') : t('替换图片保持原边界框，可能改变图片比例。可在此精确调整。', 'Replacing an image retains its bounds and may alter its aspect ratio. Adjust the dimensions here if needed.')}</p>
          {(object.kind === 'image' || draft.geometryChanged) && <button className="oc-action primary oc-wide" disabled={!canEdit} onClick={() => void apply()}><Check size={14}/>{t('应用位置与尺寸', 'Apply position and size')}</button>}
          {object.kind === 'text' && sourceEdit?.bounds && <><button className="oc-action oc-wide" disabled={!canEdit} onClick={() => void clearBounds()}><RotateCcw size={13}/>{t('清除手动位置与尺寸', 'Clear manual placement and size')}</button><p className="oc-note">{t('保留文字和字体修改，恢复来源位置并采用当前文字的自然宽高。', 'Keeps text and font edits, restores source placement, and uses the current text’s natural dimensions.')}</p></>}
        </>}
        <div className="oc-button-row"><button className="oc-action" disabled={blocked || !sourceEdit} onClick={() => void restore()}><RotateCcw size={13}/>{t('恢复原始内容', 'Reset to original')}</button>{object.editable && <button className={`oc-action ${object.deleted ? '' : 'oc-danger'}`} disabled={blocked} onClick={() => void toggleDeleted()}>{object.deleted ? <RotateCcw size={13}/> : <Trash2 size={13}/>} {object.deleted ? t('恢复该对象', 'Restore object') : t('删除该对象', 'Delete object')}</button>}</div>
        <p className="oc-note">{t('删除可见对象不等于安全涂黑；隐藏数据、其他对象或历史信息不在此操作的清理保证内。', 'Deleting a visible object is not secure redaction; this operation does not guarantee removal of hidden data, other objects or history.')}</p>
      </section>}
      {message && <p className="oc-message" role="status"><Check size={14}/>{message}</p>}{validationError && <p className="oc-error oc-message" role="alert">{validationError}</p>}
    </div>
    {working && <div className="oc-working" role="status"><LoaderCircle className="spin" size={14}/>{t('正在验证原文修改…', 'Validating original content changes…')}</div>}
    <footer className="oc-footer">{t('修改可撤销。保存副本后重新打开，原文修改仍保留。', 'Changes can be undone. Original content edits survive saving and reopening a copy.')}</footer>
    {imageEdit && <ImageEditDialog image={imageEdit.asset} initialMode="erase" title={t('原 PDF 图片对象','Original PDF image object')} notice={t('只修改这张图片的像素。同页文字、矢量线条和其他图片仍是独立对象。','Edits pixels in this image. Text, vector lines and other images remain separate page objects.')} onClose={() => setImageEdit(null)} onBusyChange={props.onBusyChange} onApply={async image => {
      const current = latest.current;
      if (current.inspectionKey !== imageEdit.inspectionKey || !current.objects.some(item => item.kind === 'image' && item.editable && !item.deleted && contentObjectId(item) === contentObjectId(imageEdit.object) && item.fingerprint === imageEdit.object.fingerprint)) {
        throw new Error(t('图片对象已变化，请重新打开。','The image object changed. Reopen the editor.'));
      }
      return current.onChange(upsertContentEdit(current.contentEdits,imageEdit.object,{replacementAssetId:image.id}));
    }}/>} 
  </aside>;
}
