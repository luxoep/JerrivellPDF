import type { ContentEdit } from './originalContent';

export interface PageOverlay {
  id: string;
  assetId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  /** Compositing mode for added images and reusable PDF fragments. */
  blendMode?: 'normal' | 'multiply';
  /** Clockwise orientation of the placed image inside its visible rectangle. */
  rotation?: number;
  /** Workspace editing guard; omitted from the PDF worker and exported PDF. */
  locked?: boolean;
  /** Editable only in this workspace; exported content is a transparent image. */
  textSource?: import('./components/overlayCanvas').TextOverlaySource;
}

export interface ImageAsset {
  id: string;
  dataUrl: string;
  width: number;
  height: number;
}

export interface ImageFilePreview {
  dataUrl: string; width: number; height: number;
  thumbnailWidth: number; thumbnailHeight: number;
}

/** Matches Rust PdfStampInfo's serde(flatten) JSON response. */
export interface PdfStampImage extends ImageAsset {
  pageCount: number;
}

export interface PageRef {
  documentId: string;
  pageIndex: number;
  rotation: number;
  overlays?: PageOverlay[];
  contentEdits?: ContentEdit[];
  decorations?: PageDecoration[];
}

export interface PageDecoration {
  id: string; kind: 'number' | 'watermark'; text: string; fontFamily?: string | null; fontSize: number;
  color: string; opacity: number; angle: number; x: number; y: number; alignment: 'left' | 'center' | 'right';
}

export interface SourcePage {
  index: number;
  width: number;
  height: number;
  rotation: number;
}

export interface DocumentInfo {
  id: string;
  path: string;
  fileName: string;
  pageCount: number;
  fileSize: number;
  pages: SourcePage[];
  warnings: string[];
}

export interface WorkspacePage extends PageRef {
  id: string;
  width: number;
  height: number;
  sourceName: string;
}

export interface RenderedPage {
  dataUrl: string;
  width: number;
  height: number;
}

export interface RenderedPageLayers {
  background: RenderedPage;
  foreground: { image: RenderedPage; blendMode: 'normal' | 'multiply' }[];
}

export interface ObjectPreviewLayers {
  lower: RenderedPage; moving: RenderedPage; upper: RenderedPage;
  foreground: RenderedPageLayers['foreground'];
}

export interface BackendStatus {
  engineReady: boolean;
  engineVersion?: string;
  message?: string;
}

export interface SearchMatch {
  pageIndex: number;
  matchCount: number;
  preview: string;
}

export interface WorkspaceMatch extends SearchMatch {
  id: string;
  workspaceIndex: number;
}
