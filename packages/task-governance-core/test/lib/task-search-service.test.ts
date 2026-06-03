import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchTasksService, findTaskSearchMatches } from '../../src/task-search-service.js';
import { openTaskLifecycleStore } from '../../src/task-lifecycle-store.js';
import { ExitCode } from '../../src/exit-codes.js';

describe('task search service', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'narada-task-search-service-'));
    mkdirSync(join(tempDir, '.ai', 'do-not-open', 'tasks'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('requires a non-empty query', async () => {
    const result = await searchTasksService({ query: ' ', cwd: tempDir });

    expect(result.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(result.result).toEqual({ status: 'error', error: 'Search query is required' });
  });

  it('uses SQLite lifecycle and task spec metadata when searching markdown text', async () => {
    writeFileSync(
      join(tempDir, '.ai', 'do-not-open', 'tasks', '20260425-711-search.md'),
      `---\nstatus: opened\n---\n\n# Markdown Title\n\nSearch needle lives in compatibility markdown.\n`,
    );
    const store = openTaskLifecycleStore(tempDir);
    try {
      store.upsertLifecycle({
        task_id: '20260425-711-search',
        task_number: 711,
        status: 'closed',
        governed_by: 'task_close:test',
        closed_at: '2026-04-25T00:00:00Z',
        closed_by: 'test',
        closure_mode: 'operator_direct',
        reopened_at: null,
        reopened_by: null,
        continuation_packet_json: null,
        updated_at: '2026-04-25T00:00:00Z',
      });
      store.upsertTaskSpec({
        task_id: '20260425-711-search',
        task_number: 711,
        title: 'SQLite Spec Title',
        chapter_markdown: null,
        goal_markdown: null,
        context_markdown: null,
        required_work_markdown: null,
        non_goals_markdown: null,
        acceptance_criteria_json: '[]',
        dependencies_json: '[]',
        updated_at: '2026-04-25T00:00:00Z',
      });
    } finally {
      store.db.close();
    }

    const result = await searchTasksService({
      query: 'needle',
      cwd: tempDir,
    });

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.result.status).toBe('success');
    expect(result.result.results).toHaveLength(1);
    expect(result.result.results![0]!.title).toBe('SQLite Spec Title');
    expect(result.result.results![0]!.status).toBe('closed');
  });

  it('sorts results by task number descending and ignores derivative files', async () => {
    writeFileSync(
      join(tempDir, '.ai', 'do-not-open', 'tasks', '20260425-709-old.md'),
      `---\nstatus: opened\n---\n\n# Old\n\nneedle\n`,
    );
    writeFileSync(
      join(tempDir, '.ai', 'do-not-open', 'tasks', '20260425-712-new.md'),
      `---\nstatus: opened\n---\n\n# New\n\nneedle\n`,
    );
    writeFileSync(
      join(tempDir, '.ai', 'do-not-open', 'tasks', '20260425-713-derived-RESULT.md'),
      `---\nstatus: opened\n---\n\n# Derived\n\nneedle\n`,
    );

    const result = await searchTasksService({ query: 'needle', cwd: tempDir });

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.result.results?.map((r) => r.task_number)).toEqual([712, 709]);
  });

  it('returns bounded compact snippets', () => {
    const matches = findTaskSearchMatches(
      'first needle '.repeat(10),
      'needle',
      2,
    );

    expect(matches).toHaveLength(2);
    expect(matches.every((m) => m.includes('needle'))).toBe(true);
  });
});
