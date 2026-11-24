// SPDX-License-Identifier: MIT OR Apache-2.0
import { useEffect, useRef, useState } from 'react';
import { Eraser, LoaderCircle, X } from 'lucide-react';
import { errorMessage, renderPage } from '../backend';
import { imagePoint, selectionOutline, selectionRegions } from '../imageGeometry';
import type { ImagePoint, ImageSelection, SelectionShape } from '../imageGeometry';
import { useI18n } from '../i18n';
import type { ImageAsset, WorkspacePage } from '../types';
import { RegionSelection } from './RegionSelection';
import './image-workbench.css';

export function PageEraseDialog({ page, onApply, onClose }: {
  page: WorkspacePage; onApply: (regions: ImagePoint[][]) => Promise<void>; onClose: () => void;
}) {
  const { t } = useI18n();
  const [image, setImage] = useState<ImageAsset | null>(null);
  const [selection, setSelection] = useState<ImageSelection | null>(null);
  const [shape, setShape] = useState<SelectionShape>('rectangle');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLElement>(null), applying = useRef(false);
  useEffect(() => { dialog.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    let active = true;
    void renderPage(page, 1800).then(
      data => { if (active) setImage({ ...data, id: page.id }); },
      reason => { if (active) setError(errorMessage(reason)); },
    );
    return () => { active = false; };
  }, [page]);
  const apply = async () => {
    if (!selection || applying.current) return;
    applying.current = true;
    setWorking(true); setError('');
    try {
      const regions = selectionRegions(selection).map(region =>
        selectionOutline(region).map(point => imagePoint(point.x, point.y)));
      await onApply(regions);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      applying.current = false;
      setWorking(false);
    }
  };
  return <div className="image-workbench-backdrop" onKeyDown={event => {
    event.stopPropagation();
    if ((event.ctrlKey || event.metaKey) && ['o', 'p', 's', 'w', 'z'].includes(event.key.toLowerCase())) event.preventDefault();
    if (event.key === 'Escape' && !applying.current) onClose();
  }}><section ref={dialog} tabIndex={-1} className="image-workbench page-erase-workbench" role="dialog" aria-modal="true" aria-label={t('页面局部擦除', 'Erase page regions')}>
    <header><h2>{t('页面局部擦除', 'Erase page regions')}</h2><button onClick={onClose} disabled={working} aria-label={t('关闭局部擦除', 'Close region eraser')}><X size={19}/></button></header>
    <div className="image-workbench-body"><aside className="image-workbench-options">
      <label className="dt-field">{t('选区形状', 'Region shape')}
        <select value={shape} disabled={working} onChange={event => setShape(event.target.value as SelectionShape)}>
          <option value="rectangle">{t('矩形', 'Rectangle')}</option><option value="ellipse">{t('椭圆', 'Ellipse')}</option>
          <option value="polygon">{t('多边形', 'Polygon')}</option><option value="lasso">{t('自由套索', 'Freehand lasso')}</option>
        </select>
      </label>
      <p>{t('圈出要擦掉的区域。选区里的图片和可处理的嵌套内容会露出下方内容。原有文字和矢量线条可继续单独编辑。', 'Select the regions to erase. Images and supported nested content reveal the layers beneath. Original text and vector paths stay editable.')}</p>
      <p>{t('需要补回图片底色时，请在「编辑原文」中选中图片，使用「图片裁切 / 橡皮擦」。', 'To repair the background of a picture, select it in Edit original and choose Image crop / eraser.')}</p>
      <p>{t('裁掉的内容可能仍在 PDF 文件中。', 'Clipped content may still exist in the PDF file.')}</p>
    </aside><main className="image-workbench-stage">
      {image ? <RegionSelection image={image} crop={selection} shape={shape} onChange={setSelection} disabled={working} allowMultiple zoomable/> :
        !error && <p className="image-preview-pending" role="status"><LoaderCircle size={15} className="spin"/>{t('正在生成页面预览…', 'Rendering page preview…')}</p>}
    </main></div>
    {error && <p className="dt-error" role="alert">{error}</p>}
    <footer><span>{t('应用后可撤销', 'Undo is available after applying')}</span>
      <button className="button secondary" disabled={working} onClick={onClose}>{t('取消', 'Cancel')}</button>
      <button className="button primary" disabled={!selection || working} onClick={() => void apply()}>
        {working ? <LoaderCircle size={15} className="spin"/> : <Eraser size={15}/>} {t('擦除选区', 'Erase selected regions')}
      </button>
    </footer>
  </section></div>;
}
