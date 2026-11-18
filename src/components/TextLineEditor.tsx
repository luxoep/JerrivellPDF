// SPDX-License-Identifier: MIT OR Apache-2.0
import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, CircleAlert, Eye, LoaderCircle, X } from 'lucide-react';
import { backend, errorMessage, pageReference } from '../backend';
import { groupTextLines } from '../documentTools';
import { visiblePageSize } from '../viewerGeometry';
import type { ContentBounds, ContentObject } from '../originalContent';
import type { DocumentInfo, RenderedPage, WorkspacePage } from '../types';
import { FontPicker } from './FontPicker';
import { DEFAULT_FONT_FAMILY } from './overlayCanvas';
import { useI18n } from '../i18n';
import './document-tools.css';

interface LinePreview { token: string; before: RenderedPage; after: RenderedPage; bounds: ContentBounds; textWidth: number; availableWidth: number; overflowLine: boolean; overflowPage: boolean; canApply: boolean; key: string }
function ComparisonImage({ image, bounds, whole, label }: { image: RenderedPage; bounds: ContentBounds; whole: boolean; label: string }) {
  const left = Math.max(0, bounds.x - .035), top = Math.max(0, bounds.y - .035);
  const width = Math.min(1 - left, bounds.width + .07), height = Math.min(1 - top, bounds.height + .07);
  return <div className="line-comparison-image"><b>{label}</b>{whole ? <img src={image.dataUrl} alt={label}/> : <div className="line-crop-preview" style={{ aspectRatio: `${width * image.width}/${height * image.height}` }}><img src={image.dataUrl} alt={label} style={{ width: `${100 / width}%`, left: `${-left / width * 100}%`, top: `${-top / height * 100}%` }}/></div>}</div>;
}

export function TextLineEditor({ page, objects, loading, onClose, onApplied, onBusyChange }: {
  page: WorkspacePage; objects: ContentObject[]; loading: boolean; onClose: () => void;
  onApplied: (document: DocumentInfo) => void; onBusyChange: (busy: boolean) => void;
}) {
  const { t } = useI18n(); const dimensions = visiblePageSize(page);
  const lines = useMemo(() => groupTextLines(objects, dimensions.width, dimensions.height), [objects, dimensions.width, dimensions.height]);
  const [selected, setSelected] = useState(''); const line = lines.find(line => line.id === selected) ?? lines[0];
  const [text, setText] = useState(''), [fontSize, setFontSize] = useState('12'), [spacing, setSpacing] = useState('0');
  const [color, setColor] = useState('#242b3e'), [alignment, setAlignment] = useState('left');
  const [replaceFont, setReplaceFont] = useState(false), [font, setFont] = useState(DEFAULT_FONT_FAMILY);
  const [constrain, setConstrain] = useState(true), [whole, setWhole] = useState(false);
  const [preview, setPreview] = useState<LinePreview | null>(null), [error, setError] = useState(''), [working, setWorking] = useState(false);
  const alive = useRef(true), pending = useRef(false), token = useRef('');
  const callbacks = useRef({ onClose, onApplied, onBusyChange }); callbacks.current = { onClose, onApplied, onBusyChange };
  const sourceKey = JSON.stringify(pageReference(page));
  useEffect(() => { if (line) { setText(line.text); setFontSize(String(Math.round(line.fontSize * 100) / 100)); setSpacing('0'); setColor(line.objects[0].fillColor ?? '#242b3e'); setReplaceFont(line.mixedFont); setSelected(line.id); setPreview(null); setError(''); } }, [line?.id, sourceKey]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; callbacks.current.onBusyChange(false); if (token.current) void backend('discard_line_preview', { token: token.current }, 3).catch(() => {}); }; }, []);
  const key = JSON.stringify([sourceKey, line?.id, text, fontSize, spacing, color, alignment, replaceFont, font, constrain]);
  const fresh = preview?.key === key;
  const generate = async () => {
    if (!line || pending.current || loading) return;
    const size = Number(fontSize), distance = Number(spacing);
    if (!text.trim() || text.length > 500 || /[\r\n\t]/.test(text) || !fontSize.trim() || !spacing.trim() || !Number.isFinite(size) || size < 1 || size > 512 || !Number.isFinite(distance) || distance < -5 || distance > 30) { setError(t('请输入单行文字（最多 500 字），字号 1～512 pt，字距 -5～30 pt。', 'Enter one line (up to 500 characters), size 1–512 pt and spacing -5–30 pt.')); return; }
    pending.current = true; setWorking(true); setError(''); callbacks.current.onBusyChange(true);
    try {
      const result = await backend<Omit<LinePreview, 'key'>>('preview_line_edit', { request: { page: pageReference(page), objects: line.objects.map(({ objectIndex, fingerprint }) => ({ objectIndex, fingerprint })), bounds: line.bounds, text, fontFamily: replaceFont ? font : null, fontSize: size, color, charSpacing: distance, alignment, constrainWidth: constrain } }, 3);
      if (!alive.current) { void backend('discard_line_preview', { token: result.token }, 3).catch(() => {}); return; }
      token.current = result.token; setPreview({ ...result, key });
    } catch (reason) { if (alive.current) setError(errorMessage(reason)); }
    finally { pending.current = false; if (alive.current) setWorking(false); callbacks.current.onBusyChange(false); }
  };
  const apply = async () => {
    if (!fresh || !preview?.canApply || pending.current) return;
    pending.current = true; setWorking(true); setError(''); callbacks.current.onBusyChange(true);
    try { const result = await backend<DocumentInfo>('commit_line_preview', { token: preview.token }, 3); if (alive.current) { token.current = ''; callbacks.current.onApplied(result); } }
    catch (reason) { if (alive.current) setError(errorMessage(reason)); }
    finally { pending.current = false; if (alive.current) setWorking(false); callbacks.current.onBusyChange(false); }
  };
  const crop = line && preview ? { x: Math.min(line.bounds.x, preview.bounds.x), y: Math.min(line.bounds.y, preview.bounds.y), width: Math.max(line.bounds.x + line.bounds.width, preview.bounds.x + preview.bounds.width) - Math.min(line.bounds.x, preview.bounds.x), height: Math.max(line.bounds.y + line.bounds.height, preview.bounds.y + preview.bounds.height) - Math.min(line.bounds.y, preview.bounds.y) } : line?.bounds;
  return <div className="dt-backdrop" onKeyDown={event => { event.stopPropagation(); if ((event.ctrlKey || event.metaKey) && ['s', 'o', 'p', 'f'].includes(event.key.toLowerCase())) event.preventDefault(); if (event.key === 'Escape' && !working) onClose(); }}><div className="dt-modal text-line-modal" role="dialog" aria-modal="true" aria-labelledby="text-line-title">
    <header className="dt-header"><div><h2 id="text-line-title">{t('文字行编辑与前后预览', 'Text line editing and comparison')}</h2><p>{t('自动组合相邻横向片段；整行使用统一字号、颜色及选定字体。', 'Group adjacent horizontal runs and apply a consistent size, color and selected font.')}</p></div><button aria-label={t('关闭文字行编辑', 'Close text line editor')} disabled={working} onClick={onClose}><X size={19}/></button></header>
    <div className="line-editor-body"><aside className="line-list"><h3>{t(`识别到 ${lines.length} 行`, `${lines.length} detected lines`)}</h3>{loading ? <LoaderCircle size={23} className="spin"/> : !lines.length ? <p>{t('没有可编辑的横向顶层文字行。扫描件和嵌套 Form 暂不适用。', 'No supported horizontal top-level text lines. Scans and nested Forms are not supported here.')}</p> : lines.map((item, index) => <button key={item.id} className={line?.id === item.id ? 'active' : ''} disabled={working} onClick={() => setSelected(item.id)}><b>{index + 1}</b><span>{item.text.slice(0, 120)}<small>{t(`${item.objects.length} 个片段`, `${item.objects.length} runs`)}{item.mixedFont && ` · ${t('混合字体', 'Mixed fonts')}`}</small></span></button>)}</aside>
    <section className="line-fields"><label className="dt-field">{t('修改后的文字', 'Revised text')}<textarea aria-label={t('文字行内容', 'Text line content')} value={text} maxLength={500} rows={4} disabled={working || !line} onChange={event => setText(event.target.value)}/></label><div className="dt-field-row"><label className="dt-field">{t('字号 pt', 'Size pt')}<input aria-label={t('文字行字号', 'Text line font size')} type="number" min={1} max={512} value={fontSize} disabled={working} onChange={event => setFontSize(event.target.value)}/></label><label className="dt-field">{t('字距 pt', 'Character spacing pt')}<input aria-label={t('文字行字距', 'Text line character spacing')} type="number" min={-5} max={30} step={.1} value={spacing} disabled={working} onChange={event => setSpacing(event.target.value)}/></label></div>
      <label className="dt-field">{t('对齐原行区域', 'Align within original line')}<select value={alignment} disabled={working} onChange={event => setAlignment(event.target.value)}><option value="left">{t('左对齐', 'Left')}</option><option value="center">{t('居中', 'Center')}</option><option value="right">{t('右对齐', 'Right')}</option></select></label><label className="dt-field">{t('文字颜色', 'Text color')}<input type="color" value={color} disabled={working} onChange={event => setColor(event.target.value)}/></label>
      <label className="dt-check"><input type="checkbox" checked={replaceFont} disabled={working} onChange={event => setReplaceFont(event.target.checked)}/>{t('更换为可嵌入的本机字体', 'Use an embeddable installed font')}</label>{replaceFont && <FontPicker value={font} onChange={setFont} disabled={working} embedForOriginal sample={text}/>}
      <label className="dt-check"><input type="checkbox" checked={constrain} disabled={working} onChange={event => setConstrain(event.target.checked)}/>{t('限制在原行宽度内', 'Constrain to original line width')}</label>
      <p className="dt-muted">{t('正字距增加字符间隔，负值压缩间隔。允许超出原行时，仍须完整位于页面内，并检查与相邻内容的重叠。', 'Positive spacing expands characters; negative spacing tightens them. Allowing a wider line still requires it to fit on the page. Check nearby content for overlap.')}</p>
      <button className="button secondary" disabled={working || loading || !line} onClick={() => void generate()}>{working ? <LoaderCircle className="spin" size={15}/> : <Eye size={15}/>} {t('生成前后预览', 'Generate comparison')}</button>
      {preview && <div className={preview.overflowLine || preview.overflowPage ? 'dt-notice warning' : 'dt-notice'}>{t(`文字宽 ${preview.textWidth.toFixed(2)} pt / 原行 ${preview.availableWidth.toFixed(2)} pt。`, `Text width ${preview.textWidth.toFixed(2)} pt / original ${preview.availableWidth.toFixed(2)} pt.`)}{preview.overflowLine && <p>{t('文字超出原行宽度。', 'Text exceeds the original line width.')}</p>}{preview.overflowPage && <p>{t('文字超出页面边界，不能应用。', 'Text exceeds the page and cannot be applied.')}</p>}{!fresh && <p>{t('方案已变化，请重新生成预览。', 'The draft changed. Generate a new comparison.')}</p>}</div>}
    </section><section className="line-comparisons"><label className="dt-check"><input type="checkbox" checked={whole} onChange={event => setWhole(event.target.checked)}/>{t('查看整页', 'Show whole page')}</label>{preview && crop ? <><ComparisonImage image={preview.before} bounds={crop} whole={whole} label={t('修改前', 'Before')}/><ComparisonImage image={preview.after} bounds={crop} whole={whole} label={t('修改后', 'After')}/></> : <div className="dt-empty"><Eye size={29}/><p>{t('选择文字行并生成预览。', 'Select a line and generate a comparison.')}</p></div>}</section></div>
    {error && <p className="dt-error" role="alert"><CircleAlert size={15}/>{error}</p>}<p className="dt-bottom-note">{t('应用后保留真实 PDF 文字，当前页已有叠加将固化；可一次撤销恢复。分组是几何推断，不进行段落换行、跨页重排或安全涂黑。', 'Applying keeps real PDF text and bakes current page overlays; one undo restores the previous plan. Grouping is geometric inference, without paragraph reflow or secure redaction.')}</p>
    <footer className="dt-footer"><button className="button secondary" onClick={onClose} disabled={working}>{t('取消', 'Cancel')}</button><button className="button primary" disabled={working || !fresh || !preview?.canApply} onClick={() => void apply()}><Check size={15}/>{t('应用预览结果', 'Apply previewed result')}</button></footer>
  </div></div>;
}
