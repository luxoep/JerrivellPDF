// SPDX-License-Identifier: MIT OR Apache-2.0
import type { WorkspacePage } from './types';

export interface WorkspaceDocument { id: string; name: string; pages: number; firstPageId: string }
/** Derive from the current history entry so imports, copies, deletion and undo stay live. */
export function workspaceDocuments(pages: WorkspacePage[]): WorkspaceDocument[] {
  const documents = new Map<string, WorkspaceDocument>();
  for (const page of pages) {
    const existing = documents.get(page.documentId);
    if (existing) existing.pages++;
    else documents.set(page.documentId, { id: page.documentId, name: page.sourceName, pages: 1, firstPageId: page.id });
  }
  return [...documents.values()];
}
