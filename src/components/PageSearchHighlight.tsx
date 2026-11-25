// SPDX-License-Identifier: MIT OR Apache-2.0
import type { ContentBounds } from '../originalContent';
import './page-search-highlight.css';

export function PageSearchHighlight({ bounds, active }: { bounds?: ContentBounds[]; active: boolean }) {
  if (!bounds?.length) return null;
  const path = bounds.map(({ x, y, width, height }) => `M${x} ${y}h${width}v${height}h${-width}z`).join('');
  return <svg className={`pdf-search-highlight${active ? ' is-active' : ''}`} viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
    <path d={path}/>
  </svg>;
}
