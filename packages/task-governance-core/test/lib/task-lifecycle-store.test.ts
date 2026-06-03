import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from '../../src/sqlite-database.js';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  openTaskLifecycleStore,
  SqliteTaskLifecycleStore,
  TASK_LIFECYCLE_BUSY_TIMEOUT_MS,
  TASK_LIFECYCLE_SYNCHRONOUS_MODE,
  type TaskLifecycleRow,
  type TaskAssignmentRow,
  type AssignmentIntentRow,
  type EvidenceAdmissionResultRow,
  type EvidenceBundleRow,
  type ObservationArtifactRow,
  type ReconciliationFindingRow,
  type TaskReportRow,
  type TaskReviewRow,
} from '../../src/task-lifecycle-store.js';
import { SQLITE_BACKEND_ENV } from '../../src/sqlite-runtime.js';

describe('SqliteTaskLifecycleStore', () => {
  let db: Database;
  let store: SqliteTaskLifecycleStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new SqliteTaskLifecycleStore({ db });
    store.initSchema();
  });

  afterEach(() => {
    db.close();
  });

  describe('schema initialization', () => {
    it('creates all required tables', () => {
      const tables = db
        .prepare("select name from sqlite_master where type = 'table'")
        .pluck()
        .all() as string[];
      expect(tables).toContain('task_lifecycle');
      expect(tables).toContain('task_assignments');
      expect(tables).toContain('assignment_intents');
      expect(tables).toContain('evidence_bundles');
      expect(tables).toContain('evidence_admission_results');
      expect(tables).toContain('observation_artifacts');
      expect(tables).toContain('reconciliation_findings');
      expect(tables).toContain('reconciliation_repairs');
      expect(tables).toContain('task_reports');
      expect(tables).toContain('task_reviews');
      expect(tables).toContain('task_number_sequence');
      expect(tables).toContain('verification_runs');
      expect(tables).toContain('command_runs');
      expect(tables).toContain('repo_publications');
      expect(tables).toContain('agent_roster');
      expect(tables).toContain('directed_obligations');
    });

    it('initializes task_number_sequence with singleton row', () => {
      const row = db
        .prepare('select last_allocated from task_number_sequence where singleton = 1')
        .get() as { last_allocated: number };
      expect(row.last_allocated).toBe(0);
    });

    it('is idempotent', () => {
      store.initSchema();
      store.initSchema();
      const tables = db
        .prepare("select name from sqlite_master where type = 'table'")
        .pluck()
        .all() as string[];
      expect(tables.filter((t) => t === 'task_lifecycle').length).toBe(1);
    });
  });

  describe('connection posture', () => {
    let tempDir: string | null = null;

    afterEach(async () => {
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true });
        tempDir = null;
      }
    });

    it('opens file-backed lifecycle stores with command-safe SQLite pragmas', async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'narada-lifecycle-store-'));
      await mkdir(join(tempDir, '.ai'), { recursive: true });

      const opened = openTaskLifecycleStore(tempDir);
      try {
        const busyTimeout = opened.db.pragma('busy_timeout', { simple: true });
        const journalMode = opened.db.pragma('journal_mode', { simple: true });
        const synchronous = opened.db.pragma('synchronous', { simple: true });

        expect(busyTimeout).toBe(TASK_LIFECYCLE_BUSY_TIMEOUT_MS);
        expect(String(journalMode).toLowerCase()).toBe('wal');
        expect(synchronous).toBe(1);
        expect(TASK_LIFECYCLE_SYNCHRONOUS_MODE).toBe('normal');
      } finally {
        opened.db.close();
      }
    });

    it('upgrades an existing file-backed store when newer tables are missing', async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'narada-lifecycle-store-upgrade-'));
      await mkdir(join(tempDir, '.ai'), { recursive: true });
      const dbPath = join(tempDir, '.ai', 'task-lifecycle.db');
      const oldDb = new Database(dbPath);
      try {
        oldDb.exec(`
          create table task_lifecycle (
            task_id text primary key,
            task_number integer not null unique,
            status text not null,
            governed_by text,
            closed_at text,
            closed_by text,
            closure_mode text,
            reopened_at text,
            reopened_by text,
            continuation_packet_json text,
            updated_at text not null
          );
          create table task_specs (
            task_id text primary key,
            task_number integer not null unique,
            title text not null,
            chapter_markdown text,
            goal_markdown text,
            context_markdown text,
            required_work_markdown text,
            non_goals_markdown text,
            acceptance_criteria_json text not null,
            dependencies_json text not null,
            updated_at text not null
          );
          create table criteria_proofs (
            proof_id text primary key,
            task_id text not null,
            criterion_index integer not null,
            status text not null,
            evidence_json text not null,
            updated_at text not null
          );
          create table repo_publications (
            publication_id text primary key,
            repo_root text not null,
            branch text not null,
            remote text not null,
            commit_hash text not null,
            bundle_path text not null,
            requester_id text not null,
            requested_at text not null,
            status text not null,
            updated_at text not null
          );
        `);
      } finally {
        oldDb.close();
      }

      const opened = openTaskLifecycleStore(tempDir);
      try {
        const tables = opened.db
          .prepare("select name from sqlite_master where type = 'table'")
          .pluck()
          .all() as string[];
        expect(tables).toContain('directed_obligations');
        expect(tables).toContain('agent_roster');
        expect(tables).toContain('command_runs');
      } finally {
        opened.db.close();
      }
    });

    it('supports explicit fast SQLite posture for tests', async () => {
      const previous = process.env.NARADA_TASK_LIFECYCLE_FAST_SQLITE;
      process.env.NARADA_TASK_LIFECYCLE_FAST_SQLITE = '1';
      tempDir = await mkdtemp(join(tmpdir(), 'narada-lifecycle-store-fast-'));
      await mkdir(join(tempDir, '.ai'), { recursive: true });

      const opened = openTaskLifecycleStore(tempDir);
      try {
        const journalMode = opened.db.pragma('journal_mode', { simple: true });
        const synchronous = opened.db.pragma('synchronous', { simple: true });

        expect(String(journalMode).toLowerCase()).toBe('memory');
        expect(synchronous).toBe(0);
      } finally {
        opened.db.close();
        if (previous === undefined) {
          delete process.env.NARADA_TASK_LIFECYCLE_FAST_SQLITE;
        } else {
          process.env.NARADA_TASK_LIFECYCLE_FAST_SQLITE = previous;
        }
      }
    });

    it('fails clearly when retired better-sqlite3 is explicitly selected', async () => {
      const previous = process.env[SQLITE_BACKEND_ENV];
      process.env[SQLITE_BACKEND_ENV] = 'better-sqlite3';
      tempDir = await mkdtemp(join(tmpdir(), 'narada-lifecycle-store-better-sqlite3-'));
      await mkdir(join(tempDir, '.ai'), { recursive: true });

      try {
        expect(() => openTaskLifecycleStore(tempDir)).toThrow('NARADA_SQLITE_BACKEND=better-sqlite3');
      } finally {
        if (previous === undefined) {
          delete process.env[SQLITE_BACKEND_ENV];
        } else {
          process.env[SQLITE_BACKEND_ENV] = previous;
        }
      }
    });
  });

  describe('task lifecycle', () => {
    const baseLifecycle: TaskLifecycleRow = {
      task_id: '20260424-562-test',
      task_number: 562,
      status: 'opened',
      governed_by: null,
      closed_at: null,
      closed_by: null,
      closure_mode: null,
      relative_priority: 0,
      priority_reason: null,
      reopened_at: null,
      reopened_by: null,
      continuation_packet_json: null,
      updated_at: '2026-04-24T12:00:00.000Z',
    };

    it('inserts and reads lifecycle row', () => {
      store.upsertLifecycle(baseLifecycle);
      const read = store.getLifecycle('20260424-562-test');
      expect(read).toEqual(baseLifecycle);
    });

    it('reads lifecycle by task number', () => {
      store.upsertLifecycle(baseLifecycle);
      const read = store.getLifecycleByNumber(562);
      expect(read?.task_id).toBe('20260424-562-test');
    });

    it('returns undefined for missing task', () => {
      expect(store.getLifecycle('nonexistent')).toBeUndefined();
      expect(store.getLifecycleByNumber(99999)).toBeUndefined();
    });

    it('upserts update existing rows', () => {
      store.upsertLifecycle(baseLifecycle);
      store.upsertLifecycle({ ...baseLifecycle, status: 'claimed', updated_at: '2026-04-24T13:00:00.000Z' });
      const read = store.getLifecycle('20260424-562-test');
      expect(read?.status).toBe('claimed');
      expect(read?.updated_at).toBe('2026-04-24T13:00:00.000Z');
    });

    it('enforces unique task_number', () => {
      store.upsertLifecycle(baseLifecycle);
      expect(() =>
        store.upsertLifecycle({ ...baseLifecycle, task_id: 'different-id', task_number: 562 }),
      ).toThrow();
    });

    describe('updateStatus', () => {
      it('updates status and timestamp', () => {
        store.upsertLifecycle(baseLifecycle);
        store.updateStatus('20260424-562-test', 'claimed', 'agent-a');
        const read = store.getLifecycle('20260424-562-test');
        expect(read?.status).toBe('claimed');
        expect(read?.updated_at).not.toBe(baseLifecycle.updated_at);
      });

      it('accepts optional provenance updates', () => {
        store.upsertLifecycle(baseLifecycle);
        store.updateStatus('20260424-562-test', 'closed', 'agent-a', {
          governed_by: 'task_close:agent-a',
          closed_at: '2026-04-24T14:00:00.000Z',
          closed_by: 'agent-a',
        });
        const read = store.getLifecycle('20260424-562-test');
        expect(read?.status).toBe('closed');
        expect(read?.governed_by).toBe('task_close:agent-a');
        expect(read?.closed_at).toBe('2026-04-24T14:00:00.000Z');
        expect(read?.closed_by).toBe('agent-a');
      });

      it('throws for nonexistent task', () => {
        expect(() => store.updateStatus('nonexistent', 'claimed', 'agent-a')).toThrow(
          'not found in lifecycle store',
        );
      });
    });
  });

  describe('assignments', () => {
    const baseLifecycle: TaskLifecycleRow = {
      task_id: 'task-562',
      task_number: 562,
      status: 'opened',
      governed_by: null,
      closed_at: null,
      closed_by: null,
      reopened_at: null,
      reopened_by: null,
      continuation_packet_json: null,
      updated_at: '2026-04-24T12:00:00.000Z',
    };

    const assignment: TaskAssignmentRow = {
      assignment_id: 'assign-1',
      task_id: 'task-562',
      agent_id: 'agent-a',
      claimed_at: '2026-04-24T12:00:00.000Z',
      released_at: null,
      release_reason: null,
      intent: 'primary',
    };

    beforeEach(() => {
      store.upsertLifecycle(baseLifecycle);
    });

    it('inserts and retrieves assignment', () => {
      store.insertAssignment(assignment);
      const active = store.getActiveAssignment('task-562');
      expect(active).toEqual(assignment);
    });

    it('returns undefined when no active assignment', () => {
      expect(store.getActiveAssignment('task-562')).toBeUndefined();
    });

    it('lists all assignments ordered by claimed_at desc', () => {
      store.insertAssignment({
        ...assignment,
        assignment_id: 'assign-1',
        claimed_at: '2026-04-24T10:00:00.000Z',
      });
      store.insertAssignment({
        ...assignment,
        assignment_id: 'assign-2',
        claimed_at: '2026-04-24T12:00:00.000Z',
      });
      const list = store.getAssignments('task-562');
      expect(list.length).toBe(2);
      expect(list[0]!.assignment_id).toBe('assign-2');
    });

    it('releases an assignment', () => {
      store.insertAssignment(assignment);
      store.releaseAssignment('assign-1', 'completed');
      const active = store.getActiveAssignment('task-562');
      expect(active).toBeUndefined();
      const all = store.getAssignments('task-562');
      expect(all[0]!.released_at).not.toBeNull();
      expect(all[0]!.release_reason).toBe('completed');
    });

    it('throws when releasing nonexistent assignment', () => {
      expect(() => store.releaseAssignment('nonexistent', 'completed')).toThrow('not found');
    });

    it('returns most recent unreleased assignment as active', () => {
      store.insertAssignment({
        ...assignment,
        assignment_id: 'assign-1',
        claimed_at: '2026-04-24T10:00:00.000Z',
        released_at: '2026-04-24T11:00:00.000Z',
        release_reason: 'completed',
      });
      store.insertAssignment({
        ...assignment,
        assignment_id: 'assign-2',
        claimed_at: '2026-04-24T12:00:00.000Z',
      });
      const active = store.getActiveAssignment('task-562');
      expect(active?.assignment_id).toBe('assign-2');
    });
  });

  describe('assignment intents', () => {
    const intent: AssignmentIntentRow = {
      request_id: 'air-1',
      kind: 'claim',
      task_id: 'task-562',
      task_number: 562,
      agent_id: 'agent-a',
      requested_by: 'agent-a',
      requested_at: '2026-04-24T12:00:00.000Z',
      reason: 'test',
      no_claim: 0,
      status: 'accepted',
      rejection_reason: null,
      assignment_id: 'assign-1',
      previous_agent_id: null,
      lifecycle_status_before: 'opened',
      lifecycle_status_after: null,
      roster_status_after: null,
      confirmation_json: null,
      warnings_json: null,
      updated_at: '2026-04-24T12:00:00.000Z',
    };

    it('upserts and reads an assignment intent result', () => {
      store.upsertAssignmentIntent(intent);
      store.upsertAssignmentIntent({
        ...intent,
        status: 'applied',
        lifecycle_status_after: 'claimed',
        roster_status_after: 'working',
        confirmation_json: JSON.stringify({ task_id: 'task-562' }),
      });

      const read = store.getAssignmentIntent('air-1');
      expect(read?.status).toBe('applied');
      expect(read?.lifecycle_status_after).toBe('claimed');
      expect(read?.confirmation_json).toContain('task-562');
    });

    it('lists assignment intents for a task', () => {
      store.upsertAssignmentIntent(intent);
      store.upsertAssignmentIntent({
        ...intent,
        request_id: 'air-2',
        kind: 'roster_assign',
        requested_at: '2026-04-24T13:00:00.000Z',
        updated_at: '2026-04-24T13:00:00.000Z',
      });

      const rows = store.listAssignmentIntentsForTask('task-562');
      expect(rows.map((row) => row.request_id)).toEqual(['air-2', 'air-1']);
    });
  });

  describe('evidence admission', () => {
    const lifecycle: TaskLifecycleRow = {
      task_id: 'task-653',
      task_number: 653,
      status: 'in_review',
      governed_by: null,
      closed_at: null,
      closed_by: null,
      reopened_at: null,
      reopened_by: null,
      continuation_packet_json: null,
      updated_at: '2026-04-25T12:00:00.000Z',
    };
    const bundle: EvidenceBundleRow = {
      bundle_id: 'evb-1',
      task_id: 'task-653',
      task_number: 653,
      report_ids_json: JSON.stringify(['r1']),
      verification_run_ids_json: JSON.stringify(['v1']),
      acceptance_criteria_json: JSON.stringify({ all_checked: true, unchecked_count: 0 }),
      review_ids_json: JSON.stringify(['review-1']),
      changed_files_json: JSON.stringify(['a.ts']),
      residuals_json: JSON.stringify([]),
      assembled_at: '2026-04-25T12:00:00.000Z',
      assembled_by: 'a2',
    };
    const result: EvidenceAdmissionResultRow = {
      admission_id: 'ear-1',
      bundle_id: 'evb-1',
      task_id: 'task-653',
      task_number: 653,
      verdict: 'admitted',
      methods_json: JSON.stringify(['review']),
      blockers_json: JSON.stringify([]),
      lifecycle_eligible_status: 'closed',
      admitted_at: '2026-04-25T12:01:00.000Z',
      admitted_by: 'a2',
      confirmation_json: JSON.stringify({ observation_output_counted: false }),
    };

    beforeEach(() => {
      store.upsertLifecycle(lifecycle);
    });

    it('stores evidence bundles and admission results durably', () => {
      store.upsertEvidenceBundle(bundle);
      store.upsertEvidenceAdmissionResult(result);

      expect(store.getEvidenceBundle('evb-1')?.task_id).toBe('task-653');
      expect(store.getEvidenceAdmissionResult('ear-1')?.verdict).toBe('admitted');
      expect(store.getLatestEvidenceAdmissionResult('task-653')?.admission_id).toBe('ear-1');
      expect(store.listEvidenceBundlesForTask('task-653')).toHaveLength(1);
    });
  });

  describe('observation artifacts', () => {
    const artifact: ObservationArtifactRow = {
      artifact_id: 'obs-1',
      artifact_type: 'task_graph_mermaid',
      source_operator: 'task_graph',
      task_id: null,
      task_number: null,
      agent_id: null,
      artifact_uri: '.ai/observations/obs-1.mmd',
      digest: 'sha256',
      admitted_view_json: JSON.stringify({ node_count: 2 }),
      created_at: '2026-04-25T12:00:00.000Z',
    };

    it('stores bounded observation artifact metadata', () => {
      store.upsertObservationArtifact(artifact);
      expect(store.getObservationArtifact('obs-1')?.artifact_uri).toBe('.ai/observations/obs-1.mmd');
      expect(store.listObservationArtifacts(10)).toHaveLength(1);
    });
  });

  describe('reconciliation', () => {
    const finding: ReconciliationFindingRow = {
      finding_id: 'rf-1',
      task_id: 'task-1',
      task_number: 1,
      surfaces_json: JSON.stringify(['a', 'b']),
      expected_authority: 'task_lifecycle',
      observed_mismatch_json: JSON.stringify({ a: 'x', b: 'y' }),
      severity: 'warning',
      proposed_repair_json: JSON.stringify({ action: 'project_sqlite_status_to_frontmatter' }),
      status: 'open',
      detected_at: '2026-04-25T12:00:00.000Z',
    };

    it('stores reconciliation findings and repairs', () => {
      store.upsertReconciliationFinding(finding);
      store.upsertReconciliationRepair({
        repair_id: 'rr-1',
        finding_id: 'rf-1',
        applied: 1,
        changed_surfaces_json: JSON.stringify(['b']),
        before_json: JSON.stringify({ b: 'y' }),
        after_json: JSON.stringify({ b: 'x' }),
        verification_json: JSON.stringify({ ok: true }),
        repaired_at: '2026-04-25T12:01:00.000Z',
        repaired_by: 'a2',
      });

      expect(store.getReconciliationFinding('rf-1')?.status).toBe('open');
      expect(store.listReconciliationFindings('open')).toHaveLength(1);
      expect(store.getReconciliationRepair('rr-1')?.applied).toBe(1);
    });
  });

  describe('reports', () => {
    const baseLifecycle: TaskLifecycleRow = {
      task_id: 'task-562',
      task_number: 562,
      status: 'opened',
      governed_by: null,
      closed_at: null,
      closed_by: null,
      reopened_at: null,
      reopened_by: null,
      continuation_packet_json: null,
      updated_at: '2026-04-24T12:00:00.000Z',
    };

    const report: TaskReportRow = {
      report_id: 'report-1',
      task_id: 'task-562',
      agent_id: 'agent-a',
      summary: 'Implemented the store',
      changed_files_json: JSON.stringify(['task-lifecycle-store.ts']),
      verification_json: null,
      submitted_at: '2026-04-24T13:00:00.000Z',
    };

    beforeEach(() => {
      store.upsertLifecycle(baseLifecycle);
    });

    it('inserts and lists reports', () => {
      store.insertReport(report);
      const reports = store.listReports('task-562');
      expect(reports.length).toBe(1);
      expect(reports[0]!.summary).toBe('Implemented the store');
    });

    it('returns empty array when no reports', () => {
      expect(store.listReports('task-562')).toEqual([]);
    });

    it('orders reports by submitted_at desc', () => {
      store.insertReport({ ...report, report_id: 'report-1', submitted_at: '2026-04-24T10:00:00.000Z' });
      store.insertReport({ ...report, report_id: 'report-2', submitted_at: '2026-04-24T13:00:00.000Z' });
      const reports = store.listReports('task-562');
      expect(reports[0]!.report_id).toBe('report-2');
    });
  });

  describe('reviews', () => {
    const baseLifecycle: TaskLifecycleRow = {
      task_id: 'task-562',
      task_number: 562,
      status: 'in_review',
      governed_by: null,
      closed_at: null,
      closed_by: null,
      reopened_at: null,
      reopened_by: null,
      continuation_packet_json: null,
      updated_at: '2026-04-24T12:00:00.000Z',
    };

    const review: TaskReviewRow = {
      review_id: 'review-1',
      task_id: 'task-562',
      reviewer_agent_id: 'agent-b',
      verdict: 'accepted',
      findings_json: null,
      reviewed_at: '2026-04-24T14:00:00.000Z',
    };

    beforeEach(() => {
      store.upsertLifecycle(baseLifecycle);
    });

    it('inserts and lists reviews', () => {
      store.insertReview(review);
      const reviews = store.listReviews('task-562');
      expect(reviews.length).toBe(1);
      expect(reviews[0]!.verdict).toBe('accepted');
    });

    it('returns empty array when no reviews', () => {
      expect(store.listReviews('task-562')).toEqual([]);
    });

    it('orders reviews by reviewed_at desc', () => {
      store.insertReview({ ...review, review_id: 'review-1', reviewed_at: '2026-04-24T10:00:00.000Z' });
      store.insertReview({ ...review, review_id: 'review-2', reviewed_at: '2026-04-24T14:00:00.000Z' });
      const reviews = store.listReviews('task-562');
      expect(reviews[0]!.review_id).toBe('review-2');
    });
  });

  describe('task number sequence', () => {
    it('allocates sequential numbers', () => {
      expect(store.allocateTaskNumber()).toBe(1);
      expect(store.allocateTaskNumber()).toBe(2);
      expect(store.allocateTaskNumber()).toBe(3);
    });

    it('tracks last allocated', () => {
      expect(store.getLastAllocated()).toBe(0);
      store.allocateTaskNumber();
      expect(store.getLastAllocated()).toBe(1);
      store.allocateTaskNumber();
      expect(store.getLastAllocated()).toBe(2);
    });

    it('is safe under concurrent allocation simulation', () => {
      // Simulate rapid allocations in a tight loop
      const numbers: number[] = [];
      for (let i = 0; i < 100; i++) {
        numbers.push(store.allocateTaskNumber());
      }
      expect(numbers).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
      expect(store.getLastAllocated()).toBe(100);
    });
  });

  describe('foreign key enforcement', () => {
    it('rejects assignment for nonexistent task', () => {
      const assignment: TaskAssignmentRow = {
        assignment_id: 'assign-bad',
        task_id: 'nonexistent',
        agent_id: 'agent-a',
        claimed_at: '2026-04-24T12:00:00.000Z',
        released_at: null,
        release_reason: null,
        intent: 'primary',
      };
      // Foreign key enforcement is on, but SQLite's default behavior for
      // FK violations in a single statement is to abort the current statement
      // and return an error. We expect this to throw.
      expect(() => store.insertAssignment(assignment)).toThrow();
    });
  });
});
