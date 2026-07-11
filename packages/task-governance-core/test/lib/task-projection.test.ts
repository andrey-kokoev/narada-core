import { vi } from 'vitest';

vi.unmock('node:fs');
vi.unmock('node:fs/promises');

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from '../../src/sqlite-database.js';
import {
  SqliteTaskLifecycleStore,
  type TaskLifecycleRow,
} from '../../src/task-lifecycle-store.js';
import {
  inspectTaskEvidenceWithProjection,
  listRunnableTasksWithProjection,
  openTaskLifecycleStore,
} from '../../src/task-projection.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function setupRepo(tempDir: string) {
  mkdirSync(join(tempDir, '.ai', 'do-not-open', 'tasks'), { recursive: true });
  mkdirSync(join(tempDir, '.ai', 'do-not-open', 'tasks', 'tasks', 'reports'), { recursive: true });
  mkdirSync(join(tempDir, '.ai', 'reviews'), { recursive: true });
}

function createTask(
  tempDir: string,
  num: number,
  status: string,
  bodyExtra = '',
) {
  writeFileSync(
    join(tempDir, '.ai', 'do-not-open', 'tasks', `20260420-${num}-test.md`),
    `---\ntask_id: ${num}\nstatus: ${status}\n---\n\n# Task ${num}: Test\n\n## Acceptance Criteria\n- [ ] Do thing A\n- [x] Do thing B\n\n${bodyExtra}`,
  );
}

describe('task projection layer', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'narada-task-projection-test-'));
    setupRepo(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns null when SQLite DB does not exist', async () => {
    createTask(tempDir, 100, 'opened');
    const result = await inspectTaskEvidenceWithProjection(tempDir, '100');
    expect(result).toBeNull();
  });

  it('returns null when task is not in SQLite store', async () => {
    createTask(tempDir, 101, 'opened');
    const db = new Database(':memory:');
    const store = new SqliteTaskLifecycleStore({ db });
    store.initSchema();
    // Do NOT insert task 101

    const result = await inspectTaskEvidenceWithProjection(tempDir, '101');
    expect(result).toBeNull();
    db.close();
  });

  it('returns merged evidence when task is in SQLite', async () => {
    createTask(tempDir, 102, 'opened', '## Execution Notes\nDid the work.\n');

    const db = new Database(':memory:');
    const store = new SqliteTaskLifecycleStore({ db });
    store.initSchema();

    const row: TaskLifecycleRow = {
      task_id: '20260420-102-test',
      task_number: 102,
      status: 'claimed',
      governed_by: null,
      closed_at: null,
      closed_by: null,
      reopened_at: null,
      reopened_by: null,
      continuation_packet_json: null,
      updated_at: new Date().toISOString(),
    };
    store.upsertLifecycle(row);

    const result = await inspectTaskEvidenceWithProjection(tempDir, '102', store);
    expect(result).not.toBeNull();
    expect(result!.status).toBe('claimed');
    expect(result!.task_number).toBe(102);
    expect(result!.task_id).toBe('20260420-102-test');
    expect(result!.has_execution_notes).toBe(true);
    expect(result!.unchecked_count).toBe(1);
    db.close();
  });

  it('does not count placeholder comments as material notes or verification', async () => {
    createTask(
      tempDir,
      107,
      'closed',
      '## Execution Notes\n<!-- Record what was done. -->\n\n## Verification\n<!-- Record verification. -->\n',
    );

    const db = new Database(':memory:');
    const store = new SqliteTaskLifecycleStore({ db });
    store.initSchema();
    store.upsertLifecycle({
      task_id: '20260420-107-test',
      task_number: 107,
      status: 'closed',
      governed_by: 'task_close:agent-a',
      closed_at: new Date().toISOString(),
      closed_by: 'agent-a',
      reopened_at: null,
      reopened_by: null,
      continuation_packet_json: null,
      updated_at: new Date().toISOString(),
    });

    const result = await inspectTaskEvidenceWithProjection(tempDir, '107', store);
    expect(result).not.toBeNull();
    expect(result!.has_execution_notes).toBe(false);
    expect(result!.has_verification).toBe(false);
    expect(result!.violations).toContain('terminal_without_execution_notes');
    expect(result!.violations).toContain('terminal_without_verification');
    db.close();
  });

  it('counts WorkResultReport verification as verification evidence', async () => {
    createTask(tempDir, 108, 'closed', '## Execution Notes\nDone.\n\n## Verification\n<!-- placeholder only -->\n');

    const db = new Database(':memory:');
    const store = new SqliteTaskLifecycleStore({ db });
    store.initSchema();
    store.upsertLifecycle({
      task_id: '20260420-108-test',
      task_number: 108,
      status: 'closed',
      governed_by: 'task_close:agent-a',
      closed_at: new Date().toISOString(),
      closed_by: 'agent-a',
      reopened_at: null,
      reopened_by: null,
      continuation_packet_json: null,
      updated_at: new Date().toISOString(),
    });
    store.insertReport({
      report_id: 'report-108',
      task_id: '20260420-108-test',
      agent_id: 'agent-a',
      summary: 'Done',
      changed_files_json: JSON.stringify([]),
      verification_json: JSON.stringify([{ command: 'pnpm verify', result: 'passed' }]),
      submitted_at: new Date().toISOString(),
    });

    const result = await inspectTaskEvidenceWithProjection(tempDir, '108', store);
    expect(result).not.toBeNull();
    expect(result!.has_verification).toBe(true);
    expect(result!.violations).not.toContain('terminal_without_verification');
    db.close();
  });

  it('uses SQLite status over markdown frontmatter status', async () => {
    // Markdown says 'opened', SQLite says 'closed'
    writeFileSync(
      join(tempDir, '.ai', 'do-not-open', 'tasks', '20260420-103-test.md'),
      `---\ntask_id: 103\nstatus: opened\n---\n\n# Task 103: Test\n\n## Acceptance Criteria\n- [x] Do thing A\n- [x] Do thing B\n\n## Execution Notes\nDone.\n\n## Verification\nOK.\n`,
    );

    const db = new Database(':memory:');
    const store = new SqliteTaskLifecycleStore({ db });
    store.initSchema();

    const row: TaskLifecycleRow = {
      task_id: '20260420-103-test',
      task_number: 103,
      status: 'closed',
      governed_by: 'operator',
      closed_at: new Date().toISOString(),
      closed_by: 'operator',
      reopened_at: null,
      reopened_by: null,
      continuation_packet_json: null,
      updated_at: new Date().toISOString(),
    };
    store.upsertLifecycle(row);

    const result = await inspectTaskEvidenceWithProjection(tempDir, '103', store);
    expect(result).not.toBeNull();
    // SQLite status wins
    expect(result!.status).toBe('closed');
    // All criteria checked, has evidence, has governed provenance → complete
    expect(result!.warnings).toEqual([]);
    expect(result!.violations).toEqual([]);
    expect(result!.verdict).toBe('complete');
    // Closure detected from SQLite
    expect(result!.has_closure).toBe(true);
    db.close();
  });

  it('uses reports from SQLite', async () => {
    createTask(tempDir, 104, 'opened');

    const db = new Database(':memory:');
    const store = new SqliteTaskLifecycleStore({ db });
    store.initSchema();

    const row: TaskLifecycleRow = {
      task_id: '20260420-104-test',
      task_number: 104,
      status: 'opened',
      governed_by: null,
      closed_at: null,
      closed_by: null,
      reopened_at: null,
      reopened_by: null,
      continuation_packet_json: null,
      updated_at: new Date().toISOString(),
    };
    store.upsertLifecycle(row);

    store.insertReport({
      report_id: 'report-1',
      task_id: '20260420-104-test',
      agent_id: 'agent-a',
      summary: 'Done',
      changed_files_json: null,
      verification_json: null,
      submitted_at: new Date().toISOString(),
    });

    const result = await inspectTaskEvidenceWithProjection(tempDir, '104', store);
    expect(result).not.toBeNull();
    expect(result!.has_report).toBe(true);
    db.close();
  });

  it('uses reviews from SQLite', async () => {
    createTask(tempDir, 105, 'in_review', '## Execution Notes\nDone.\n');

    const db = new Database(':memory:');
    const store = new SqliteTaskLifecycleStore({ db });
    store.initSchema();

    const row: TaskLifecycleRow = {
      task_id: '20260420-105-test',
      task_number: 105,
      status: 'in_review',
      governed_by: null,
      closed_at: null,
      closed_by: null,
      reopened_at: null,
      reopened_by: null,
      continuation_packet_json: null,
      updated_at: new Date().toISOString(),
    };
    store.upsertLifecycle(row);

    store.insertReview({
      review_id: 'review-1',
      task_id: '20260420-105-test',
      reviewer_agent_id: 'reviewer-a',
      verdict: 'accepted',
      findings_json: null,
      reviewed_at: new Date().toISOString(),
    });

    const result = await inspectTaskEvidenceWithProjection(tempDir, '105', store);
    expect(result).not.toBeNull();
    expect(result!.has_review).toBe(true);
    // Criteria not all checked (one unchecked), so incomplete despite accepted review
    expect(result!.verdict).toBe('incomplete');
    db.close();
  });

  it('uses satisfied review dependency outcomes as review evidence', async () => {
    writeFileSync(
      join(tempDir, '.ai', 'do-not-open', 'tasks', '20260420-109-test.md'),
      `---\ntask_id: 109\nstatus: in_review\n---\n\n# Task 109: Test\n\n## Acceptance Criteria\n- [x] Do thing A\n- [x] Do thing B\n\n## Execution Notes\nDone.\n\n## Verification\nOK.\n`,
    );

    const db = new Database(':memory:');
    const store = new SqliteTaskLifecycleStore({ db });
    store.initSchema();

    store.upsertLifecycle({
      task_id: '20260420-109-test',
      task_number: 109,
      status: 'in_review',
      governed_by: null,
      closed_at: null,
      closed_by: null,
      reopened_at: null,
      reopened_by: null,
      continuation_packet_json: null,
      updated_at: new Date().toISOString(),
    });
    store.upsertLifecycle({
      task_id: '20260420-110-review-test',
      task_number: 110,
      status: 'closed',
      governed_by: 'review',
      closed_at: new Date().toISOString(),
      closed_by: 'reviewer-a',
      closure_mode: 'peer_reviewed',
      reopened_at: null,
      reopened_by: null,
      continuation_packet_json: null,
      updated_at: new Date().toISOString(),
    });
    store.upsertTaskDependency({
      dependency_id: 'dep-review-109-110',
      parent_task_id: '20260420-109-test',
      required_task_id: '20260420-110-review-test',
      kind: 'review',
      satisfying_outcomes_json: JSON.stringify(['accepted', 'accepted_with_notes']),
      status: 'open',
      created_by: 'agent-a',
      created_at: new Date().toISOString(),
    });
    store.upsertTaskOutcomeContract({
      contract_id: 'contract-review-110',
      task_id: '20260420-110-review-test',
      outcome_type: 'review',
      allowed_outcomes_json: JSON.stringify(['accepted', 'accepted_with_notes', 'rejected']),
      satisfying_outcomes_json: JSON.stringify(['accepted', 'accepted_with_notes']),
      blocking_outcomes_json: JSON.stringify(['rejected']),
      required_fields_json: JSON.stringify(['summary']),
      capability_requirement: 'review',
      created_by: 'agent-a',
      created_at: new Date().toISOString(),
    });
    store.insertTaskOutcome({
      outcome_id: 'outcome-review-110',
      task_id: '20260420-110-review-test',
      contract_id: 'contract-review-110',
      agent_id: 'reviewer-a',
      outcome: 'accepted',
      summary: 'Accepted by dependency outcome.',
      findings_json: JSON.stringify([]),
      evidence_refs_json: JSON.stringify([]),
      admitted_at: new Date().toISOString(),
    });
    expect(store.listReviews('20260420-109-test')).toEqual([]);

    const result = await inspectTaskEvidenceWithProjection(tempDir, '109', store);
    expect(result).not.toBeNull();
    expect(result!.has_review).toBe(true);
    expect(result!.verdict).toBe('needs_closure');
    db.close();
  });

  it('uses active assignment from SQLite', async () => {
    createTask(tempDir, 106, 'claimed');

    const db = new Database(':memory:');
    const store = new SqliteTaskLifecycleStore({ db });
    store.initSchema();

    const row: TaskLifecycleRow = {
      task_id: '20260420-106-test',
      task_number: 106,
      status: 'claimed',
      governed_by: null,
      closed_at: null,
      closed_by: null,
      reopened_at: null,
      reopened_by: null,
      continuation_packet_json: null,
      updated_at: new Date().toISOString(),
    };
    store.upsertLifecycle(row);

    store.insertAssignment({
      assignment_id: 'assign-1',
      task_id: '20260420-106-test',
      agent_id: 'agent-a',
      claimed_at: new Date().toISOString(),
      released_at: null,
      release_reason: null,
      intent: 'primary',
    });

    const result = await inspectTaskEvidenceWithProjection(tempDir, '106', store);
    expect(result).not.toBeNull();
    expect(result!.active_assignment_intent).toBe('primary');
    db.close();
  });

  it('openTaskLifecycleStore returns null when DB does not exist', async () => {
    const store = await openTaskLifecycleStore(tempDir);
    expect(store).toBeNull();
  });

  describe('listRunnableTasksWithProjection', () => {
    it('returns null when SQLite DB does not exist', async () => {
      createTask(tempDir, 200, 'opened');
      const result = await listRunnableTasksWithProjection(tempDir);
      expect(result).toBeNull();
    });

    it('returns runnable tasks from SQLite with markdown title/affinity', async () => {
      writeFileSync(
        join(tempDir, '.ai', 'do-not-open', 'tasks', '20260420-201-test.md'),
        `---\ntask_id: 201\nstatus: opened\ncontinuation_affinity:\n  preferred_agent_id: agent-a\n  affinity_strength: 2\n---\n\n# Task 201: SQLite Backed\n`,
      );
      writeFileSync(
        join(tempDir, '.ai', 'do-not-open', 'tasks', '20260420-202-test.md'),
        `---\ntask_id: 202\nstatus: opened\n---\n\n# Task 202: Markdown Only\n`,
      );

      const db = new Database(':memory:');
      const store = new SqliteTaskLifecycleStore({ db });
      store.initSchema();

      // Only task 201 is in SQLite
      store.upsertLifecycle({
        task_id: '20260420-201-test',
        task_number: 201,
        status: 'claimed',
        governed_by: null,
        closed_at: null,
        closed_by: null,
        reopened_at: null,
        reopened_by: null,
        continuation_packet_json: null,
        updated_at: new Date().toISOString(),
      });

      const result = await listRunnableTasksWithProjection(tempDir, store);
      expect(result).not.toBeNull();
      expect(result!).toHaveLength(2);

      // Task 201 from SQLite: status is authoritative (claimed), title/affinity from markdown
      const t201 = result!.find((t) => t.taskNumber === 201);
      expect(t201).toBeDefined();
      expect(t201!.status).toBe('claimed');
      expect(t201!.title).toBe('Task 201: SQLite Backed');
      expect(t201!.affinity.preferred_agent_id).toBe('agent-a');
      expect(t201!.affinity.affinity_strength).toBe(2);

      // Task 202 from markdown only
      const t202 = result!.find((t) => t.taskNumber === 202);
      expect(t202).toBeDefined();
      expect(t202!.status).toBe('opened');
      expect(t202!.title).toBe('Task 202: Markdown Only');

      db.close();
    });

    it('SQLite closed status excludes task even if markdown says opened', async () => {
      writeFileSync(
        join(tempDir, '.ai', 'do-not-open', 'tasks', '20260420-203-test.md'),
        `---\ntask_id: 203\nstatus: opened\n---\n\n# Task 203: Ambiguous\n`,
      );

      const db = new Database(':memory:');
      const store = new SqliteTaskLifecycleStore({ db });
      store.initSchema();

      store.upsertLifecycle({
        task_id: '20260420-203-test',
        task_number: 203,
        status: 'closed',
        governed_by: 'operator',
        closed_at: new Date().toISOString(),
        closed_by: 'operator',
        reopened_at: null,
        reopened_by: null,
        continuation_packet_json: null,
        updated_at: new Date().toISOString(),
      });

      const result = await listRunnableTasksWithProjection(tempDir, store);
      expect(result).not.toBeNull();
      expect(result!).toHaveLength(0);

      db.close();
    });

    it('SQLite opened status includes task even if markdown says closed', async () => {
      writeFileSync(
        join(tempDir, '.ai', 'do-not-open', 'tasks', '20260420-204-test.md'),
        `---\ntask_id: 204\nstatus: closed\n---\n\n# Task 204: Reopened\n`,
      );

      const db = new Database(':memory:');
      const store = new SqliteTaskLifecycleStore({ db });
      store.initSchema();

      store.upsertLifecycle({
        task_id: '20260420-204-test',
        task_number: 204,
        status: 'opened',
        governed_by: null,
        closed_at: null,
        closed_by: null,
        reopened_at: null,
        reopened_by: null,
        continuation_packet_json: null,
        updated_at: new Date().toISOString(),
      });

      const result = await listRunnableTasksWithProjection(tempDir, store);
      expect(result).not.toBeNull();
      expect(result!).toHaveLength(1);
      expect(result![0].taskNumber).toBe(204);
      expect(result![0].status).toBe('opened');

      db.close();
    });

    it('sorts by affinity strength descending', async () => {
      writeFileSync(
        join(tempDir, '.ai', 'do-not-open', 'tasks', '20260420-205-test.md'),
        `---\ntask_id: 205\nstatus: opened\ncontinuation_affinity:\n  preferred_agent_id: agent-a\n  affinity_strength: 3\n---\n\n# Task 205\n`,
      );
      writeFileSync(
        join(tempDir, '.ai', 'do-not-open', 'tasks', '20260420-206-test.md'),
        `---\ntask_id: 206\nstatus: opened\ncontinuation_affinity:\n  preferred_agent_id: agent-b\n  affinity_strength: 1\n---\n\n# Task 206\n`,
      );
      writeFileSync(
        join(tempDir, '.ai', 'do-not-open', 'tasks', '20260420-207-test.md'),
        `---\ntask_id: 207\nstatus: opened\n---\n\n# Task 207\n`,
      );

      const db = new Database(':memory:');
      const store = new SqliteTaskLifecycleStore({ db });
      store.initSchema();

      for (const num of [205, 206, 207]) {
        store.upsertLifecycle({
          task_id: `20260420-${num}-test`,
          task_number: num,
          status: 'opened',
          governed_by: null,
          closed_at: null,
          closed_by: null,
          reopened_at: null,
          reopened_by: null,
          continuation_packet_json: null,
          updated_at: new Date().toISOString(),
        });
      }

      const result = await listRunnableTasksWithProjection(tempDir, store);
      expect(result).not.toBeNull();
      expect(result!).toHaveLength(3);
      expect(result![0].taskNumber).toBe(205);
      expect(result![0].affinity.affinity_strength).toBe(3);
      expect(result![1].taskNumber).toBe(206);
      expect(result![1].affinity.affinity_strength).toBe(1);
      expect(result![2].taskNumber).toBe(207);
      expect(result![2].affinity.affinity_strength).toBe(0);

      db.close();
    });
  });
});
