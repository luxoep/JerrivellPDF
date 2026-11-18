// SPDX-License-Identifier: MIT OR Apache-2.0
import { useEffect, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { Check, CircleAlert, Copy, FileText, ImagePlus, LoaderCircle, RefreshCw, RotateCcw, Trash2, X } from 'lucide-react';
import { backend, errorMessage } from '../backend';
import { useI18n } from '../i18n';
import { contentEditFor, contentObjectId, geometryFromMillimeters, MAX_CONTENT_EDITS, POINTS_PER_MILLIMETER, removeContentEdit, upsertContentEdit } from '../originalContent';
import type { ContentBounds, ContentChange, ContentEdit, ContentObject } from '../originalContent';
import { FontPicker } from './FontPicker';
import { DEFAULT_FONT_FAMILY } from './overlayCanvas';
import { ImageEditDialog } from './ImageEditDialog';
import type { ImageAsset, PageRef } from '../types';
import './original-content.css';

export interface OriginalContentEditorProps {
  page?: PageRef;
  eraseMode?: boolean;
  onEraseMode?: (value: boolean) => void;
  onRasterEdit?: () => void;
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
  onEditLines?: () => void;
}
type GeometryDraft = { x: string; y: string; width: string; height: string };
type Draft = { text: string; fontSize: string; fillColor: string; replaceFont: boolean; fontFamily: string; bold: boolean; italic: boolean; opacity: string; geometry: GeometryDraft; geometryChanged: boolean };
const formatMillimeters = (fraction: number, points: number) => (fraction * points / POINTS_PER_MILLIMETER).toFixed(2);
function geometryDraft(bounds: ContentBounds, width: number, height: number): GeometryDraft {
  return { x: formatMillimeters(bounds.x, width), y: formatMillimeters(bounds.y, height), width: formatMillimeters(bounds.width, width), height: formatMillimeters(bounds.height, height) };
}
function initialDraft(object: ContentObject, edit: ContentEdit | undefined, width: number, height: number): Draft {
  return { text: object.text ?? '', fontSize: object.fontSize == null ? '' : String(object.fontSize), fillColor: object.fillColor ?? '#000000',
    replaceFont: Boolean(edit?.fontFamily), fontFamily: edit?.fontFamily ?? DEFAULT_FONT_FAMILY,
    bold: edit?.bold ?? object.bold ?? false, italic: edit?.italic ?? object.italic ?? false,
    opacity: String(Math.round((object.opacity ?? 1) * 100)),
    geometry: geometryDraft(object.bounds, width, height), geometryChanged: false };
}

export function OriginalContentEditor(props: OriginalContentEditorProps) {
  const { t } = useI18n();
  const [filter, setFilter] = useState<'all' | 'text' | 'image' | 'unsupported'>('all');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('');
  const [validationError, setValidationError] = useState('');
  const [imageEdit, setImageEdit] = useState<ImageAsset | null>(null);
  const alive = useRef(true);
  const pending = useRef(false);
  const releaseBusy = useRef<(() => void) | null>(null);
  const latest = useRef(props); latest.current = props;
  const object = props.objects.find(item => contentObjectId(item) === props.selectedId);
  const sourceEdit = object ? contentEditFor(props.contentEdits, object) : undefined;
  const objectSignature = object ? JSON.stringify([object, sourceEdit]) : '';
  const blocked = Boolean(props.disabled || props.loading || working);
  const canEdit = Boolean(object?.editable && !object.deleted && !blocked);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; releaseBusy.current?.(); };
  }, []);
  useEffect(() => {
    setDraft(object ? initialDraft(object, sourceEdit, props.pageWidth, props.pageHeight) : null);
  }, [objectSignature, props.pageWidth, props.pageHeight]);
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
  const commit = async (next: ContentEdit[], success: string) => {
    if (next.length > MAX_CONTENT_EDITS) throw new Error(t('每页最多修改 128 个原有对象，请恢复部分对象或分批处理。', 'A page supports edits to at most 128 original objects. Reset some objects or use smaller groups.'));
    const result = await latest.current.onChange(next);
    if (result !== false && alive.current) setMessage(success);
  };
  const apply = () => execute(async () => {
    if (!object || !draft || !object.editable || object.deleted) return;
    const patch: Partial<Omit<ContentEdit, 'objectIndex' | 'fingerprint'>> = {};
    if (draft.geometryChanged) {
      try { patch.bounds = geometryFromMillimeters(draft.geometry, props.pageWidth, props.pageHeight); }
      catch { throw new Error(t('位置与尺寸须为有效毫米数值，且对象应位于页面范围内。', 'Enter valid millimeter values with the object inside the page.')); }
    }
    if (object.kind === 'text') {
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
      if (Math.abs(opacity - (object.opacity ?? 1)) > .002) patch.opacity = opacity;
      if (draft.replaceFont && draft.fontFamily !== sourceEdit?.fontFamily) patch.fontFamily = draft.fontFamily;
      else if (!draft.replaceFont && sourceEdit?.fontFamily) patch.fontFamily = undefined;
      if (draft.replaceFont) {
        if (draft.bold !== (sourceEdit?.bold ?? false)) patch.bold = draft.bold;
        if (draft.italic !== (sourceEdit?.italic ?? false)) patch.italic = draft.italic;
      } else if (sourceEdit?.fontFamily) {
        patch.bold = undefined; patch.italic = undefined;
      }
    }
    if (!Object.keys(patch).length) { setMessage(t('当前对象没有待应用的修改。', 'This object has no pending changes.')); return; }
    await commit(upsertContentEdit(props.contentEdits, object, patch), t('原对象修改已应用。请检查页面效果，再保存副本。', 'Original object changes applied. Inspect the page, then save a copy.'));
  });
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
  const kindName = (kind: ContentObject['kind']) => kind === 'text' ? t('文字', 'Text') : kind === 'image' ? t('图片', 'Image') : t('其他内容', 'Other content');
  const editPixels = () => void execute(async () => {
    if (!props.page || !object || object.kind !== 'image' || !object.editable || object.deleted) return;
    const asset = await backend<ImageAsset>('extract_content_image',{page:props.page,objectIndex:object.objectIndex,fingerprint:object.fingerprint},3);
    if (alive.current) setImageEdit(asset);
  });
  return <aside className="original-editor" aria-label={t('编辑 PDF 原有内容', 'Edit original PDF content')} onKeyDown={event =>
    {
    const target = event.target as HTMLElement;
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable;
    if (!event.ctrlKey && !event.metaKey) event.stopPropagation();
    if (!typing && (event.key === 'Delete' || event.key === 'Backspace')) { event.preventDefault(); if (object?.editable && !object.deleted && !blocked) void toggleDeleted(); }
  }}>
    <header className="oc-header"><div><strong>{t('编辑原文', 'Edit original content')}</strong><span>{t('修改 PDF 中已有的文字与图片对象', 'Modify existing PDF text and image objects')}</span></div><button aria-label={t('关闭原文编辑', 'Close original content editor')} disabled={working} onClick={props.onClose}><X size={18}/></button></header>
    {props.onEraseMode && <label className="oc-erase-mode"><input type="checkbox" checked={Boolean(props.eraseMode)} disabled={blocked} onChange={event=>props.onEraseMode?.(event.target.checked)}/>{t('对象橡皮擦：点击对象删除，可撤销','Object eraser: click an object to remove it; undo is available')}</label>}
    {props.onRasterEdit && <div className="oc-pixel-action"><button className="oe-action wide" disabled={blocked} onClick={props.onRasterEdit}>{t('当前页像素编辑（转换为图像）','Edit page pixels (convert to image)')}</button></div>}
    <div className="oc-scroll">{props.onEditLines && <section className="oc-section"><button className="oe-action wide" disabled={blocked} onClick={props.onEditLines}><FileText size={14}/>{t('文字行排版与修改后预览', 'Text-line formatting and result preview')}</button><p className="oc-note">{t('文字行工具提供字距、对齐、装饰线与目标框；保留可搜索的 PDF 文字。', 'The line tool provides spacing, alignment, decoration strokes and a target frame while retaining searchable PDF text.')}</p></section>}
      <section className="oc-section"><div className="oc-section-heading"><h3>{t('本页原有对象', 'Original page objects')}</h3><button disabled={blocked} onClick={props.onRefresh} aria-label={t('重新读取原有对象', 'Refresh original objects')}><RefreshCw size={13}/></button></div>
        <p className="oc-description">{t('先在页面框内或下方列表中选择一个对象。PDF 文字可能按行或小片段拆分，不会自动重排相邻段落。', 'Choose an object on the page or in the list. PDF text may be split into lines or short runs; neighboring paragraphs do not reflow automatically.')}</p>
        <label className="oc-field"><span>{t('对象类型', 'Object type')}</span><select value={filter} disabled={blocked} onChange={event => setFilter(event.target.value as typeof filter)}><option value="all">{t('全部', 'All')}</option><option value="text">{t('文字', 'Text')}</option><option value="image">{t('图片', 'Images')}</option><option value="unsupported">{t('其他与暂不支持', 'Other and unsupported')}</option></select></label>
        {props.loading && <p className="oc-status" role="status"><LoaderCircle className="spin" size={14}/>{t('正在读取原有内容…', 'Reading original content…')}</p>}
        {props.error && <p className="oc-error" role="alert"><CircleAlert size={14}/>{props.error}</p>}
        {!props.loading && !props.error && !props.objects.length && <p className="oc-note">{t('未找到可列出的页面对象。扫描图片中的文字需要 OCR；轮廓字与嵌套内容不能按普通文字修改。', 'No page objects were listed. Text in scans requires OCR; outlined text and nested content cannot be edited as ordinary text.')}</p>}
        <div className="oc-object-list" aria-label={t('原有对象列表', 'Original object list')}>{filtered.map(item => <button key={`${item.objectIndex}:${item.fingerprint}`} className={`${contentObjectId(item) === props.selectedId ? 'selected' : ''} ${item.deleted ? 'oc-deleted' : ''}`} disabled={blocked} aria-pressed={contentObjectId(item) === props.selectedId} onClick={() => props.onSelect(contentObjectId(item))}>
          {item.kind === 'image' ? <ImagePlus size={15}/> : <FileText size={15}/>}<span><b>{kindName(item.kind)} {item.objectIndex + 1}{item.deleted && ` · ${t('已删除', 'Deleted')}`}</b><small>{item.kind === 'text' ? item.text || item.originalText || t('空文字对象', 'Empty text object') : item.reason || (item.kind === 'image' ? t('页面图像', 'Page image') : t('此类对象暂不支持修改', 'Editing this object type is not supported'))}</small></span>{!item.editable && <CircleAlert size={12}/>}</button>)}</div>
        <p className="oc-note">{t(`显示 ${props.objects.length} 个对象 / 页面共 ${props.totalObjects ?? props.objects.length} 个。`, `${props.objects.length} objects listed / ${props.totalObjects ?? props.objects.length} on the page.`)}{props.truncated && ' ' + t('对象较多，列表已截断。', 'The object list was truncated.')}</p>
        {props.warnings?.map((warning, index) => <p key={index} className="oc-note oc-warning">{warning}</p>)}
      </section>
      {object && draft && <section className="oc-section oc-properties"><div className="oc-section-heading"><h3>{kindName(object.kind)} {object.objectIndex + 1}</h3>{sourceEdit && <span>{t('已有修改', 'Modified')}</span>}</div>
        {!object.editable && <p className="oc-warning">{object.reason || t('此对象结构暂不支持直接编辑。', 'This object structure does not support direct editing.')}</p>}
        {object.deleted && <p className="oc-warning">{t('该对象已从当前页面移除，可使用下方按钮恢复。', 'This object is removed from the current page. Restore it below.')}</p>}
        {object.kind === 'text' && <>
          <label className="oc-field"><span>{t('文字内容（单行）', 'Text content (single line)')}</span><textarea value={draft.text} disabled={!canEdit} maxLength={2000} onChange={event => setDraft({ ...draft, text: event.target.value })}/></label>
          <button className="oc-action oc-copy" disabled={blocked} onClick={() => void copyText()}><Copy size={12}/>{t('复制文字', 'Copy text')}</button>
          <details className="oc-original-text"><summary>{t('查看来源原文', 'View original source text')}</summary><p>{object.originalText ?? object.text ?? ''}</p></details>
          <p className="oc-note">{t('当前 PDF 字体：', 'Current PDF font: ')}<b>{object.fontFamily || t('未知字体', 'Unknown font')}</b></p>
          <div className="oc-fields"><label className="oc-field"><span>{t('字号（PDF pt）', 'Font size (PDF pt)')}</span><input type="number" min="1" max="512" step="0.1" value={draft.fontSize} disabled={!canEdit} onChange={event => setDraft({ ...draft, fontSize: event.target.value })}/></label><label className="oc-field"><span>{t('文字颜色', 'Text color')}</span><input type="color" value={draft.fillColor} disabled={!canEdit} onChange={event => setDraft({ ...draft, fillColor: event.target.value })}/></label></div>
          <label className="oc-checkbox"><input type="checkbox" disabled={!canEdit} checked={draft.replaceFont} onChange={event => setDraft({ ...draft, replaceFont: event.target.checked })}/>{t('更换为本机字体', 'Replace with an installed font')}</label>
          {draft.replaceFont && <FontPicker value={draft.fontFamily} onChange={family => setDraft(previous => previous ? { ...previous, fontFamily: family } : previous)} disabled={!canEdit} sample={draft.text} embedForOriginal/>}
          {draft.replaceFont && <><div className="oc-fields"><label className="oc-checkbox"><input type="checkbox" checked={draft.bold} disabled={!canEdit} onChange={event => setDraft({ ...draft, bold: event.target.checked })}/>{t('粗体', 'Bold')}</label><label className="oc-checkbox"><input type="checkbox" checked={draft.italic} disabled={!canEdit} onChange={event => setDraft({ ...draft, italic: event.target.checked })}/>{t('斜体', 'Italic')}</label></div><p className="oc-note">{t('使用已安装字体的真实字形。该字体无对应字形或不允许编辑嵌入时，将提示更换字体，不使用合成粗斜体。', 'Uses a real installed face. Fonts without the requested face or editable embedding permission are rejected; synthetic bold and italic are not used.')}</p></>}
          <label className="oc-field"><span>{t('文字不透明度（%）', 'Text opacity (%)')}</span><input type="number" min="5" max="100" step="1" value={draft.opacity} disabled={!canEdit} onChange={event => setDraft({ ...draft, opacity: event.target.value })}/></label>
          {Number(draft.opacity) < 100 && <p className="oc-note">{t('透明文字保存后仍可搜索。重新打开时，因透明度/蒙版的保护限制，可能无法再次直接编辑该原文对象；请保留原稿。', 'Transparent text remains searchable after saving. On reopening, transparency/mask safeguards may prevent direct re-editing of this object; retain the original.')}</p>}
          <p className="oc-note">{t('保留原字体时，新增字符可能不在原字体子集中。遇到缺字提示，请选择允许嵌入的本机字体；更换字体可能改变文字宽度。', 'With the original font, added characters may be absent from its subset. If glyphs are missing, choose an embeddable installed font; changing fonts may alter text width.')}</p>
        </>}
        {object.kind === 'image' && <button className="oc-action oc-wide" disabled={!canEdit} onClick={() => void replaceImage()}><ImagePlus size={14}/>{t('替换图片，保留位置', 'Replace image, keep placement')}</button>}
        {object.editable && <><h4>{t('精确位置与尺寸（mm）', 'Exact position and size (mm)')}</h4><div className="oc-fields">{geometryFields.map(field => <label key={field.key} className="oc-field"><span>{field.label}</span><input aria-label={`${field.label} mm`} type="number" step="0.1" min={field.key === 'width' || field.key === 'height' ? '0.01' : '0'} value={draft.geometry[field.key]} disabled={!canEdit} onChange={event => setDraft({ ...draft, geometry: { ...draft.geometry, [field.key]: event.target.value }, geometryChanged: true })}/></label>)}</div>
          <p className="oc-note">{object.kind === 'text' ? t('未设定边界框时，文字内容或字号修改使用自然宽度。已有位置/尺寸修改会继续保留；调整宽高会缩放对象外形，请检查相邻内容。', 'Without explicit bounds, text or font-size changes use natural width. Existing placement/size edits are retained; changing dimensions scales the object, so inspect neighboring content.') : t('替换图片保持原边界框，可能改变图片比例。可在此精确调整。', 'Replacing an image retains its bounds and may alter its aspect ratio. Adjust the dimensions here if needed.')}</p>
          <button className="oc-action primary oc-wide" disabled={!canEdit} onClick={() => void apply()}><Check size={14}/>{t('应用原文修改', 'Apply original content changes')}</button>
          {object.kind === 'text' && sourceEdit?.bounds && <><button className="oc-action oc-wide" disabled={!canEdit} onClick={() => void clearBounds()}><RotateCcw size={13}/>{t('清除手动位置与尺寸', 'Clear manual placement and size')}</button><p className="oc-note">{t('保留文字和字体修改，恢复来源位置并采用当前文字的自然宽高。', 'Keeps text and font edits, restores source placement, and uses the current text’s natural dimensions.')}</p></>}
        </>}
        <div className="oc-button-row"><button className="oc-action" disabled={blocked || !sourceEdit} onClick={() => void restore()}><RotateCcw size={13}/>{t('恢复原始内容', 'Reset to original')}</button>{object.editable && <button className={`oc-action ${object.deleted ? '' : 'oc-danger'}`} disabled={blocked} onClick={() => void toggleDeleted()}>{object.deleted ? <RotateCcw size={13}/> : <Trash2 size={13}/>} {object.deleted ? t('恢复该对象', 'Restore object') : t('删除该对象', 'Delete object')}</button>}</div>
        <p className="oc-note">{t('删除可见对象不等于安全涂黑；隐藏数据、其他对象或历史信息不在此操作的清理保证内。', 'Deleting a visible object is not secure redaction; this operation does not guarantee removal of hidden data, other objects or history.')}</p>
      </section>}
      {message && <p className="oc-message" role="status"><Check size={14}/>{message}</p>}{validationError && <p className="oc-error oc-message" role="alert">{validationError}</p>}
    </div>
    {working && <div className="oc-working" role="status"><LoaderCircle className="spin" size={14}/>{t('正在验证原文修改…', 'Validating original content changes…')}</div>}
    <footer className="oc-footer">{t('修改可撤销。保存副本后重新打开，原文修改仍保留。', 'Changes can be undone. Original content edits survive saving and reopening a copy.')}</footer>
    {object?.kind === 'image' && <div className="oc-pixel-action"><button className="oe-action wide" disabled={!canEdit || !props.page} onClick={editPixels}>{t('图片裁切 / 橡皮擦','Image crop / Eraser')}</button></div>}
    {imageEdit && object && <ImageEditDialog image={imageEdit} title={t('原 PDF 图片对象','Original PDF image object')} onClose={() => setImageEdit(null)} onBusyChange={props.onBusyChange} onApply={async image => {
      const result = await latest.current.onChange(upsertContentEdit(latest.current.contentEdits,object,{replacementAssetId:image.id}));
      return result;
    }}/>} 
  </aside>;
}
