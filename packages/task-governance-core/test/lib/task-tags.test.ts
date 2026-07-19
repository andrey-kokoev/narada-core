import { describe, expect, it } from 'vitest';
import Database from '../../src/sqlite-database.js';
import {
  MAX_TASK_TAGS,
  normalizeTaskTags,
  requireTaskTagsArray,
  parseTaskTagsValue,
  parseStoredTaskTags,
} from '../../src/task-tags.js';
import { parseTaskSpecFromMarkdown } from '../../src/task-spec.js';
import { SqliteTaskLifecycleStore } from '../../src/task-lifecycle-store.js';

describe('task tags', () => {
  it('normalizes, deduplicates, and sorts kebab-case labels', () => {
    expect(normalizeTaskTags([' MCP Surface ', 'mcp_surface', 'Review'])).toEqual(['mcp-surface', 'review']);
  });

  it('enforces the bounded tag shape', () => {
    expect(() => normalizeTaskTags(Array.from({ length: MAX_TASK_TAGS + 1 }, (_, index) => `tag-${index}`))).toThrow('task_tags_limit_exceeded');
    expect(() => normalizeTaskTags(['not/a-label'])).toThrow('task_tag_invalid_format');
  });

  it('keeps optional persisted parsing separate from strict mutation input', () => {
    expect(normalizeTaskTags(undefined)).toEqual([]);
    expect(normalizeTaskTags(null)).toEqual([]);
    expect(requireTaskTagsArray(['MCP Surface'])).toEqual(['mcp-surface']);
    expect(() => requireTaskTagsArray(undefined)).toThrow('task_tags_must_be_array');
    expect(() => requireTaskTagsArray(null)).toThrow('task_tags_must_be_array');
  });

  it('reads tags from task frontmatter without inferring them', () => {
    const spec = parseTaskSpecFromMarkdown({
      taskId: '20260718-1-tagged-task',
      taskNumber: 1,
      frontMatter: { tags: 'MCP Surface, Review' },
      body: '# Tagged task\n\n## Goal\n\nImprove the surface.\n\n## Acceptance Criteria\n\n- [ ] The test passes.',
    });
    expect(spec.tags).toEqual(['mcp-surface', 'review']);
    expect(parseTaskTagsValue('[mcp-surface, review]')).toEqual(['mcp-surface', 'review']);
    expect(parseTaskTagsValue("['mcp-surface', 'review']")).toEqual(['mcp-surface', 'review']);
  });

  it('replaces tags atomically and keeps an audit history', () => {
    const db = new Database(':memory:');
    try {
      const store = new SqliteTaskLifecycleStore({ db });
      store.initSchema();
      store.upsertLifecycle({
        task_id: 'task-1',
        task_number: 1,
        status: 'opened',
        governed_by: null,
        closed_at: null,
        closed_by: null,
        reopened_at: null,
        reopened_by: null,
        continuation_packet_json: null,
        updated_at: '2026-07-18T00:00:00.000Z',
      });
      store.upsertTaskSpec({
        task_id: 'task-1',
        task_number: 1,
        title: 'Tagged task',
        acceptance_criteria_json: '[]',
        dependencies_json: '[]',
        tags_json: JSON.stringify(['old']),
      });

      const result = store.replaceTaskTags({
        taskId: 'task-1',
        tags: ['New Label', 'new-label'],
        actorAgentId: 'agent-1',
        reason: 'Classify the task for discovery.',
        updateId: 'tag-update-1',
        updatedAt: '2026-07-18T00:01:00.000Z',
      });

      expect(result.status).toBe('updated');
      expect(result.previous_tags).toEqual(['old']);
      expect(result.tags).toEqual(['new-label']);
      expect(parseStoredTaskTags(store.getTaskSpec('task-1')?.tags_json)).toEqual(['new-label']);
      expect(store.listTaskTagUpdates('task-1')).toMatchObject([{
        update_id: 'tag-update-1',
        actor_agent_id: 'agent-1',
        reason: 'Classify the task for discovery.',
        previous_tags: ['old'],
        tags: ['new-label'],
      }]);
      expect(store.listTaskTagUpdates('task-1')[0]).not.toHaveProperty('previous_tags_json');
      expect(store.listTaskTagUpdates('task-1')[0]).not.toHaveProperty('new_tags_json');

      store.upsertTaskSpec({
        task_id: 'task-1',
        task_number: 1,
        title: 'Retitled task',
        acceptance_criteria_json: '[]',
        dependencies_json: '[]',
      });
      expect(parseStoredTaskTags(store.getTaskSpec('task-1')?.tags_json)).toEqual(['new-label']);
    } finally {
      db.close();
    }
  });

  it('materializes a spec for a lifecycle-only task before tagging it', () => {
    const db = new Database(':memory:');
    try {
      const store = new SqliteTaskLifecycleStore({ db });
      store.initSchema();
      store.upsertLifecycle({
        task_id: 'lifecycle-only',
        task_number: 42,
        status: 'opened',
        governed_by: null,
        closed_at: null,
        closed_by: null,
        reopened_at: null,
        reopened_by: null,
        continuation_packet_json: null,
        updated_at: '2026-07-18T00:00:00.000Z',
      });

      const result = store.replaceTaskTags({
        taskId: 'lifecycle-only',
        tags: ['Legacy Task'],
        actorAgentId: 'agent-1',
        reason: 'Make the legacy task discoverable.',
        updateId: 'tag-update-legacy',
      });

      expect(result.status).toBe('updated');
      expect(result.previous_tags).toEqual([]);
      expect(result.tags).toEqual(['legacy-task']);
      expect(store.getTaskSpec('lifecycle-only')?.title).toBe('Task 42');
      expect(store.listTaskTagUpdates('lifecycle-only')[0]?.previous_tags).toEqual([]);
    } finally {
      db.close();
    }
  });
});
