import { vi } from 'vitest';

vi.unmock('node:fs');
vi.unmock('node:fs/promises');

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  loadRoster,
  saveRoster,
  withRosterMutation,
  updateAgentRosterEntry,
  atomicWriteFile,
  lintTaskFiles,
  extractTaskRefsFromBody,
  parseFrontMatter,
  serializeFrontMatter,
  readTaskFile,
  writeTaskFile,
  findTaskFile,
  createReportId,
  findReportByAssignmentId,
  detectReportAnomalies,
  loadReview,
  saveReport,
  saveReview,
  continuationReasonToIntent,
  getAssignmentIntent,
  resolveTaskStatus,
  checkDependencies,
  type AgentRoster,
  type TaskAssignment,
  type WorkResultReport,
} from '../../src/task-governance.js';
import { openTaskLifecycleStore } from '../../src/task-lifecycle-store.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeRoster(): AgentRoster {
  return {
    version: 2,
    updated_at: '2026-01-01T00:00:00Z',
    agents: [
      {
        agent_id: 'alpha',
        role: 'implementer',
        capabilities: ['claim'],
        first_seen_at: '2026-01-01T00:00:00Z',
        last_active_at: '2026-01-01T00:00:00Z',
        status: 'idle',
        task: null,
        last_done: null,
        updated_at: '2026-01-01T00:00:00Z',
      },
      {
        agent_id: 'beta',
        role: 'reviewer',
        capabilities: ['derive', 'propose'],
        first_seen_at: '2026-01-01T00:00:00Z',
        last_active_at: '2026-01-01T00:00:00Z',
        status: 'idle',
        task: null,
        last_done: null,
        updated_at: '2026-01-01T00:00:00Z',
      },
    ],
  };
}

async function setupRepo(tempDir: string, roster?: AgentRoster) {
  mkdirSync(join(tempDir, '.ai', 'agents'), { recursive: true });
  writeFileSync(
    join(tempDir, '.ai', 'agents', 'roster.json'),
    JSON.stringify(roster ?? makeRoster(), null, 2),
  );
  await saveRoster(tempDir, roster ?? makeRoster());
}

describe('withRosterMutation', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'narada-roster-lock-test-'));
    await setupRepo(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('applies a mutation and persists the roster', async () => {
    const result = await withRosterMutation(tempDir, (roster) => {
      const entry = roster.agents.find((a) => a.agent_id === 'alpha')!;
      entry.status = 'working';
      entry.task = 123;
      return roster;
    });

    expect(result.agents.find((a) => a.agent_id === 'alpha')?.status).toBe('working');
    expect(result.agents.find((a) => a.agent_id === 'alpha')?.task).toBe(123);

    // Re-read from disk to confirm persistence
    const reloaded = await loadRoster(tempDir);
    expect(reloaded.agents.find((a) => a.agent_id === 'alpha')?.status).toBe('working');
    expect(reloaded.agents.find((a) => a.agent_id === 'alpha')?.task).toBe(123);
  });

  it('rolls back on mutation error', async () => {
    const original = await loadRoster(tempDir);
    const rosterPath = join(tempDir, '.ai', 'agents', 'roster.json');
    const beforeMtime = statSync(rosterPath).mtimeMs;

    await expect(
      withRosterMutation(tempDir, () => {
        throw new Error('Intentional failure');
      }),
    ).rejects.toThrow('Intentional failure');

    // Roster must remain unchanged
    const after = await loadRoster(tempDir);
    expect(after.version).toBe(original.version);
    expect(after.agents).toHaveLength(original.agents.length);

    // The roster file must always exist and be valid JSON
    const diskRaw = await import('node:fs/promises').then((m) => m.readFile(rosterPath, 'utf8'));
    const parsed = JSON.parse(diskRaw);
    expect(parsed.agents).toBeInstanceOf(Array);
  });

  it('rejects invalid roster shape after mutation', async () => {
    await expect(
      withRosterMutation(tempDir, () => {
        return { version: 1 } as unknown as AgentRoster;
      }),
    ).rejects.toThrow('Roster mutation produced invalid agents array');
  });

  it('serializes conflicting mutations to the same agent deterministically', async () => {
    const results = await Promise.all([
      withRosterMutation(tempDir, (roster) => {
        const entry = roster.agents.find((a) => a.agent_id === 'alpha')!;
        entry.status = 'working';
        entry.task = 1;
        return roster;
      }),
      withRosterMutation(tempDir, (roster) => {
        const entry = roster.agents.find((a) => a.agent_id === 'alpha')!;
        entry.status = 'reviewing';
        entry.task = 2;
        return roster;
      }),
      withRosterMutation(tempDir, (roster) => {
        const entry = roster.agents.find((a) => a.agent_id === 'alpha')!;
        entry.status = 'done';
        entry.task = 3;
        return roster;
      }),
    ]);

    // All three mutations should succeed
    expect(results).toHaveLength(3);

    // Disk must reflect exactly one final state (last writer wins)
    const disk = await loadRoster(tempDir);
    const diskStatus = disk.agents.find((a) => a.agent_id === 'alpha')?.status;
    const diskTask = disk.agents.find((a) => a.agent_id === 'alpha')?.task;

    // The disk state must be one of the three attempted states
    expect(['working', 'reviewing', 'done']).toContain(diskStatus);
    expect([1, 2, 3]).toContain(diskTask);

    // The disk state must be consistent (status/task must come from the same mutation)
    const statePairs = results.map((r) => ({
      status: r.agents.find((a) => a.agent_id === 'alpha')?.status,
      task: r.agents.find((a) => a.agent_id === 'alpha')?.task,
    }));
    expect(statePairs.some((p) => p.status === diskStatus && p.task === diskTask)).toBe(true);
  });

  it('releases lock when mutation throws', async () => {
    const lockPath = join(tempDir, '.ai', 'agents', 'roster.lock');

    await expect(
      withRosterMutation(tempDir, () => {
        throw new Error('Boom');
      }),
    ).rejects.toThrow('Boom');

    // Lock file must not exist after the failed mutation
    expect(() => statSync(lockPath)).toThrow();
  });

  it('recovers a stale lock and succeeds', async () => {
    const lockPath = join(tempDir, '.ai', 'agents', 'roster.lock');
    // Create a stale lock file (older than 30s by manipulating mtime)
    writeFileSync(lockPath, JSON.stringify({ pid: 99999, created_at: '2020-01-01T00:00:00Z' }) + '\n');
    const farPast = new Date('2020-01-01T00:00:00Z');
    import('node:fs').then((fs) => fs.utimesSync(lockPath, farPast, farPast));

    // Mutation should succeed despite the stale lock
    const result = await withRosterMutation(tempDir, (roster) => {
      const entry = roster.agents.find((a) => a.agent_id === 'alpha')!;
      entry.status = 'blocked';
      return roster;
    });

    expect(result.agents.find((a) => a.agent_id === 'alpha')?.status).toBe('blocked');
    // Lock must be released after success
    expect(() => statSync(lockPath)).toThrow();
  });

  it('leaves no temp debris after successful mutation', async () => {
    // Perform several mutations
    await withRosterMutation(tempDir, (roster) => {
      roster.agents[0]!.status = 'working';
      return roster;
    });
    await withRosterMutation(tempDir, (roster) => {
      roster.agents[0]!.status = 'done';
      return roster;
    });

    // No temp files should remain in the agents directory
    const fs = await import('node:fs');
    const agentsDir = join(tempDir, '.ai', 'agents');
    const files = fs.readdirSync(agentsDir);
    const tmpFiles = files.filter((f) => f.startsWith('.tmp-'));
    expect(tmpFiles).toHaveLength(0);

    // Roster must be valid
    const disk = await loadRoster(tempDir);
    expect(disk.agents[0]!.status).toBe('done');
  });
});

describe('updateAgentRosterEntry (race-safe)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'narada-roster-update-test-'));
    await setupRepo(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('persists atomic writes under lock', async () => {
    const roster = await updateAgentRosterEntry(tempDir, 'alpha', {
      status: 'blocked',
      task: 123,
    });
    expect(roster.agents.find((a) => a.agent_id === 'alpha')?.status).toBe('blocked');

    const reloaded = await loadRoster(tempDir);
    expect(reloaded.agents.find((a) => a.agent_id === 'alpha')?.status).toBe('blocked');
  });

  it('survives rapid sequential mutations', async () => {
    await updateAgentRosterEntry(tempDir, 'alpha', { status: 'working', task: 100 });
    await updateAgentRosterEntry(tempDir, 'beta', { status: 'reviewing', task: 200 });
    await updateAgentRosterEntry(tempDir, 'alpha', { status: 'done', task: null, last_done: 100 });

    const final = await loadRoster(tempDir);
    expect(final.agents.find((a) => a.agent_id === 'alpha')?.status).toBe('done');
    expect(final.agents.find((a) => a.agent_id === 'alpha')?.last_done).toBe(100);
    expect(final.agents.find((a) => a.agent_id === 'beta')?.status).toBe('reviewing');
    expect(final.agents.find((a) => a.agent_id === 'beta')?.task).toBe(200);
  });

  it('lock is released after a failed mutation', async () => {
    const lockPath = join(tempDir, '.ai', 'agents', 'roster.lock');

    await expect(
      updateAgentRosterEntry(tempDir, 'ghost-agent', { status: 'working', task: 999 }),
    ).rejects.toThrow('not found in roster');

    // Lock file must not exist after the failed mutation
    expect(() => statSync(lockPath)).toThrow();

    // Subsequent mutation must succeed
    const result = await updateAgentRosterEntry(tempDir, 'alpha', { status: 'working', task: 999 });
    expect(result.agents.find((a) => a.agent_id === 'alpha')?.status).toBe('working');
  });
});

describe('findTaskFile', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'narada-find-task-file-test-'));
    mkdirSync(join(tempDir, '.ai', 'do-not-open', 'tasks'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('prefers an executable task file over a chapter range file with the same number', async () => {
    writeFileSync(
      join(tempDir, '.ai', 'do-not-open', 'tasks', '20260423-495-500-crossing-regime-first-class-chapter.md'),
      '---\nstatus: opened\n---\n\n# Crossing Regime First-Class Chapter\n',
    );
    writeFileSync(
      join(tempDir, '.ai', 'do-not-open', 'tasks', '20260423-495-crossing-regime-declaration-contract.md'),
      '---\nstatus: opened\n---\n\n# Task 495 - Crossing Regime Declaration Contract\n',
    );

    const result = await findTaskFile(tempDir, '495');
    expect(result?.taskId).toBe('20260423-495-crossing-regime-declaration-contract');
  });

  it('resolves chapter-edge tasks with em dash headings', async () => {
    writeFileSync(
      join(tempDir, '.ai', 'do-not-open', 'tasks', '20260425-724-726-chapter-commit-coherence.md'),
      '---\nstatus: opened\n---\n\n# Chapter Commit Coherence\n',
    );
    writeFileSync(
      join(tempDir, '.ai', 'do-not-open', 'tasks', '20260425-724-chapter-commit-coherence-1.md'),
      '---\nstatus: opened\n---\n\n# Task 724 — Close Residual Tasks\n',
    );
    writeFileSync(
      join(tempDir, '.ai', 'do-not-open', 'tasks', '20260425-726-chapter-commit-coherence-3.md'),
      '---\nstatus: opened\n---\n\n# Task 726 — Use Coherence Inspection\n',
    );

    const first = await findTaskFile(tempDir, '724');
    const last = await findTaskFile(tempDir, '726');

    expect(first?.taskId).toBe('20260425-724-chapter-commit-coherence-1');
    expect(last?.taskId).toBe('20260425-726-chapter-commit-coherence-3');
  });

  it('does not resolve numeric lookup to another task that merely mentions the number in its slug', async () => {
    writeFileSync(
      join(tempDir, '.ai', 'do-not-open', 'tasks', '20260517-1483-refresh-task-lifecycle-snapshot-after-chapter-closure.md'),
      '---\nstatus: opened\n---\n\n# Refresh task lifecycle snapshot after chapter closure\n',
    );
    writeFileSync(
      join(tempDir, '.ai', 'do-not-open', 'tasks', '20260517-1485-repair-missing-lifecycle-authority-row-for-task-1483.md'),
      '---\nstatus: claimed\n---\n\n# Repair missing lifecycle authority row for task 1483\n',
    );

    const result = await findTaskFile(tempDir, '1483');
    expect(result?.taskId).toBe('20260517-1483-refresh-task-lifecycle-snapshot-after-chapter-closure');
  });
});

describe('lintTaskFiles', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'narada-lint-test-'));
    mkdirSync(join(tempDir, '.ai', 'do-not-open', 'tasks'), { recursive: true });
    mkdirSync(join(tempDir, '.ai', 'reviews'), { recursive: true });
    mkdirSync(join(tempDir, '.ai', 'decisions'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeTask(taskNum: number, status: string, deps?: number[]) {
    const fm = [`---`, `status: ${status}`];
    if (deps) fm.push(`depends_on: [${deps.join(', ')}]`);
    fm.push(`---\n\n# Task ${taskNum}\n\nTest task.\n`);
    writeFileSync(
      join(tempDir, '.ai', 'do-not-open', 'tasks', `20260420-${taskNum}-test.md`),
      fm.join('\n'),
    );
  }

  async function writeStoredReview(name: string, reviewOf: number) {
    const store = openTaskLifecycleStore(tempDir);
    try {
      store.upsertLifecycle({
        task_id: `20260420-${reviewOf}-test`,
        task_number: reviewOf,
        status: 'in_review',
        governed_by: null,
        closed_at: null,
        closed_by: null,
        closure_mode: null,
        reopened_at: null,
        reopened_by: null,
        continuation_packet_json: null,
        updated_at: '2026-01-01T00:00:00Z',
      });
    } finally {
      store.db.close();
    }
    await saveReview(tempDir, {
      review_id: name,
      reviewer_agent_id: 'reviewer',
      task_id: `20260420-${reviewOf}-test`,
      findings: [],
      verdict: 'accepted',
      reviewed_at: '2026-01-01T00:00:00Z',
    });
  }

  function writeDecision(name: string, closesTasks: number[], body?: string) {
    const fm = ['---'];
    if (closesTasks.length > 0) fm.push(`closes_tasks: [${closesTasks.join(', ')}]`);
    fm.push(`---\n\n${body ?? '# Closure\n\nClosing tasks.'}\n`);
    writeFileSync(join(tempDir, '.ai', 'decisions', `${name}.md`), fm.join('\n'));
  }

  it('passes for clean task graph', async () => {
    writeTask(100, 'opened');
    writeTask(101, 'opened', [100]);
    const result = await lintTaskFiles(tempDir);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('detects orphan review for in_review task', async () => {
    writeTask(100, 'in_review');
    const result = await lintTaskFiles(tempDir);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.type === 'orphan_review')).toBe(true);
  });

  it('does not flag orphan review for opened task', async () => {
    writeTask(100, 'opened');
    const result = await lintTaskFiles(tempDir);
    expect(result.issues.some((i) => i.type === 'orphan_review')).toBe(false);
  });

  it('matches review to task via front matter', async () => {
    writeTask(100, 'in_review');
    await writeStoredReview('review-100', 100);
    const result = await lintTaskFiles(tempDir);
    expect(result.issues.some((i) => i.type === 'orphan_review')).toBe(false);
  });

  it('stores rejected reviews with the canonical rejected verdict', async () => {
    writeTask(100, 'in_review');
    const store = openTaskLifecycleStore(tempDir);
    try {
      store.upsertLifecycle({
        task_id: '20260420-100-test',
        task_number: 100,
        status: 'in_review',
        governed_by: null,
        closed_at: null,
        closed_by: null,
        closure_mode: null,
        reopened_at: null,
        reopened_by: null,
        continuation_packet_json: null,
        updated_at: '2026-01-01T00:00:00Z',
      });
    } finally {
      store.db.close();
    }

    await saveReview(tempDir, {
      review_id: 'review-rejected',
      reviewer_agent_id: 'reviewer',
      task_id: '20260420-100-test',
      findings: [],
      verdict: 'rejected',
      reviewed_at: '2026-01-01T00:00:00Z',
    });

    const verify = openTaskLifecycleStore(tempDir);
    try {
      expect(verify.listReviews('20260420-100-test')[0]?.verdict).toBe('rejected');
    } finally {
      verify.db.close();
    }
  });

  it('normalizes legacy needs_changes review rows to rejected on read', async () => {
    writeTask(100, 'in_review');
    const store = openTaskLifecycleStore(tempDir);
    try {
      store.upsertLifecycle({
        task_id: '20260420-100-test',
        task_number: 100,
        status: 'in_review',
        governed_by: null,
        closed_at: null,
        closed_by: null,
        closure_mode: null,
        reopened_at: null,
        reopened_by: null,
        continuation_packet_json: null,
        updated_at: '2026-01-01T00:00:00Z',
      });
      store.db
        .prepare(
          `insert into task_reviews (
            review_id, task_id, reviewer_agent_id, verdict, findings_json, reviewed_at
          ) values (?, ?, ?, ?, ?, ?)`,
        )
        .run('legacy-review', '20260420-100-test', 'reviewer', 'needs_changes', null, '2026-01-01T00:00:00Z');
    } finally {
      store.db.close();
    }

    const review = await loadReview(tempDir, 'legacy-review');
    expect(review?.verdict).toBe('rejected');
  });

  it('detects stale closure reference from front matter', async () => {
    writeTask(100, 'opened');
    writeDecision('closure-999', [999]);
    const result = await lintTaskFiles(tempDir);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.type === 'stale_closure_reference')).toBe(true);
  });

  it('detects orphan closure for closed task', async () => {
    writeTask(100, 'closed');
    const result = await lintTaskFiles(tempDir);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.type === 'orphan_closure')).toBe(true);
  });

  it('does not flag orphan closure for opened task', async () => {
    writeTask(100, 'opened');
    const result = await lintTaskFiles(tempDir);
    expect(result.issues.some((i) => i.type === 'orphan_closure')).toBe(false);
  });

  it('matches closure to task via front matter', async () => {
    writeTask(100, 'closed');
    writeDecision('closure-100', [100]);
    const result = await lintTaskFiles(tempDir);
    expect(result.issues.some((i) => i.type === 'orphan_closure')).toBe(false);
  });

  it('detects broken dependency', async () => {
    writeTask(100, 'opened', [999]);
    const result = await lintTaskFiles(tempDir);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.type === 'broken_dependency')).toBe(true);
  });

  it('detects malformed acceptance criteria fragments', async () => {
    writeFileSync(
      join(tempDir, '.ai', 'do-not-open', 'tasks', '20260420-101-fragmented.md'),
      `---\ntask_id: 101\nstatus: opened\n---\n\n# Task 101\n\n## Acceptance Criteria\n- [ ] Tests pass;Docs updated\n- [ ] lifecycle\n`,
    );

    const result = await lintTaskFiles(tempDir);

    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.type === 'malformed_acceptance_criteria' && i.detail.includes('semicolon'))).toBe(true);
    expect(result.issues.some((i) => i.type === 'malformed_acceptance_criteria' && i.detail.includes('fragmentary'))).toBe(true);
  });

  it('detects missing paths referenced from execution evidence', async () => {
    writeFileSync(
      join(tempDir, '.ai', 'do-not-open', 'tasks', '20260420-102-stale-evidence.md'),
      `---\ntask_id: 102\nstatus: opened\n---\n\n# Task 102\n\n## Acceptance Criteria\n- [ ] Keep evidence references valid\n\n## Verification\nChecked docs/no-longer-present.md.\n`,
    );

    const result = await lintTaskFiles(tempDir);

    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.type === 'missing_evidence_path' && i.detail.includes('docs/no-longer-present.md'))).toBe(true);
  });
});

describe('extractTaskRefsFromBody', () => {
  it('extracts task numbers from body text', () => {
    const body = 'This depends on Task 123 and task 456.';
    expect(extractTaskRefsFromBody(body)).toEqual([123, 456]);
  });

  it('returns empty array when no refs', () => {
    expect(extractTaskRefsFromBody('No tasks here.')).toEqual([]);
  });

  it('deduplicates repeated refs', () => {
    expect(extractTaskRefsFromBody('Task 100 and Task 100')).toEqual([100]);
  });
});

describe('parseFrontMatter', () => {
  it('parses inline array syntax', () => {
    const content = '---\ndepends_on: [998, 999]\n---\n\n# Task\n';
    const { frontMatter } = parseFrontMatter(content);
    expect(frontMatter.depends_on).toEqual([998, 999]);
  });

  it('parses YAML list syntax', () => {
    const content = `---\ndepends_on:\n  - 998\n  - 999\n---\n\n# Task\n`;
    const { frontMatter } = parseFrontMatter(content);
    expect(frontMatter.depends_on).toEqual([998, 999]);
  });

  it('parses nested object syntax', () => {
    const content = `---\ncontinuation_affinity:\n  preferred_agent_id: alpha\n  affinity_strength: 0.8\n---\n\n# Task\n`;
    const { frontMatter } = parseFrontMatter(content);
    expect(frontMatter.continuation_affinity).toEqual({
      preferred_agent_id: 'alpha',
      affinity_strength: 0.8,
    });
  });

  it('round-trips YAML list through serialize', () => {
    const content = `---\ndepends_on:\n  - 998\n  - 999\nstatus: opened\n---\n\n# Task\n`;
    const parsed = parseFrontMatter(content);
    expect(parsed.frontMatter.depends_on).toEqual([998, 999]);

    const serialized = serializeFrontMatter(parsed.frontMatter, parsed.body);
    const reparsed = parseFrontMatter(serialized);
    expect(reparsed.frontMatter.depends_on).toEqual([998, 999]);
    expect(reparsed.frontMatter.status).toBe('opened');
  });

  it('round-trips mixed front matter with lists, objects, and scalars', () => {
    const content = `---\nstatus: opened\ndepends_on:\n  - 100\n  - 101\ncontinuation_affinity:\n  preferred_agent_id: alpha\n  affinity_strength: 1\ntask_id: 999\n---\n\n# Task 999\n\nBody here.\n`;
    const parsed = parseFrontMatter(content);
    expect(parsed.frontMatter.status).toBe('opened');
    expect(parsed.frontMatter.depends_on).toEqual([100, 101]);
    expect(parsed.frontMatter.continuation_affinity).toEqual({
      preferred_agent_id: 'alpha',
      affinity_strength: 1,
    });
    expect(parsed.frontMatter.task_id).toBe(999);

    // Mutate status as claim would
    parsed.frontMatter.status = 'claimed';
    const serialized = serializeFrontMatter(parsed.frontMatter, parsed.body);
    const reparsed = parseFrontMatter(serialized);
    expect(reparsed.frontMatter.status).toBe('claimed');
    expect(reparsed.frontMatter.depends_on).toEqual([100, 101]);
    expect(reparsed.frontMatter.continuation_affinity).toEqual({
      preferred_agent_id: 'alpha',
      affinity_strength: 1,
    });
    expect(reparsed.frontMatter.task_id).toBe(999);
  });

  it('serializes with exactly one final newline and no blank EOF line', () => {
    const serialized = serializeFrontMatter(
      { status: 'opened' },
      '# Task 999\n\n## Acceptance Criteria\n\n- [x] Done.\n\n',
    );

    expect(serialized).toBe('---\nstatus: opened\n---\n\n# Task 999\n\n## Acceptance Criteria\n\n- [x] Done.\n');
    expect(serialized).not.toMatch(/\n\n$/);
    expect(serialized).toMatch(/[^\n]\n$/);
  });
});

describe('writeTaskFile front-matter preservation', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'narada-fm-preservation-test-'));
    mkdirSync(join(tempDir, '.ai', 'do-not-open', 'tasks'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('preserves depends_on YAML list through read/write cycle', async () => {
    const path = join(tempDir, '.ai', 'do-not-open', 'tasks', '20260420-999-test.md');
    const original = `---\nstatus: opened\ndepends_on:\n  - 998\n  - 997\nextra_field: preserved\n---\n\n# Task 999\n\nBody.\n`;
    writeFileSync(path, original);

    const { frontMatter, body } = await readTaskFile(path);
    expect(frontMatter.depends_on).toEqual([998, 997]);
    expect(frontMatter.extra_field).toBe('preserved');

    frontMatter.status = 'claimed';
    await writeTaskFile(path, frontMatter, body);

    const { frontMatter: fm2 } = await readTaskFile(path);
    expect(fm2.status).toBe('claimed');
    expect(fm2.depends_on).toEqual([998, 997]);
    expect(fm2.extra_field).toBe('preserved');
  });

  it('does not write a blank EOF line when body already ends with blank lines', async () => {
    const path = join(tempDir, '.ai', 'do-not-open', 'tasks', '20260420-999-test.md');

    await writeTaskFile(path, { status: 'closed' }, '# Task 999\n\n## Acceptance Criteria\n\n- [x] Done.\n\n');

    const written = readFileSync(path, 'utf8');
    expect(written).not.toMatch(/\n\n$/);
    expect(written).toMatch(/[^\n]\n$/);
  });
});

describe('createReportId', () => {
  it('produces deterministic report_id for same inputs', () => {
    const id1 = createReportId('task-1', 'agent-a', 'task-1-2026-01-01T00:00:00Z');
    const id2 = createReportId('task-1', 'agent-a', 'task-1-2026-01-01T00:00:00Z');
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^wrr_[a-f0-9]{8}_task-1_agent-a$/);
  });

  it('produces different ids for different assignments', () => {
    const id1 = createReportId('task-1', 'agent-a', 'task-1-2026-01-01T00:00:00Z');
    const id2 = createReportId('task-1', 'agent-a', 'task-1-2026-01-02T00:00:00Z');
    expect(id1).not.toBe(id2);
  });

  it('produces different ids for different agents', () => {
    const id1 = createReportId('task-1', 'agent-a', 'task-1-2026-01-01T00:00:00Z');
    const id2 = createReportId('task-1', 'agent-b', 'task-1-2026-01-01T00:00:00Z');
    expect(id1).not.toBe(id2);
  });
});

describe('findReportByAssignmentId', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'narada-report-find-test-'));
    mkdirSync(join(tempDir, '.ai', 'do-not-open', 'tasks', 'tasks', 'reports'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns existing report matching assignment_id', async () => {
    const report: WorkResultReport = {
      report_id: 'wrr_abc123_task-1_agent-a',
      task_number: '1',
      task_id: 'task-1',
      agent_id: 'agent-a',
      assignment_id: 'task-1-2026-01-01T00:00:00Z',
      reported_at: '2026-01-01T00:00:00Z',
      summary: 'Test',
      changed_files: [],
      verification: [],
      known_residuals: [],
      ready_for_review: true,
      report_status: 'submitted',
    };
    await saveReport(tempDir, report);

    const found = await findReportByAssignmentId(tempDir, 'task-1-2026-01-01T00:00:00Z');
    expect(found).not.toBeNull();
    expect(found!.report_id).toBe('wrr_abc123_task-1_agent-a');
  });

  it('returns null when no report matches assignment_id', async () => {
    const found = await findReportByAssignmentId(tempDir, 'nonexistent');
    expect(found).toBeNull();
  });

  it('ignores non-submitted reports', async () => {
    const report: WorkResultReport = {
      report_id: 'wrr_abc123_task-1_agent-a',
      task_number: '1',
      task_id: 'task-1',
      agent_id: 'agent-a',
      assignment_id: 'task-1-2026-01-01T00:00:00Z',
      reported_at: '2026-01-01T00:00:00Z',
      summary: 'Test',
      changed_files: [],
      verification: [],
      known_residuals: [],
      ready_for_review: true,
      report_status: 'superseded',
    };
    await saveReport(tempDir, report);

    const found = await findReportByAssignmentId(tempDir, 'task-1-2026-01-01T00:00:00Z');
    expect(found).toBeNull();
  });
});

describe('continuationReasonToIntent', () => {
  it('maps evidence_repair to repair', () => {
    expect(continuationReasonToIntent('evidence_repair')).toBe('repair');
  });

  it('maps review_fix to repair', () => {
    expect(continuationReasonToIntent('review_fix')).toBe('repair');
  });

  it('maps handoff to takeover', () => {
    expect(continuationReasonToIntent('handoff')).toBe('takeover');
  });

  it('maps blocked_agent to takeover', () => {
    expect(continuationReasonToIntent('blocked_agent')).toBe('takeover');
  });

  it('maps operator_override to takeover', () => {
    expect(continuationReasonToIntent('operator_override')).toBe('takeover');
  });

  it('defaults null to primary', () => {
    expect(continuationReasonToIntent(null)).toBe('primary');
  });
});

describe('getAssignmentIntent', () => {
  it('returns explicit intent when set', () => {
    const assignment: TaskAssignment = {
      agent_id: 'a1',
      claimed_at: '2026-01-01T00:00:00Z',
      claim_context: null,
      released_at: null,
      release_reason: null,
      intent: 'review',
      continuation_reason: 'handoff',
    };
    expect(getAssignmentIntent(assignment)).toBe('review');
  });

  it('infers from continuation_reason when intent is absent', () => {
    const assignment: TaskAssignment = {
      agent_id: 'a1',
      claimed_at: '2026-01-01T00:00:00Z',
      claim_context: null,
      released_at: null,
      release_reason: null,
      continuation_reason: 'evidence_repair',
    };
    expect(getAssignmentIntent(assignment)).toBe('repair');
  });

  it('defaults to primary when no intent or continuation_reason', () => {
    const assignment: TaskAssignment = {
      agent_id: 'a1',
      claimed_at: '2026-01-01T00:00:00Z',
      claim_context: null,
      released_at: null,
      release_reason: null,
    };
    expect(getAssignmentIntent(assignment)).toBe('primary');
  });
});

describe('detectReportAnomalies', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'narada-report-anomalies-test-'));
    mkdirSync(join(tempDir, '.ai', 'do-not-open', 'tasks', 'tasks', 'reports'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns empty array for clean reports', async () => {
    const report: WorkResultReport = {
      report_id: 'wrr_abc123_task-1_agent-a',
      task_number: '1',
      task_id: 'task-1',
      agent_id: 'agent-a',
      assignment_id: 'task-1-2026-01-01T00:00:00Z',
      reported_at: '2026-01-01T00:00:00Z',
      summary: 'Test',
      changed_files: [],
      verification: [],
      known_residuals: [],
      ready_for_review: true,
      report_status: 'submitted',
    };
    await saveReport(tempDir, report);

    const anomalies = await detectReportAnomalies(tempDir);
    expect(anomalies).toHaveLength(0);
  });

  it('detects multiple reports per assignment', async () => {
    const report1: WorkResultReport = {
      report_id: 'wrr_aaa_task-1_agent-a',
      task_number: '1',
      task_id: 'task-1',
      agent_id: 'agent-a',
      assignment_id: 'task-1-2026-01-01T00:00:00Z',
      reported_at: '2026-01-01T00:00:00Z',
      summary: 'First',
      changed_files: [],
      verification: [],
      known_residuals: [],
      ready_for_review: true,
      report_status: 'submitted',
    };
    const report2: WorkResultReport = {
      report_id: 'wrr_bbb_task-1_agent-a',
      task_number: '1',
      task_id: 'task-1',
      agent_id: 'agent-a',
      assignment_id: 'task-1-2026-01-01T00:00:00Z',
      reported_at: '2026-01-02T00:00:00Z',
      summary: 'Second',
      changed_files: [],
      verification: [],
      known_residuals: [],
      ready_for_review: true,
      report_status: 'submitted',
    };
    await saveReport(tempDir, report1);
    await saveReport(tempDir, report2);

    const anomalies = await detectReportAnomalies(tempDir);
    expect(anomalies.some((a) => a.type === 'multiple_reports_per_assignment')).toBe(true);
  });

});

describe('resolveTaskStatus', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'narada-resolve-status-test-'));
    mkdirSync(join(tempDir, '.ai', 'do-not-open', 'tasks'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns markdown status when no store is provided', async () => {
    writeFileSync(
      join(tempDir, '.ai', 'do-not-open', 'tasks', '20260420-260-test.md'),
      '---\nstatus: closed\n---\n\n# Test\n',
    );

    const result = await resolveTaskStatus(tempDir, 260);
    expect(result.status).toBe('closed');
    expect(result.source).toBe('markdown');
  });

  it('prefers SQLite status when store has the task', async () => {
    writeFileSync(
      join(tempDir, '.ai', 'do-not-open', 'tasks', '20260420-260-test.md'),
      '---\nstatus: opened\n---\n\n# Test\n',
    );

    const store = openTaskLifecycleStore(tempDir);
    store.upsertLifecycle({
      task_id: '20260420-260-test',
      task_number: 260,
      status: 'confirmed',
      governed_by: null,
      closed_at: null,
      closed_by: null,
      reopened_at: null,
      reopened_by: null,
      continuation_packet_json: null,
      created_at: '2026-04-20T00:00:00Z',
      updated_at: '2026-04-20T00:00:00Z',
    });

    const result = await resolveTaskStatus(tempDir, 260, store);
    expect(result.status).toBe('confirmed');
    expect(result.source).toBe('sqlite');

    store.db.close();
  });

  it('falls back to markdown when store has no record', async () => {
    writeFileSync(
      join(tempDir, '.ai', 'do-not-open', 'tasks', '20260420-260-test.md'),
      '---\nstatus: in_review\n---\n\n# Test\n',
    );

    const store = openTaskLifecycleStore(tempDir);
    // No lifecycle row inserted for task 260

    const result = await resolveTaskStatus(tempDir, 260, store);
    expect(result.status).toBe('in_review');
    expect(result.source).toBe('markdown');

    store.db.close();
  });

  it('returns undefined when task file is missing', async () => {
    const store = openTaskLifecycleStore(tempDir);

    const result = await resolveTaskStatus(tempDir, 999, store);
    expect(result.status).toBeUndefined();
    expect(result.source).toBe('markdown');

    store.db.close();
  });
});

describe('checkDependencies', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'narada-check-deps-test-'));
    mkdirSync(join(tempDir, '.ai', 'do-not-open', 'tasks'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('allows dependencies that are closed with complete evidence', async () => {
    writeFileSync(
      join(tempDir, '.ai', 'do-not-open', 'tasks', '20260420-998-dep.md'),
      '---\nstatus: closed\nclosed_by: operator\nclosed_at: 2026-04-20T00:00:00Z\n---\n\n# Task 998: Dep\n\n## Acceptance Criteria\n\n- [x] Done\n\n## Execution Notes\n\nDone.\n\n## Verification\n\nVerified.\n',
    );

    const result = await checkDependencies(tempDir, [998]);
    expect(result.blockedBy).toEqual([]);
    expect(result.details).toEqual([]);
  });

  it('allows pre-invariant closed dependencies with checked criteria and material evidence but no governed provenance', async () => {
    writeFileSync(
      join(tempDir, '.ai', 'do-not-open', 'tasks', '20260420-400-legacy-dep.md'),
      '---\nstatus: closed\n---\n\n# Task 400: Legacy Dep\n\n## Acceptance Criteria\n\n- [x] Done\n\n## Execution Notes\n\nDelivered before governed closure provenance was required.\n\n## Verification\n\nVerified before governed closure provenance was required.\n',
    );

    const result = await checkDependencies(tempDir, [400]);
    expect(result.blockedBy).toEqual([]);
    expect(result.details).toEqual([]);
  });

  it('allows pre-invariant closed dependencies with verification-only evidence', async () => {
    writeFileSync(
      join(tempDir, '.ai', 'do-not-open', 'tasks', '20260420-416-legacy-verification-only.md'),
      '---\nstatus: closed\n---\n\n# Task 416: Legacy Verification Only\n\n## Acceptance Criteria\n\n- [x] Done\n\n## Verification\n\nVerified before execution notes were required.\n',
    );

    const result = await checkDependencies(tempDir, [416]);
    expect(result.blockedBy).toEqual([]);
    expect(result.details).toEqual([]);
  });

  it('still blocks modern closed dependencies without governed provenance', async () => {
    writeFileSync(
      join(tempDir, '.ai', 'do-not-open', 'tasks', '20260420-998-modern-dep.md'),
      '---\nstatus: closed\n---\n\n# Task 998: Modern Dep\n\n## Acceptance Criteria\n\n- [x] Done\n\n## Execution Notes\n\nDone.\n\n## Verification\n\nVerified.\n',
    );

    const result = await checkDependencies(tempDir, [998]);
    expect(result.blockedBy).toContain('20260420-998-modern-dep');
    expect(result.details[0]!.reason).toContain('not complete by evidence');
  });

  it('allows modern closed dependencies when SQLite carries governed closure and report evidence', async () => {
    writeFileSync(
      join(tempDir, '.ai', 'do-not-open', 'tasks', '20260420-998-modern-sqlite-dep.md'),
      '---\nstatus: opened\n---\n\n# Task 998: Modern SQLite Dep\n\n## Acceptance Criteria\n\n- [x] Done\n',
    );

    const store = openTaskLifecycleStore(tempDir);
    store.upsertLifecycle({
      task_id: '20260420-998-modern-sqlite-dep',
      task_number: 998,
      status: 'closed',
      governed_by: 'task_close:a2',
      closed_at: '2026-04-20T00:00:00Z',
      closed_by: 'a2',
      reopened_at: null,
      reopened_by: null,
      continuation_packet_json: null,
      created_at: '2026-04-20T00:00:00Z',
      updated_at: '2026-04-20T00:00:00Z',
    });
    store.insertReport({
      report_id: 'wrr_998_builder',
      task_id: '20260420-998-modern-sqlite-dep',
      agent_id: 'builder',
      summary: 'Done.',
      changed_files_json: '[]',
      verification_json: '[{"command":"pnpm verify","result":"passed"}]',
      submitted_at: '2026-04-20T00:00:00Z',
    });

    const result = await checkDependencies(tempDir, [998], store);
    expect(result.blockedBy).toEqual([]);
    expect(result.details).toEqual([]);

    store.db.close();
  });

  it('blocks dependencies that are not terminal by SQLite status', async () => {
    writeFileSync(
      join(tempDir, '.ai', 'do-not-open', 'tasks', '20260420-998-dep.md'),
      '---\nstatus: opened\n---\n\n# Task 998: Dep\n',
    );

    const store = openTaskLifecycleStore(tempDir);
    // Override markdown status: SQLite says opened, markdown says closed
    store.upsertLifecycle({
      task_id: '20260420-998-dep',
      task_number: 998,
      status: 'opened',
      governed_by: null,
      closed_at: null,
      closed_by: null,
      reopened_at: null,
      reopened_by: null,
      continuation_packet_json: null,
      created_at: '2026-04-20T00:00:00Z',
      updated_at: '2026-04-20T00:00:00Z',
    });

    const result = await checkDependencies(tempDir, [998], store);
    expect(result.blockedBy).toContain('20260420-998-dep');
    expect(result.details[0]!.reason).toContain('not in a terminal status');

    store.db.close();
  });

  it('explains dependencies that are explicitly deferred in SQLite', async () => {
    writeFileSync(
      join(tempDir, '.ai', 'do-not-open', 'tasks', '20260420-998-dep.md'),
      '---\nstatus: opened\n---\n\n# Task 998: Dep\n',
    );

    const store = openTaskLifecycleStore(tempDir);
    store.upsertLifecycle({
      task_id: '20260420-998-dep',
      task_number: 998,
      status: 'deferred',
      governed_by: null,
      closed_at: null,
      closed_by: null,
      reopened_at: null,
      reopened_by: null,
      continuation_packet_json: JSON.stringify({
        kind: 'task_defer',
        unblock_condition: 'Bind real Graph source',
      }),
      created_at: '2026-04-20T00:00:00Z',
      updated_at: '2026-04-20T00:00:00Z',
    });

    const result = await checkDependencies(tempDir, [998], store);
    expect(result.blockedBy).toContain('20260420-998-dep');
    expect(result.details[0]!.reason).toContain('Dependency is deferred');

    store.db.close();
  });

  it('allows dependencies that are confirmed in SQLite even when markdown says opened', async () => {
    writeFileSync(
      join(tempDir, '.ai', 'do-not-open', 'tasks', '20260420-998-dep.md'),
      '---\nstatus: opened\ngoverned_by: operator\n---\n\n# Task 998: Dep\n\n## Acceptance Criteria\n\n- [x] Done\n\n## Execution Notes\n\nDone.\n\n## Verification\n\nVerified.\n',
    );

    const store = openTaskLifecycleStore(tempDir);
    store.upsertLifecycle({
      task_id: '20260420-998-dep',
      task_number: 998,
      status: 'confirmed',
      governed_by: null,
      closed_at: null,
      closed_by: null,
      reopened_at: null,
      reopened_by: null,
      continuation_packet_json: null,
      created_at: '2026-04-20T00:00:00Z',
      updated_at: '2026-04-20T00:00:00Z',
    });

    const result = await checkDependencies(tempDir, [998], store);
    expect(result.blockedBy).toEqual([]);
    expect(result.details).toEqual([]);

    store.db.close();
  });
});
