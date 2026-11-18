// SPDX-License-Identifier: MIT OR Apache-2.0
import { previewImageAsset } from '../backend';
import { visiblePageSize } from '../viewerGeometry';
import type { ObjectPreviewLayers, PageOverlay, RenderedPageLayers, WorkspacePage } from '../types';
import type { ContentBounds } from '../originalContent';

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
    {(page.overlays ?? []).map(value => {
      const item = placement?.id === value.id ? placement : value;
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
