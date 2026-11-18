// SPDX-License-Identifier: MIT OR Apache-2.0
import { previewImageAsset } from '../backend';
import { visiblePageSize } from '../viewerGeometry';
import type { ObjectPreviewLayers, PageOverlay, RenderedPageLayers, WorkspacePage } from '../types';
import type { ContentBounds } from '../originalContent';
import { useMemo } from 'react';
import { measureTextFrame } from '../textFrame';
import { previewEditableOverlays } from '../editableOverlays';
import { MarkShape } from './MarkLayer';
import { cssFontFamily } from './overlayCanvas';

function TextFrameShape({ item, pageWidth, pageHeight }: { item: PageOverlay; pageWidth: number; pageHeight: number }) {
  const layout = useMemo(() => { try { return measureTextFrame(item, pageWidth, pageHeight); } catch { return null; } }, [item, pageWidth, pageHeight]);
  const source = item.textSource!;
  if (!layout) return null;
  const rotation = item.rotation ?? 0, quarter = rotation % 180 !== 0;
  const w = item.width * pageWidth, h = item.height * pageHeight;
  const imageW = quarter ? h : w, imageH = quarter ? w : h;
  return <g data-live-overlay={item.id} data-text-frame-preview transform={`translate(${(item.x + item.width / 2) * pageWidth} ${(item.y + item.height / 2) * pageHeight}) rotate(${rotation})`} opacity={item.opacity}>
    <g transform={`translate(${-imageW / 2} ${-imageH / 2})`} fill={source.color} fontFamily={cssFontFamily(source.fontFamily)} fontSize={source.fontSize} fontWeight={source.bold ? 600 : 400} fontStyle={source.italic ? 'italic' : 'normal'} letterSpacing={source.charSpacing ?? 0}>
      {layout.layoutLines.map((line, index) => <g key={index}><text x={line.x} y={line.y} xmlSpace="preserve">{line.text}</text>
        {source.underline && <path d={`M${line.x} ${line.y + source.fontSize * .1}h${line.width}`} stroke={source.color} strokeWidth={Math.max(.5, source.fontSize / 18)} />}
        {source.strikeout && <path d={`M${line.x} ${line.y - source.fontSize * .33}h${line.width}`} stroke={source.color} strokeWidth={Math.max(.5, source.fontSize / 18)} />}</g>)}
    </g>
  </g>;
}

/** A single isolated SVG gives Multiply the PDF pixels as its backdrop.
 * Native decorations and annotations remain above added page content. */
export function LivePageImage({ page, layers, label, placement, nativePlacement }: {
  page: WorkspacePage; layers: RenderedPageLayers; label: string; placement?: PageOverlay | null;
  nativePlacement?: { layers: ObjectPreviewLayers; original: ContentBounds; bounds: ContentBounds };
}) {
  const { width, height } = visiblePageSize(page);
  return <svg className="live-page-image" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
    {nativePlacement ? <>
      <image data-object-lower href={nativePlacement.layers.lower.dataUrl} width={width} height={height} preserveAspectRatio="none"/>
      <image data-object-moving href={nativePlacement.layers.moving.dataUrl} width={width} height={height} preserveAspectRatio="none" transform={`translate(${(nativePlacement.bounds.x-nativePlacement.original.x*nativePlacement.bounds.width/nativePlacement.original.width)*width} ${(nativePlacement.bounds.y-nativePlacement.original.y*nativePlacement.bounds.height/nativePlacement.original.height)*height}) scale(${nativePlacement.bounds.width/nativePlacement.original.width} ${nativePlacement.bounds.height/nativePlacement.original.height})`}/>
      <image data-object-upper href={nativePlacement.layers.upper.dataUrl} width={width} height={height} preserveAspectRatio="none"/>
    </> : <image data-pdf-background href={layers.background.dataUrl} x={0} y={0} width={width} height={height} preserveAspectRatio="none"/>}
    {previewEditableOverlays(page.overlays ?? [], placement ?? null).map(item => {
      if (item.markSource) return <g key={item.id} data-live-overlay={item.id} opacity={item.opacity} style={{ mixBlendMode: item.blendMode === 'multiply' ? 'multiply' : 'normal' }}><MarkShape mark={item.markSource.geometry} color={item.markSource.color}/></g>;
      if (item.textSource && placement?.id === item.id) return <TextFrameShape key={item.id} item={item} pageWidth={width} pageHeight={height}/>;
      const asset = previewImageAsset(item.assetId);
      if (!asset) return null;
      const w = item.width * width, h = item.height * height, rotation = item.rotation ?? 0;
      const rotated = rotation % 180 !== 0;
      const imageWidth = rotated ? h : w, imageHeight = rotated ? w : h;
      return <image key={item.id} data-live-overlay={item.id} href={asset.dataUrl} x={-imageWidth / 2} y={-imageHeight / 2} width={imageWidth} height={imageHeight}
        transform={`translate(${(item.x + item.width / 2) * width} ${(item.y + item.height / 2) * height}) rotate(${rotation})`}
        opacity={item.opacity} style={{ mixBlendMode: item.blendMode === 'multiply' ? 'multiply' : 'normal' }} preserveAspectRatio="none"/>;
    })}
    {layers.foreground.map((layer,index) => <image key={index} data-pdf-foreground={index} href={layer.image.dataUrl} x={0} y={0} width={width} height={height} preserveAspectRatio="none" style={{ mixBlendMode: layer.blendMode }}/>) }
  </svg>;
}
