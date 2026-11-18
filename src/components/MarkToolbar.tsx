// SPDX-License-Identifier: GPL-3.0-or-later
import { ArrowUpRight, Circle, Copy, Eraser, Highlighter, Minus, MousePointer2, Pencil, Square, SquareDashed, Trash2, X } from 'lucide-react';
import type { LineStyle, MarkSettings, MarkTool } from '../markGeometry';
import type { PageOverlay } from '../types';
import { useI18n } from '../i18n';

export function MarkToolbar({ settings, onChange, selected, onOpacity, onDuplicate, onRemove, onClose, disabled, onEditPixels }: {
  settings: MarkSettings; onChange: (settings: MarkSettings) => void; selected?: PageOverlay;
  onOpacity: (value: number) => void; onDuplicate: () => void; onRemove: () => void; onClose: () => void; disabled: boolean;
  onEditPixels?: () => void;
}) {
  const { t } = useI18n();
  const tools: { id: MarkTool; label: string; icon: typeof Square }[] = [
    { id: 'select', label: t('选择与移动', 'Select and move'), icon: MousePointer2 },
    { id: 'highlight', label: t('半透明高亮', 'Transparent highlight'), icon: Highlighter },
    { id: 'block', label: t('实心色块', 'Solid color block'), icon: Square },
    { id: 'rectangle', label: t('矩形框', 'Rectangle'), icon: SquareDashed },
    { id: 'ellipse', label: t('椭圆', 'Ellipse'), icon: Circle },
    { id: 'line', label: t('直线', 'Line'), icon: Minus },
    { id: 'arrow', label: t('箭头', 'Arrow'), icon: ArrowUpRight },
    { id: 'pen', label: t('自由画笔', 'Freehand pen'), icon: Pencil },
  ];
  return <div className="mark-toolbar" role="toolbar" aria-label={t('页面标记工具', 'Page marking tools')}>
    <div className="mark-tool-buttons">{tools.map(({ id, label, icon: Icon }) => <button key={id} className={`mark-tool ${settings.tool === id ? 'active' : ''}`} title={label} aria-label={label} aria-pressed={settings.tool === id} disabled={disabled} onClick={() => onChange({ ...settings, tool: id, opacity: id === 'highlight' ? .35 : id === 'block' ? 1 : settings.tool === 'highlight' ? 1 : settings.opacity })}><Icon size={16}/>{(id === 'highlight' || id === 'block') && <span>{id === 'highlight' ? t('高亮', 'Highlight') : t('色块', 'Block')}</span>}</button>)}</div>
    <div className="mark-style-controls"><label className="mark-color" title={t('标记颜色', 'Mark color')}><span>{t('颜色', 'Color')}</span><input type="color" aria-label={t('标记颜色', 'Mark color')} value={settings.color} disabled={disabled} onChange={event => onChange({ ...settings, color: event.target.value })}/></label>
      <label>{t('粗细', 'Width')}<select aria-label={t('标记线条粗细', 'Mark stroke width')} value={settings.lineWidth} disabled={disabled} onChange={event => onChange({ ...settings, lineWidth: Number(event.target.value) })}>{[.5, 1, 2, 3, 5, 8, 12].map(value => <option key={value} value={value}>{value} pt</option>)}</select></label>
      {['line', 'arrow', 'rectangle', 'ellipse', 'pen'].includes(settings.tool) && <label>{t('线型', 'Line style')}<select aria-label={t('线型', 'Line style')} value={settings.lineStyle ?? 'solid'} disabled={disabled} onChange={event => onChange({ ...settings, lineStyle: event.target.value as LineStyle })}><option value="solid">{t('实线', 'Solid')}</option><option value="dashed">{t('虚线', 'Dashed')}</option><option value="dashDot">{t('点划线', 'Dash-dot')}</option><option value="dashDotDot">{t('双点划线', 'Dash-dot-dot')}</option></select></label>}
      <label className="mark-opacity">{t('透明度', 'Opacity')}<input aria-label={t('标记不透明度', 'Mark opacity')} type="range" min={5} max={100} step={5} disabled={disabled || settings.tool === 'select' && (!selected || selected.locked)} value={Math.round((settings.tool === 'select' && selected ? selected.opacity : settings.opacity) * 100)} onChange={event => settings.tool === 'select' ? onOpacity(Number(event.target.value) / 100) : onChange({ ...settings, opacity: Number(event.target.value) / 100 })}/><b>{Math.round((settings.tool === 'select' && selected ? selected.opacity : settings.opacity) * 100)}%</b></label>
      {settings.tool === 'select' && <>{onEditPixels && <button className="mark-tool" title={t('裁切或擦除选中标记','Crop or erase the selected mark')} aria-label={t('裁切或擦除选中标记','Crop or erase the selected mark')} disabled={disabled || !selected || selected.locked} onClick={onEditPixels}><Eraser size={16}/></button>}<button className="mark-tool" title={t('复制标记', 'Duplicate mark')} aria-label={t('复制标记', 'Duplicate mark')} disabled={disabled || !selected} onClick={onDuplicate}><Copy size={15}/></button><button className="mark-tool" title={t('移除标记', 'Remove mark')} aria-label={t('移除标记', 'Remove mark')} disabled={disabled || !selected || selected.locked} onClick={onRemove}><Trash2 size={15}/></button></>}
    </div><button className="mark-tool mark-close" aria-label={t('关闭标记工具', 'Close marking tools')} title={t('关闭标记工具', 'Close marking tools')} onClick={onClose} disabled={disabled}><X size={16}/></button>
    <p className="mark-hint">{settings.tool === 'select' ? t('点击标记后拖动或调整大小；方向键微移，Delete 移除。', 'Click a mark to move or resize it; arrow keys nudge, Delete removes.') : t('直接在页面上拖动绘制；Shift 约束方向或正方形，Esc 取消。色块仅遮盖显示。', 'Drag on the page to draw. Shift constrains direction or squares; Esc cancels. Blocks only cover the visible area.')}</p>
  </div>;
}
