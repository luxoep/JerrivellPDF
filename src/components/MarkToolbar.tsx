// SPDX-License-Identifier: MIT OR Apache-2.0
import { ArrowUpRight, Circle, Copy, CornerDownRight, Eraser, Highlighter, MessageSquare, Minus, MousePointer2, Pencil, Route, Square, SquareDashed, Trash2, X } from 'lucide-react';
import { defaultArrowHeads, isEditablePathTool, isMultiPointTool, markArrowHeads } from '../markGeometry';
import type { ArrowHeads, LineStyle, MarkSettings, MarkStylePatch, MarkTool } from '../markGeometry';
import type { PageOverlay } from '../types';
import { useI18n } from '../i18n';

export function MarkToolbar({ settings, onChange, selected, onOpacity, onDuplicate, onRemove, onClose, disabled, onEditPixels, onEraseRegions, onStyleChange }: {
  settings: MarkSettings; onChange: (settings: MarkSettings) => void; selected?: PageOverlay;
  onOpacity: (value: number) => void; onDuplicate: () => void; onRemove: () => void; onClose: () => void; disabled: boolean;
  onEditPixels?: () => void; onEraseRegions?: () => void; onStyleChange?: (patch: MarkStylePatch) => void;
}) {
  const { t } = useI18n();
  const editing = settings.tool === 'select' && selected?.markSource ? selected.markSource : undefined;
  const style = editing ? { ...settings, ...editing.geometry, color: editing.color } : settings;
  const styleDisabled = disabled || settings.tool === 'select' && (!editing || selected?.locked || !onStyleChange);
  const changeStyle = (patch: MarkStylePatch) => editing ? onStyleChange?.(patch) : onChange({ ...settings, ...patch });
  const tools: { id: MarkTool; label: string; icon: typeof Square }[] = [
    { id: 'select', label: t('选择与移动', 'Select and move'), icon: MousePointer2 },
    { id: 'highlight', label: t('半透明高亮', 'Transparent highlight'), icon: Highlighter },
    { id: 'block', label: t('实心色块', 'Solid color block'), icon: Square },
    { id: 'rectangle', label: t('矩形框', 'Rectangle'), icon: SquareDashed },
    { id: 'ellipse', label: t('椭圆', 'Ellipse'), icon: Circle },
    { id: 'line', label: t('直线', 'Line'), icon: Minus },
    { id: 'arrow', label: t('箭头', 'Arrow'), icon: ArrowUpRight },
    { id: 'polyline', label: t('折线', 'Polyline'), icon: Route },
    { id: 'polyarrow', label: t('折线箭头', 'Bent arrow'), icon: CornerDownRight },
    { id: 'callout', label: t('文字引线', 'Text callout'), icon: MessageSquare },
    { id: 'pen', label: t('自由画笔', 'Freehand pen'), icon: Pencil },
  ];
  return <div className="mark-toolbar" role="toolbar" aria-label={t('页面标记工具', 'Page marking tools')}>
    <div className="mark-tool-buttons">{tools.map(({ id, label, icon: Icon }) => <button key={id} className={`mark-tool ${settings.tool === id ? 'active' : ''}`} title={label} aria-label={label} aria-pressed={settings.tool === id} disabled={disabled} onClick={() => onChange({ ...settings, tool: id, arrowHeads: defaultArrowHeads(id), opacity: id === 'highlight' ? .35 : id === 'block' ? 1 : settings.tool === 'highlight' ? 1 : settings.opacity })}><Icon size={16}/>{(id === 'highlight' || id === 'block' || isMultiPointTool(id)) && <span>{id === 'highlight' ? t('高亮', 'Highlight') : id === 'block' ? t('色块', 'Block') : label}</span>}</button>)}</div>
    <div className="mark-style-controls">
      {onEraseRegions && <button className="mark-tool" disabled={disabled} onClick={onEraseRegions}><Eraser size={16}/><span>{t('页面局部擦除', 'Erase page regions')}</span></button>}
      {editing && <span>{t('选中标记', 'Selected mark')}</span>}
      <label className="mark-color" title={t('标记颜色', 'Mark color')}><span>{t('颜色', 'Color')}</span><input type="color" aria-label={t('标记颜色', 'Mark color')} value={style.color} disabled={styleDisabled} onChange={event => changeStyle({ color: event.target.value })}/></label>
      <label>{t('粗细', 'Width')}<select aria-label={t('标记线条粗细', 'Mark stroke width')} value={style.lineWidth} disabled={styleDisabled} onChange={event => changeStyle({ lineWidth: Number(event.target.value) })}>{[.5, 1, 2, 3, 5, 8, 12].map(value => <option key={value} value={value}>{value} pt</option>)}</select></label>
      {!['select', 'highlight', 'block'].includes(style.tool) && <label>{t('线型', 'Line style')}<select aria-label={t('线型', 'Line style')} value={style.lineStyle ?? 'solid'} disabled={styleDisabled} onChange={event => changeStyle({ lineStyle: event.target.value as LineStyle })}><option value="solid">{t('实线', 'Solid')}</option><option value="dashed">{t('虚线', 'Dashed')}</option><option value="dashDot">{t('点划线', 'Dash-dot')}</option><option value="dashDotDot">{t('双点划线', 'Dash-dot-dot')}</option></select></label>}
      {isEditablePathTool(style.tool) && <label>{t('箭头端', 'Arrowheads')}<select style={{ maxWidth: 'none' }} aria-label={t('箭头端', 'Arrowheads')} value={markArrowHeads(style as Parameters<typeof markArrowHeads>[0])} disabled={styleDisabled} onChange={event => changeStyle({ arrowHeads: event.target.value as ArrowHeads })}><option value="none">{t('无', 'None')}</option><option value="start">{t('起点', 'Start')}</option><option value="end">{t('终点', 'End')}</option><option value="both">{t('双端', 'Both')}</option></select></label>}
      <label className="mark-opacity">{t('透明度', 'Opacity')}<input aria-label={t('标记不透明度', 'Mark opacity')} type="range" min={5} max={100} step={5} disabled={disabled || settings.tool === 'select' && (!selected || selected.locked)} value={Math.round((settings.tool === 'select' && selected ? selected.opacity : settings.opacity) * 100)} onChange={event => settings.tool === 'select' ? onOpacity(Number(event.target.value) / 100) : onChange({ ...settings, opacity: Number(event.target.value) / 100 })}/><b>{Math.round((settings.tool === 'select' && selected ? selected.opacity : settings.opacity) * 100)}%</b></label>
      {settings.tool === 'select' && <>{onEditPixels && <button className="mark-tool" title={t('裁切或擦除选中标记','Crop or erase the selected mark')} aria-label={t('裁切或擦除选中标记','Crop or erase the selected mark')} disabled={disabled || !selected || selected.locked || !!selected.textSource || !!selected.leaderFor} onClick={onEditPixels}><Eraser size={16}/></button>}<button className="mark-tool" title={t('复制标记', 'Duplicate mark')} aria-label={t('复制标记', 'Duplicate mark')} disabled={disabled || !selected} onClick={onDuplicate}><Copy size={15}/></button><button className="mark-tool" title={t('移除标记', 'Remove mark')} aria-label={t('移除标记', 'Remove mark')} disabled={disabled || !selected || selected.locked} onClick={onRemove}><Trash2 size={15}/></button></>}
    </div><button className="mark-tool mark-close" aria-label={t('关闭标记工具', 'Close marking tools')} title={t('关闭标记工具', 'Close marking tools')} onClick={onClose} disabled={disabled}><X size={16}/></button>
    <p className="mark-hint">{settings.tool === 'select'
      ? editing && isEditablePathTool(editing.geometry.tool)
        ? t('拖动节点改折线；双击线段加点、双击节点删点。文字引线末点跟随文字框。', 'Drag path nodes; double-click segments to add nodes or nodes to remove them. Callout endpoints follow their text box.')
        : t('点击标记后拖动或调整大小；方向键微移，Delete 移除。', 'Click a mark to move or resize it; arrow keys nudge, Delete removes.')
      : isMultiPointTool(settings.tool)
        ? t('逐点点击绘制；双击或 Enter 完成，Backspace 撤回节点，Esc 取消，Shift 按 45° 吸附。文字引线从箭头目标画到文字位置。', 'Click nodes; double-click or Enter to finish, Backspace removes the last node, Esc cancels, Shift snaps to 45°. Draw callouts from the arrow target toward the text.')
        : t('直接在页面上拖动绘制；Shift 约束方向或正方形，Esc 取消。色块仅遮盖显示。', 'Drag on the page to draw. Shift constrains direction or squares; Esc cancels. Blocks only cover the visible area.')}</p>
  </div>;
}
