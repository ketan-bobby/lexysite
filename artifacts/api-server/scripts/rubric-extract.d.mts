/** Types for the existing shared JS extractor; no runtime/prompt changes. */
export const RUBRIC_FILES: string[];
export const LOCK_PATH: string;
export function extractRubric(relativeFile: string): string;
export function liveRubric(): string;
export function contractSpans(): [string, string][];
export function rubricSha256(rubric: string): string;
export function contractSha256(): string;
