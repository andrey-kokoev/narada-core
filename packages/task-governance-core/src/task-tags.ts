/**
 * Canonical task tag normalization for the neutral task-governance domain.
 *
 * Tags are deliberately small, site-local labels. They are never used as an
 * authorization, routing, priority, dependency, review, or closure signal.
 */

export const MAX_TASK_TAGS = 20;
export const MAX_TASK_TAG_LENGTH = 64;

export function normalizeTaskTag(value: unknown): string {
  if (typeof value !== 'string') throw new Error('task_tag_must_be_string');
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-');
  if (!normalized) throw new Error('task_tag_empty');
  if (normalized.length > MAX_TASK_TAG_LENGTH) throw new Error('task_tag_too_long');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized)) {
    throw new Error('task_tag_invalid_format');
  }
  return normalized;
}

export function normalizeTaskTags(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('task_tags_must_be_array');
  if (value.length > MAX_TASK_TAGS) throw new Error('task_tags_limit_exceeded');
  return [...new Set(value.map(normalizeTaskTag))].sort();
}

/** Parse the comma-separated or array form used by task frontmatter. */
export function parseTaskTagsValue(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed.replace(/'/g, '"'));
        if (Array.isArray(parsed)) return normalizeTaskTags(parsed);
      } catch {
        // Fall through to the bounded YAML-inline compatibility parser below.
      }
      const inner = trimmed.slice(1, -1).trim();
      if (!inner) return [];
      return normalizeTaskTags(inner.split(',').map((item) => {
        const token = item.trim();
        return token.length >= 2
          && ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'")))
          ? token.slice(1, -1)
          : token;
      }));
    }
    return normalizeTaskTags(trimmed.split(','));
  }
  return normalizeTaskTags(value);
}

/** Read persisted JSON defensively so old or manually repaired records remain readable. */
export function parseStoredTaskTags(value: unknown): string[] {
  if (typeof value !== 'string' || value.trim().length === 0) return [];
  try {
    return normalizeTaskTags(JSON.parse(value));
  } catch {
    return [];
  }
}
