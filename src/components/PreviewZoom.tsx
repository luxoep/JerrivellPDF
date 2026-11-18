// SPDX-License-Identifier: MIT OR Apache-2.0
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Maximize2, Minus, Plus } from 'lucide-react';
import { createPreviewZoomController } from '../previewZoom';
import { useI18n } from '../i18n';
import './preview-zoom.css';

export function PreviewZoom({ width, height, resetKey, label, children, disabled = false, className = '' }: {
  width: number; height: number; resetKey: string; label: string; children: ReactNode; disabled?: boolean; className?: string;
}) {
  const { t } = useI18n(), [scale, setScale] = useState(1);
  const viewport = useRef<HTMLDivElement>(null), extent = useRef<HTMLDivElement>(null), paper = useRef<HTMLDivElement>(null);
  const controller = useRef<ReturnType<typeof createPreviewZoomController> | null>(null);
  useEffect(() => {
    if (!viewport.current || !extent.current || !paper.current) return;
    controller.current = createPreviewZoomController(viewport.current, extent.current, paper.current, width, height, setScale, disabled);
    return () => { controller.current?.destroy(); controller.current = null; };
  }, [width, height, resetKey]);
  useEffect(() => { controller.current?.setDisabled(disabled); }, [disabled]);
  const hint = t('Ctrl + 滚轮缩放；普通滚轮滚动预览', 'Ctrl + wheel to zoom; wheel to scroll the preview');
  return <div className={`preview-zoom ${className}`}>
    <div className="preview-zoom-tools" role="group" aria-label={t('预览缩放', 'Preview zoom')}>
      <span title={hint}>{t('Ctrl + 滚轮', 'Ctrl + wheel')}</span>
      <button type="button" disabled={disabled || scale <= .25} aria-label={t('缩小预览', 'Zoom preview out')} title={t('缩小预览', 'Zoom preview out')} onClick={() => controller.current?.zoomBy(1 / 1.2)}><Minus size={13}/></button>
      <button type="button" className="preview-zoom-reset" disabled={disabled} title={t('重置为适应视口', 'Reset to fit viewport')} aria-label={t('重置预览为适应视口', 'Reset preview to fit viewport')} onClick={() => controller.current?.reset()}><Maximize2 size={12}/>{Math.round(scale * 100)}%</button>
      <button type="button" disabled={disabled || scale >= 8} aria-label={t('放大预览', 'Zoom preview in')} title={t('放大预览', 'Zoom preview in')} onClick={() => controller.current?.zoomBy(1.2)}><Plus size={13}/></button>
    </div>
    <div ref={viewport} className="preview-zoom-viewport" tabIndex={0} aria-label={label} title={hint}>
      <div ref={extent} className="preview-zoom-extent"><div ref={paper} className="preview-zoom-paper">{children}</div></div>
    </div>
  </div>;
}
