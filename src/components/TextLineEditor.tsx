// SPDX-License-Identifier: MIT OR Apache-2.0
import { useEffect, useMemo, useRef, useState } from 'react';
import { Bold, Check, CircleAlert, Eye, Italic, LoaderCircle, Strikethrough, Underline, X } from 'lucide-react';
import { backend, errorMessage, pageReference } from '../backend';
import { groupTextLines } from '../documentTools';
import { visiblePageSize } from '../viewerGeometry';
import type { ContentBounds, ContentObject } from '../originalContent';
import type { DocumentInfo, RenderedPage, WorkspacePage } from '../types';
import { FontPicker } from './FontPicker';
import { DEFAULT_FONT_FAMILY } from './overlayCanvas';
import { useI18n } from '../i18n';
import { PreviewZoom } from './PreviewZoom';
import './document-tools.css';
import './text-line-editor.css';

interface LinePreview { token: string; after: RenderedPage; bounds: ContentBounds; textWidth: number; availableWidth: number; overflowLine: boolean; overflowPage: boolean; canApply: boolean; key: string }
type LineFrame = Record<keyof ContentBounds, string>;
const toFrame = (bounds: ContentBounds, width: number, height: number): LineFrame => ({ x: String(Math.round(bounds.x * width * 10000) / 10000), y: String(Math.round(bounds.y * height * 10000) / 10000), width: String(Math.round(bounds.width * width * 10000) / 10000), height: String(Math.round(bounds.height * height * 10000) / 10000) });
function ResultImage({ image, bounds, whole, label }: { image: RenderedPage; bounds: ContentBounds; whole: boolean; label: string }) {
  const left = Math.max(0, bounds.x - .035), top = Math.max(0, bounds.y - .035);
  const width = Math.min(1 - left, bounds.width + .07), height = Math.min(1 - top, bounds.height + .07);
  return <div className="line-result-image"><div className="line-result-zoom"><PreviewZoom width={image.width * (whole ? 1 : width)} height={image.height * (whole ? 1 : height)} resetKey={`${whole}:${left}:${top}:${width}:${height}`} label={label}>{whole ? <img src={image.dataUrl} alt={label}/> : <div className="line-crop-preview" style={{ aspectRatio: `${width * image.width}/${height * image.height}` }}><img src={image.dataUrl} alt={label} style={{ width: `${100 / width}%`, left: `${-left / width * 100}%`, top: `${-top / height * 100}%` }}/></div>}</PreviewZoom></div></div>;
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
  const [replaceFont, setReplaceFont] = useState(true), [font, setFont] = useState(DEFAULT_FONT_FAMILY);
  const [bold, setBold] = useState(false), [italic, setItalic] = useState(false), [underline, setUnderline] = useState(false), [strikeout, setStrikeout] = useState(false);
  const [opacity, setOpacity] = useState('100'), [frame, setFrame] = useState<LineFrame>({ x: '0', y: '0', width: '1', height: '1' }), [frameChanged, setFrameChanged] = useState(false);
  const [constrain, setConstrain] = useState(true), [whole, setWhole] = useState(true);
  const [preview, setPreview] = useState<LinePreview | null>(null), [error, setError] = useState(''), [working, setWorking] = useState(false);
  const alive = useRef(true), pending = useRef(false), token = useRef('');
  const callbacks = useRef({ onClose, onApplied, onBusyChange }); callbacks.current = { onClose, onApplied, onBusyChange };
  const sourceKey = JSON.stringify(pageReference(page));
  useEffect(() => { if (line) {
    setText(line.text); setFontSize(String(Math.round(line.fontSize * 100) / 100)); setSpacing('0'); setColor(line.objects[0].fillColor ?? '#242b3e'); setReplaceFont(true); setFont(DEFAULT_FONT_FAMILY);
    setBold(Boolean(line.objects[0].bold)); setItalic(Boolean(line.objects[0].italic)); setUnderline(false); setStrikeout(false); setOpacity(String(Math.round((line.objects[0].opacity ?? 1) * 100)));
    setFrame(toFrame(line.bounds, dimensions.width, dimensions.height)); setFrameChanged(false); setAlignment('left'); setSelected(line.id); setPreview(null); setError('');
    if (token.current) { void backend('discard_line_preview', { token: token.current }, 3).catch(() => {}); token.current = ''; }
  } }, [line?.id, sourceKey]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; callbacks.current.onBusyChange(false); if (token.current) void backend('discard_line_preview', { token: token.current }, 3).catch(() => {}); }; }, []);
  const key = JSON.stringify([sourceKey, line?.id, text, fontSize, spacing, color, alignment, replaceFont, font, bold, italic, underline, strikeout, opacity, frame, frameChanged, constrain]);
  const currentKey = useRef(key); currentKey.current = key;
  const fresh = preview?.key === key;
  const updateFrame = (field: keyof ContentBounds, value: string) => { setFrame(previous => ({ ...previous, [field]: value })); setFrameChanged(true); };
  const generate = async (applyResult = false) => {
    if (!line || pending.current || loading) return;
    const size = Number(fontSize), distance = Number(spacing), alpha = Number(opacity) / 100;
    if (!text.trim() || text.length > 500 || /[\r\n\t]/.test(text) || !fontSize.trim() || !spacing.trim() || !Number.isFinite(size) || size < 1 || size > 512 || !Number.isFinite(distance) || distance < -5 || distance > 30) { setError(t('请输入单行文字（最多 500 字），字号 1～512 pt，字距 -5～30 pt。', 'Enter one line (up to 500 characters), size 1–512 pt and spacing -5–30 pt.')); return; }
    const targetBounds = frameChanged ? { x: Number(frame.x) / dimensions.width, y: Number(frame.y) / dimensions.height, width: Number(frame.width) / dimensions.width, height: Number(frame.height) / dimensions.height } : line.bounds;
    if (!Number.isFinite(alpha) || alpha < .05 || alpha > 1 || Object.values(frame).some(value => !value.trim() || !Number.isFinite(Number(value))) || targetBounds.x < 0 || targetBounds.y < 0 || targetBounds.width <= 0 || targetBounds.height <= 0 || targetBounds.x + targetBounds.width > 1.000001 || targetBounds.y + targetBounds.height > 1.000001) { setError(t('请填写页面内的有效文字框，宽高大于 0，不透明度为 5%～100%。', 'Enter a valid text frame inside the page with positive width and height, and opacity from 5% to 100%.')); return; }
    pending.current = true; setWorking(true); setError(''); callbacks.current.onBusyChange(true);
    try {
      const result = await backend<Omit<LinePreview, 'key'>>('preview_line_edit', { request: { page: pageReference(page), objects: line.objects.map(({ objectIndex, fingerprint }) => ({ objectIndex, fingerprint })), bounds: line.bounds, ...(frameChanged ? { targetBounds } : {}), text, fontFamily: replaceFont ? font : null, ...(replaceFont ? { bold, italic } : {}), fontSize: size, color, charSpacing: distance, alignment, opacity: alpha, underline, strikeout, constrainWidth: constrain } }, 3);
      if (!alive.current || key !== currentKey.current) { void backend('discard_line_preview', { token: result.token }, 3).catch(() => {}); return; }
      const previous = token.current;
      token.current = result.token;
      // Keep only the result raster, including when an older worker still sends a before field.
      setPreview({ token: result.token, after: result.after, bounds: result.bounds, textWidth: result.textWidth, availableWidth: result.availableWidth, overflowLine: result.overflowLine, overflowPage: result.overflowPage, canApply: result.canApply, key });
      if (previous && previous !== result.token) void backend('discard_line_preview', { token: previous }, 3).catch(() => {});
      if (applyResult && result.canApply) {
        const document = await backend<DocumentInfo>('commit_line_preview', { token: result.token }, 3);
        if (alive.current) { token.current = ''; callbacks.current.onApplied(document); }
      }
    } catch (reason) { if (alive.current) setError(errorMessage(reason)); }
    finally { pending.current = false; if (alive.current) setWorking(false); callbacks.current.onBusyChange(false); }
  };
  const apply = async () => {
    if (pending.current || !line || loading) return;
    if (!fresh) { await generate(true); return; }
    if (!preview?.canApply) return;
    pending.current = true; setWorking(true); setError(''); callbacks.current.onBusyChange(true);
    try { const result = await backend<DocumentInfo>('commit_line_preview', { token: preview.token }, 3); if (alive.current) { token.current = ''; callbacks.current.onApplied(result); } }
    catch (reason) { if (alive.current) setError(errorMessage(reason)); }
    finally { pending.current = false; if (alive.current) setWorking(false); callbacks.current.onBusyChange(false); }
  };
  const crop = preview?.bounds ?? line?.bounds;
  return <div className="dt-backdrop" onKeyDown={event => { event.stopPropagation(); if ((event.ctrlKey || event.metaKey) && ['s', 'o', 'p', 'f'].includes(event.key.toLowerCase())) event.preventDefault(); if (event.key === 'Escape' && !working) onClose(); }}><div className="dt-modal text-line-modal" role="dialog" aria-modal="true" aria-labelledby="text-line-title">
    <header className="dt-header"><div><h2 id="text-line-title">{t('文字行编辑与结果预览', 'Text line editing and result preview')}</h2><p>{t('自动组合相邻横向片段；只渲染修改结果，默认查看整页。', 'Group adjacent horizontal runs and render only the revised result, shown as a whole page by default.')}</p></div><button aria-label={t('关闭文字行编辑', 'Close text line editor')} disabled={working} onClick={onClose}><X size={19}/></button></header>
    <div className="line-editor-body"><aside className="line-list"><h3>{t(`识别到 ${lines.length} 行`, `${lines.length} detected lines`)}</h3>{loading ? <LoaderCircle size={23} className="spin"/> : !lines.length ? <p>{t('没有可编辑的横向顶层文字行。扫描件和嵌套 Form 暂不适用。', 'No supported horizontal top-level text lines. Scans and nested Forms are not supported here.')}</p> : lines.map((item, index) => <button key={item.id} className={line?.id === item.id ? 'active' : ''} disabled={working} onClick={() => setSelected(item.id)}><b>{index + 1}</b><span>{item.text.slice(0, 120)}<small>{t(`${item.objects.length} 个片段`, `${item.objects.length} runs`)}{item.mixedFont && ` · ${t('混合字体', 'Mixed fonts')}`}</small></span></button>)}</aside>
    <section className="line-fields"><label className="dt-field">{t('修改后的文字', 'Revised text')}<textarea aria-label={t('文字行内容', 'Text line content')} value={text} maxLength={500} rows={4} disabled={working || !line} onChange={event => setText(event.target.value)}/></label><div className="dt-field-row"><label className="dt-field">{t('字号 pt', 'Size pt')}<input aria-label={t('文字行字号', 'Text line font size')} type="number" min={1} max={512} value={fontSize} disabled={working} onChange={event => setFontSize(event.target.value)}/></label><label className="dt-field">{t('字距 pt', 'Character spacing pt')}<input aria-label={t('文字行字距', 'Text line character spacing')} type="number" min={-5} max={30} step={.1} value={spacing} disabled={working} onChange={event => setSpacing(event.target.value)}/></label></div>
      <label className="dt-field">{t('对齐目标文字框', 'Align within text frame')}<select aria-label={t('文字行对齐', 'Text line alignment')} value={alignment} disabled={working || !line} onChange={event => setAlignment(event.target.value)}><option value="left">{t('左对齐', 'Left')}</option><option value="center">{t('居中', 'Center')}</option><option value="right">{t('右对齐', 'Right')}</option></select></label><div className="dt-field-row"><label className="dt-field">{t('文字颜色', 'Text color')}<input aria-label={t('文字行颜色', 'Text line color')} type="color" value={color} disabled={working || !line} onChange={event => setColor(event.target.value)}/></label><label className="dt-field">{t(`不透明度 ${opacity}%`, `Opacity ${opacity}%`)}<input aria-label={t('文字行不透明度', 'Text line opacity')} type="range" min={5} max={100} value={opacity} disabled={working || !line} onChange={event => setOpacity(event.target.value)}/></label></div>
      <label className="dt-check"><input type="checkbox" aria-label={t('更换为可嵌入的本机字体', 'Use an embeddable installed font')} checked={replaceFont} disabled={working || !line} onChange={event => setReplaceFont(event.target.checked)}/>{t('更换为可嵌入的本机字体', 'Use an embeddable installed font')}</label>{replaceFont && <FontPicker value={font} onChange={setFont} disabled={working} resolveDefault compact embedForOriginal sample={text}/>}
      <div className="line-style-tools" role="group" aria-label={t('文字行样式', 'Text line styles')}><button type="button" aria-label={t('粗体', 'Bold')} aria-pressed={bold} title={t('使用所选本机字体的真实粗体字形', 'Use the selected installed font’s real bold face')} disabled={working || !line || !replaceFont} onClick={() => setBold(value => !value)}><Bold size={16}/></button><button type="button" aria-label={t('斜体', 'Italic')} aria-pressed={italic} title={t('使用所选本机字体的真实斜体字形', 'Use the selected installed font’s real italic face')} disabled={working || !line || !replaceFont} onClick={() => setItalic(value => !value)}><Italic size={16}/></button><button type="button" aria-label={t('下划线', 'Underline')} aria-pressed={underline} disabled={working || !line} onClick={() => setUnderline(value => !value)}><Underline size={16}/></button><button type="button" aria-label={t('删除线', 'Strikethrough')} aria-pressed={strikeout} disabled={working || !line} onClick={() => setStrikeout(value => !value)}><Strikethrough size={16}/></button></div>
      <p className="dt-muted">{replaceFont ? t('粗体与斜体需要字体提供对应字形；缺少字形时会提示，不模拟描边。', 'Bold and italic require matching font faces; unavailable faces are reported.') : t('保留原字体；启用本机字体后可更改粗体和斜体。', 'Keeping the original font. Enable an installed font to change bold and italic.')}</p>
      <div className="line-frame-heading"><b>{t('位置与文字框 · pt', 'Position and text frame · pt')}</b><button type="button" disabled={working || !line || !frameChanged} onClick={() => { if (line) setFrame(toFrame(line.bounds, dimensions.width, dimensions.height)); setFrameChanged(false); }}>{t('恢复原位置', 'Reset frame')}</button></div>
      <div className="dt-field-row line-frame-fields">{(['x', 'y', 'width', 'height'] as const).map(field => <label className="dt-field" key={field}>{field === 'x' ? t('距左', 'Left') : field === 'y' ? t('距顶', 'Top') : field === 'width' ? t('宽度', 'Width') : t('高度', 'Height')}<input type="number" aria-label={t(`文字行${field === 'x' ? '距左' : field === 'y' ? '距顶' : field === 'width' ? '宽度' : '高度'} pt`, `Text line ${field} pt`)} value={frame[field]} min={field === 'x' || field === 'y' ? 0 : .0001} max={field === 'x' || field === 'width' ? dimensions.width : dimensions.height} step={.1} disabled={working || !line} onChange={event => updateFrame(field, event.target.value)}/></label>)}</div>
      {Number(opacity) < 100 && <p className="dt-muted">{t('透明文字应用后仍可搜索，但暂不支持再次原文编辑；可撤销该次操作恢复。', 'Transparent text remains searchable after applying, but cannot yet be edited as original text again. Undo restores the previous state.')}</p>}
      <label className="dt-check"><input type="checkbox" aria-label={t('限制在目标文字框宽度内', 'Constrain to text frame width')} checked={constrain} disabled={working || !line} onChange={event => setConstrain(event.target.checked)}/>{t('限制在目标文字框宽度内', 'Constrain to text frame width')}</label>
      <p className="dt-muted">{t('位置以页面左上角为原点；宽高用于对齐和溢出检查，不拉伸字形。正字距加宽字符间隔，负值压缩间隔。请检查周围内容的重叠。', 'Coordinates start at the page’s top-left. Frame size controls alignment and overflow without stretching glyphs. Positive spacing expands characters; negative spacing tightens them. Check nearby content for overlap.')}</p>
      <button className="button secondary" disabled={working || loading || !line} onClick={() => void generate()}>{working ? <LoaderCircle className="spin" size={15}/> : <Eye size={15}/>} {t('生成结果预览', 'Generate result preview')}</button>
      {preview && <div className={preview.overflowLine || preview.overflowPage ? 'dt-notice warning' : 'dt-notice'}>{t(`文字宽 ${preview.textWidth.toFixed(2)} pt / 可用 ${preview.availableWidth.toFixed(2)} pt。`, `Text width ${preview.textWidth.toFixed(2)} pt / available ${preview.availableWidth.toFixed(2)} pt.`)}{preview.overflowLine && <p>{t('文字超出目标文字框，请调整字号、字距或框的宽高。', 'Text exceeds the text frame. Adjust its font size, spacing or frame dimensions.')}</p>}{preview.overflowPage && <p>{t('文字超出页面边界，不能应用。', 'Text exceeds the page and cannot be applied.')}</p>}{!fresh && <p>{t('已修改设置，应用前会校验最新文字。', 'Applying validates the latest draft.')}</p>}</div>}
    </section><section className="line-result" aria-label={t('修改结果预览', 'Revised result preview')}><div className="line-result-heading"><b>{t('修改后预览', 'Revised result')}</b><label className="dt-check"><input type="checkbox" aria-label={t('查看整页', 'Show whole page')} checked={whole} onChange={event => setWhole(event.target.checked)}/>{t('查看整页', 'Show whole page')}</label></div>{preview && crop ? <ResultImage image={preview.after} bounds={crop} whole={whole} label={t('修改后', 'Revised result')}/> : <div className="dt-empty"><Eye size={29}/><p>{t('选择文字行并生成修改结果预览。', 'Select a line and generate the revised result preview.')}</p></div>}</section></div>
    {error && <p className="dt-error" role="alert"><CircleAlert size={15}/>{error}</p>}<p className="dt-bottom-note">{t('应用后保留真实 PDF 文字，当前页已有叠加将固化；可一次撤销恢复。分组是几何推断，不进行段落换行、跨页重排或安全涂黑。', 'Applying keeps real PDF text and bakes current page overlays; one undo restores the previous plan. Grouping is geometric inference, without paragraph reflow or secure redaction.')}</p>
    <footer className="dt-footer"><button className="button secondary" onClick={onClose} disabled={working}>{t('取消', 'Cancel')}</button><button className="button primary" disabled={working || loading || !line || Boolean(fresh && !preview?.canApply)} onClick={() => void apply()}><Check size={15}/>{t('应用文字行', 'Apply text line')}</button></footer>
  </div></div>;
}
