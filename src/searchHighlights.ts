// SPDX-License-Identifier: MIT OR Apache-2.0
import { pageReference } from './backend';
import type { PageRef, WorkspaceMatch, WorkspacePage } from './types';

// Added text, stamps and marks are painted images. They cannot change the
// coordinates of the searchable native text or invalidate its highlights.
export const searchablePageReference = (page: PageRef) => pageReference({ ...page, overlays: [] });

export function searchHighlightsByPage(query: string, searchedQuery: string, results: WorkspaceMatch[]) {
  return new Map(query.trim() === searchedQuery
    ? results.filter(hit => hit.rects?.length).map(hit => [hit.id, hit] as const)
    : []);
}

export function searchBoundsForPage(highlights: ReadonlyMap<string, WorkspaceMatch>, page: WorkspacePage) {
  const result = highlights.get(page.id);
  return result && result.pageKey === JSON.stringify(searchablePageReference(page)) ? result.rects : undefined;
}
