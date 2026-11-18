export type PageRangeErrorCode = 'EMPTY' | 'FORMAT' | 'BOUNDS' | 'ORDER' | 'TOO_LONG';
export class PageRangeError extends Error {
  constructor(public readonly code: PageRangeErrorCode) { super(code); }
}

/** One-based user input becomes unique zero-based indices in document order. */
export function parsePageRange(input: string, pageCount: number, emptyMeansAll = false): number[] {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 5000) throw new PageRangeError('BOUNDS');
  if (input.length > 1024) throw new PageRangeError('TOO_LONG');
  const text = input.trim();
  if (!text) {
    if (emptyMeansAll) return Array.from({ length: pageCount }, (_, i) => i);
    throw new PageRangeError('EMPTY');
  }
  const tokens = text.replace(/\s*[-–—]\s*/g, '-').split(/[,，、;；\s]+/);
  const selected = new Set<number>();
  for (const token of tokens) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(token);
    if (!match) throw new PageRangeError('FORMAT');
    const from = Number(match[1]); const to = Number(match[2] ?? match[1]);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to > pageCount) throw new PageRangeError('BOUNDS');
    if (from > to) throw new PageRangeError('ORDER');
    for (let index = from - 1; index < to; index++) selected.add(index);
  }
  return [...selected].sort((a, b) => a - b);
}
