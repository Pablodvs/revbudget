export function normalizePattern(pattern: string): string {
  return pattern.toLowerCase().replace(/\s+/g, ' ').trim();
}

export const MIN_CONTAINS_PATTERN_LENGTH = 3;
