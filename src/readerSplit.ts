// SPDX-License-Identifier: MIT OR Apache-2.0
export type SplitDirection = 'left-right' | 'top-bottom';
export type ReaderSplit = { direction: SplitDirection; tabs: [string, string] };

function otherTab(tabs: readonly string[], active: string): string | undefined {
  const index = tabs.indexOf(active);
  return tabs[index - 1] ?? tabs[index + 1];
}

export function toggleReaderSplit(
  current: ReaderSplit | null, direction: SplitDirection, tabs: readonly string[], active: string,
): ReaderSplit | null {
  if (current) return current.direction === direction ? null : { ...current, direction };
  const peer = otherTab(tabs, active);
  return peer && tabs.includes(active) ? { direction, tabs: [active, peer] } : null;
}

export function retargetReaderSplit(
  current: ReaderSplit | null, tabs: readonly string[], previous: string, active: string,
): ReaderSplit | null {
  if (!current || tabs.length < 2 || !tabs.includes(active)) return null;
  const [first, second] = current.tabs;
  let activeSlot = current.tabs.indexOf(active);
  if (activeSlot < 0) activeSlot = second === previous ? 1 : 0;
  const existing = activeSlot === 0 ? second : first;
  const peer = existing !== active && tabs.includes(existing) ? existing : otherTab(tabs, active);
  if (!peer) return null;
  const next: ReaderSplit['tabs'] = activeSlot === 0 ? [active, peer] : [peer, active];
  return next[0] === first && next[1] === second ? current : { ...current, tabs: next };
}

export function replaceReaderPeer(
  current: ReaderSplit | null, active: string, peer: string,
): ReaderSplit | null {
  if (!current || active === peer || !current.tabs.includes(active) || current.tabs.includes(peer)) return current;
  return { ...current, tabs: current.tabs[0] === active ? [active, peer] : [peer, active] };
}
