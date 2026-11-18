// SPDX-License-Identifier: MIT OR Apache-2.0
import {optionsKey, validOptions, validRegion} from './types';
import type {Options, Region, Report, Source} from './types';

export const projectExtension = 'jvcmp';
export const maxReviewNoteLength = 500;
export const maxReviewNoteBytes = 256 * 1024;

export interface ReviewEntry {
  region: Region;
  reviewed: boolean;
  note: string;
}

export interface OpenProjectRequest {
  path: string;
  sourceAPath?: string;
  sourceBPath?: string;
  passwordA?: string;
  passwordB?: string;
}

export interface OpenedProject {
  fileName: string;
  a: Source;
  b: Source;
  options: Options;
  review: ReviewEntry[];
  selectedRegion: Region | null;
}
export type ReviewCheckpoint = Pick<OpenedProject, 'options'|'review'|'selectedRegion'>;

export interface SaveProjectRequest {
  path: string;
  options: Options;
  jobId: string | null;
  review: {regionId:number;reviewed:boolean;note:string}[];
  selectedRegionId: number | null;
}

const validSource = (source: Source) => source && typeof source.fileName === 'string'
  && Number.isSafeInteger(source.fileSize) && source.fileSize > 0
  && Array.isArray(source.pages) && source.pages.length > 0 && source.pages.length <= 5000
  && source.pages.every(page => [page?.width, page?.height].every(value => Number.isFinite(value) && value > 0));

export function validateOpenedProject(project: OpenedProject): OpenedProject {
  if (!project || typeof project.fileName !== 'string' || !validSource(project.a) || !validSource(project.b)
    || !validOptions(project.options) || project.options.pageA >= project.a.pages.length || project.options.pageB >= project.b.pages.length
    || !Array.isArray(project.review) || project.review.length > 5000
    || project.review.some(entry => !entry || !validRegion(entry.region) || typeof entry.reviewed !== 'boolean'
      || typeof entry.note !== 'string' || entry.note.length > maxReviewNoteLength)
    || new Set(project.review.map(entry => entry.region.id)).size !== project.review.length
    || (project.selectedRegion !== null && !validRegion(project.selectedRegion))) {
    throw Error('COMPARE_RESPONSE_INVALID');
  }
  return project;
}

/** Include the exact raster-derived bounds, marker and difference counts, not only
 * the result ID, which can identify a different region after a new analysis. */
function sameRegion(saved: Region, current: Region) {
  // This is much smaller than one pixel at the maximum analysis dimensions;
  // it only absorbs JSON floating-point round-trip differences.
  const close = (a: number, b: number) => Math.abs(a - b) <= 1e-10;
  return saved.id === current.id && saved.pixels === current.pixels && saved.added === current.added
    && saved.removed === current.removed && saved.changed === current.changed
    && (['x','y','width','height'] as const).every(key => close(saved.bounds[key], current.bounds[key]))
    && saved.point.every((value, index) => close(value, current.point[index]));
}

export function nextPendingRegion(regions: Region[], reviewed: ReadonlySet<number>, selected: number) {
  if (!regions.length) return undefined;
  const start = regions.findIndex(region => region.id === selected);
  for (let offset = 1; offset <= regions.length; offset++) {
    const candidate = regions[(start + offset) % regions.length];
    if (!reviewed.has(candidate.id)) return candidate.id === selected ? undefined : candidate;
  }
  return undefined;
}

export function restoreProjectReview(report: Report, project: ReviewCheckpoint, advance: boolean) {
  const sameOptions = optionsKey(report.options) === optionsKey(project.options);
  const regions = new Map(report.regions.map(region => [region.id, region]));
  const matches = (region: Region) => {
    const current = regions.get(region.id);
    return sameOptions && !!current && sameRegion(region, current);
  };
  const reviewed = new Set<number>();
  const notes = new Map<number, string>();
  let unmatched = 0;
  for (const entry of project.review) {
    if (!matches(entry.region)) {
      unmatched++;
      continue;
    }
    if (entry.reviewed) reviewed.add(entry.region.id);
    if (entry.note) notes.set(entry.region.id, entry.note);
  }
  const saved = project.selectedRegion && matches(project.selectedRegion) ? project.selectedRegion.id : 0;
  const pending = !saved || (advance && reviewed.has(saved)) ? nextPendingRegion(report.regions, reviewed, saved) : undefined;
  return {reviewed, notes, unmatched, selected:pending?.id ?? (saved || report.regions[0]?.id || 0)};
}

export function captureReview(regions: Region[], reviewed: ReadonlySet<number>, notes: ReadonlyMap<number, string>): ReviewEntry[] {
  return regions.filter(region => reviewed.has(region.id) || notes.has(region.id))
    .map(region => ({region, reviewed:reviewed.has(region.id), note:notes.get(region.id) ?? ''}));
}

export function checkpointReviewKey(entries: ReviewEntry[]) {
  const reviewed = new Set<number>();
  const notes = new Map<number, string>();
  for (const entry of entries) {
    if (entry.reviewed) reviewed.add(entry.region.id);
    if (entry.note) notes.set(entry.region.id, entry.note);
  }
  return reviewKey(reviewed, notes);
}

export function reviewKey(reviewed: ReadonlySet<number>, notes: ReadonlyMap<number, string>) {
  const ids = [...new Set([...reviewed, ...notes.keys()])].sort((left, right) => left - right);
  return JSON.stringify(ids.map(id => [id, reviewed.has(id), notes.get(id) ?? '']));
}
