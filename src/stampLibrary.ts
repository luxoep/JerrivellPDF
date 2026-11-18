// SPDX-License-Identifier: MIT OR Apache-2.0
// The library stores user-authored PNG data locally, never native worker handles.
export type LibraryKind = 'stamp' | 'signature';
export interface LibraryItem {
  id: string;
  name: string;
  kind: LibraryKind;
  dataUrl: string;
  width: number;
  height: number;
  createdAt: string;
  blendMode?: 'normal' | 'multiply';
}

export const STAMP_LIBRARY_KEY = 'rivuleaf-stamp-library-v1';
export const MAX_LIBRARY_ITEMS = 20;
export const MAX_LIBRARY_IMAGE_BYTES = 1024 * 1024;
export const MAX_LIBRARY_STORAGE_BYTES = 4 * 1024 * 1024;

export class LibraryError extends Error {
  constructor(public readonly code: 'invalid' | 'image-size' | 'count' | 'storage-size' | 'storage') { super(code); }
}

export function pngByteLength(dataUrl: string): number {
  if (!dataUrl.startsWith('data:image/png;base64,')) throw new LibraryError('invalid');
  const encoded = dataUrl.slice('data:image/png;base64,'.length);
  if (!encoded.startsWith('iVBORw0KGgo') || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new LibraryError('invalid');
  return encoded.length / 4 * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
}

function validItem(value: unknown): value is LibraryItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<LibraryItem>;
  if (typeof item.id !== 'string' || !item.id.trim() || item.id.length > 80 || typeof item.name !== 'string' || !cleanLibraryName(item.name) || Array.from(item.name).length > 80
    || (item.blendMode !== undefined && !['normal', 'multiply'].includes(item.blendMode))
    || !['stamp', 'signature'].includes(item.kind ?? '') || typeof item.dataUrl !== 'string'
    || typeof item.width !== 'number' || typeof item.height !== 'number'
    || !Number.isInteger(item.width) || !Number.isInteger(item.height) || item.width < 1 || item.height < 1
    || item.width > 2400 || item.height > 2400 || typeof item.createdAt !== 'string') return false;
  try { return pngByteLength(item.dataUrl) <= MAX_LIBRARY_IMAGE_BYTES; } catch { return false; }
}

function storedItem(item: LibraryItem): LibraryItem {
  const { id, name, kind, dataUrl, width, height, createdAt, blendMode } = item;
  return { id, name, kind, dataUrl, width, height, createdAt, ...(blendMode ? { blendMode } : {}) };
}

export function loadStampLibrary(storage: Pick<Storage, 'getItem'> = localStorage): LibraryItem[] {
  try {
    const raw = storage.getItem(STAMP_LIBRARY_KEY);
    if (!raw) return [];
    if (raw.length * 2 > MAX_LIBRARY_STORAGE_BYTES) throw new LibraryError('storage-size');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length > MAX_LIBRARY_ITEMS || !parsed.every(validItem)) throw new LibraryError('invalid');
    if (new Set(parsed.map(item => item.id)).size !== parsed.length) throw new LibraryError('invalid');
    return parsed.map(storedItem);
  } catch (error) {
    if (error instanceof LibraryError) throw error;
    if (error instanceof SyntaxError) throw new LibraryError('invalid');
    throw new LibraryError('storage');
  }
}

export function saveStampLibrary(items: LibraryItem[], storage: Pick<Storage, 'setItem'> = localStorage): void {
  if (items.length > MAX_LIBRARY_ITEMS) throw new LibraryError('count');
  if (new Set(items.map(item => item.id)).size !== items.length) throw new LibraryError('invalid');
  for (const item of items) {
    if (typeof item.dataUrl === 'string' && pngByteLength(item.dataUrl) > MAX_LIBRARY_IMAGE_BYTES) throw new LibraryError('image-size');
    if (!validItem(item)) throw new LibraryError('invalid');
  }
  const serialized = JSON.stringify(items.map(storedItem));
  // WebView localStorage uses UTF-16 strings; leave headroom for the key and metadata.
  if ((serialized.length + STAMP_LIBRARY_KEY.length + 256) * 2 > MAX_LIBRARY_STORAGE_BYTES) throw new LibraryError('storage-size');
  try { storage.setItem(STAMP_LIBRARY_KEY, serialized); } catch { throw new LibraryError('storage'); }
}

export function cleanLibraryName(value: string): string {
  return Array.from(value.replace(/[\u0000-\u001f\u007f]/g, '').trim()).slice(0, 80).join('');
}

export function pngFileName(name: string): string {
  let safe = cleanLibraryName(name).replace(/[<>:"/\\|?*]/g, '_').replace(/[. ]+$/g, '').replace(/\.png$/i, '');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(safe)) safe = `_${safe}`;
  return `${safe || 'jerrivell-image'}.png`;
}
