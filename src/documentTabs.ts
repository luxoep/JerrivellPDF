// SPDX-License-Identifier: MIT OR Apache-2.0
import type { DocumentInfo, WorkspaceMatch, WorkspacePage } from './types';
import type { ViewerZoom, ViewAnchor } from './viewerGeometry';

export type DocumentHistory = { entries: WorkspacePage[][]; cursor: number };
export type ReaderViewState = { anchor: ViewAnchor | null; atStart: boolean };
export type WorkspaceSnapshot = {
  history: DocumentHistory; sources: DocumentInfo[]; activeId: string; selection: Set<string>;
  title: string; savedSignature: string; savedPath: string; projectPath: string;
  zoom: ViewerZoom; panel: 'pages' | 'search'; rangeInput: string;
  query: string; searchResults: WorkspaceMatch[]; searchError: string; searchedQuery: string;
  view: ReaderViewState | null;
};
export type DocumentTab = { id: string; path: string; snapshot: WorkspaceSnapshot };
const pageSignatures = new WeakMap<WorkspacePage[], string>();
/** History plans are immutable. Weak keys do not retain closed tabs. */
export function documentSignature(pages: WorkspacePage[]): string {
  let value = pageSignatures.get(pages);
  if (value === undefined) { value = JSON.stringify(pages); pageSignatures.set(pages, value); }
  return value;
}

export function normalizedDocumentPath(path: string): string {
  let value = path.replace(/\\/g, '/');
  if (value.toLowerCase().startsWith('//?/unc/')) value = '//' + value.slice(8);
  else if (value.startsWith('//?/')) value = value.slice(4);
  return value.toLowerCase();
}
export function snapshotDirty(snapshot: WorkspaceSnapshot): boolean {
  const pages = snapshot.history.entries[snapshot.history.cursor];
  return pages.length > 0 && documentSignature(pages) !== snapshot.savedSignature;
}
export function workspaceSnapshot(pages: WorkspacePage[], sources: DocumentInfo[], title: string, projectPath = ''): WorkspaceSnapshot {
  return { history: { entries: [pages], cursor: 0 }, sources, title, projectPath,
    savedSignature: documentSignature(pages), savedPath: '', activeId: pages[0]?.id ?? '', selection: new Set(),
    zoom: 'fit', panel: 'pages', rangeInput: '', query: '', searchResults: [], searchError: '', searchedQuery: '', view: null };
}
/** Undo and redo entries also keep their source documents alive. */
export function retainedDocumentIds(tabs: DocumentTab[]): string[] {
  return [...new Set(tabs.flatMap(tab => tab.snapshot.history.entries.flatMap(pages => pages.map(page => page.documentId))))];
}
