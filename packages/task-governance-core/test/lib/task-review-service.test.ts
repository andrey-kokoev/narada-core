import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimTaskService, releaseTaskService } from '../../src/task-assignment-lifecycle-service.js';
import { reportTaskService } from '../../src/task-report-service.js';
import { reviewTaskService } from '../../src/task-review-service.js';
import { openTaskLifecycleStore } from '../../src/task-lifecycle-store.js';
import { ExitCode } from '../../src/exit-codes.js';

process.env.NARADA_TASK_LIFECYCLE_FAST_SQLITE = '1';

function setupRepo(tempDir: string): void {
  mkdirSync(join(tempDir, '.ai', 'agents'), { recursive: true });
  mkdirSync(join(tempDir, '.ai', 'do-not-open', 'tasks'), { recursive: true });

  writeFileSync(
    join(tempDir, '.ai', 'agents', 'roster.json'),
    JSON.stringify({
      version: 1,
      updated_at: '2026-01-01T00:00:00Z',
      agents: [
        { agent_id: 'worker', role: 'implementer', capabilities: ['claim'], first_seen_at: '2026-01-01T00:00:00Z', last_active_at: '2026-01-01T00:00:00Z' },
        { agent_id: 'reviewer', role: 'reviewer', capabilities: ['review'], first_seen_at: '2026-01-01T00:00:00Z', last_active_at: '2026-01-01T00:00:00Z' },
        { agent_id: 'admin', role: 'admin', capabilities: ['review'], first_seen_at: '2026-01-01T00:00:00Z', last_active_at: '2026-01-01T00:00:00Z' },
      ],
    }, null, 2),
  );

  writeFileSync(
    join(tempDir, '.ai', 'do-not-open', 'tasks', '20260420-999-test-task.md'),
    '---\ntask_id: 999\nstatus: opened\n---\n\n# Task 999: Test Task\n\n## Acceptance Criteria\n\n- [x] Done\n\n## Execution Notes\nCompleted.\n\n## Verification\nTests passed.\n',
  );

  const store = openTaskLifecycleStore(tempDir);
  try {
    for (const [agent_id, role, capabilities] of [
      ['worker', 'implementer', ['claim']],
      ['reviewer', 'reviewer', ['review']],
      ['admin', 'admin', ['review']],
    ] as const) {
      store.upsertRosterEntry({
        agent_id,
        role,
        capabilities_json: JSON.stringify(capabilities),
        first_seen_at: '2026-01-01T00:00:00Z',
        last_active_at: '2026-01-01T00:00:00Z',
        status: 'idle',
        task_number: null,
        last_done: null,
        updated_at: '2026-01-01T00:00:00Z',
      });
    }
    store.upsertLifecycle({
      task_id: '20260420-999-test-task',
      task_number: 999,
      status: 'opened',
      governed_by: null,
      closed_at: null,
      closed_by: null,
      reopened_at: null,
      reopened_by: null,
      continuation_packet_json: null,
      updated_at: '2026-01-01T00:00:00Z',
    });
  } finally {
    store.db.close();
  }
}

async function moveToReview(tempDir: string, taskNumber = '999'): Promise<void> {
  await claimTaskService({ taskNumber, agent: 'worker', cwd: tempDir });
  await releaseTaskService({ taskNumber, reason: 'completed', cwd: tempDir });
}

describe('task review service', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'narada-review-service-'));
    setupRepo(tempDir);
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch (error) {
      if ((error as { code?: string }).code !== 'EBUSY') {
        throw error;
      }
    }
  });

  it('accepts an in-review task and closes it through lifecycle authority', async () => {
    await moveToReview(tempDir);

    const result = await reviewTaskService({
      taskNumber: '999',
      agent: 'reviewer',
      verdict: 'accepted',
      cwd: tempDir,
    });

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.result).toMatchObject({
      status: 'success',
      verdict: 'accepted',
      new_status: 'closed',
      close_action: 'closed',
    });

    const store = openTaskLifecycleStore(tempDir);
    try {
      expect(store.getLifecycle('20260420-999-test-task')?.status).toBe('closed');
      expect(store.listReviews('20260420-999-test-task')[0]?.reviewer_agent_id).toBe('reviewer');
    } finally {
      store.db.close();
    }
  });

  it('reopens a rejected task', async () => {
    await moveToReview(tempDir);

    const result = await reviewTaskService({
      taskNumber: '999',
      agent: 'reviewer',
      verdict: 'rejected',
      cwd: tempDir,
    });

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.result.new_status).toBe('opened');
    expect(readFileSync(join(tempDir, '.ai', 'do-not-open', 'tasks', '20260420-999-test-task.md'), 'utf8')).toContain('status: opened');
  });

  it('lets a later accepted review supersede an earlier rejected review for closure', async () => {
    await moveToReview(tempDir);

    const rejected = await reviewTaskService({
      taskNumber: '999',
      agent: 'reviewer',
      verdict: 'rejected',
      findings: JSON.stringify([{ severity: 'blocking', description: 'needs repair' }]),
      cwd: tempDir,
    });
    expect(rejected.exitCode).toBe(ExitCode.SUCCESS);
    expect(rejected.result.new_status).toBe('opened');

    await new Promise((resolve) => setTimeout(resolve, 5));
    await moveToReview(tempDir);

    const accepted = await reviewTaskService({
      taskNumber: '999',
      agent: 'reviewer',
      verdict: 'accepted',
      cwd: tempDir,
    });

    expect(accepted.exitCode).toBe(ExitCode.SUCCESS);
    expect(accepted.result).toMatchObject({
      status: 'success',
      verdict: 'accepted',
      new_status: 'closed',
      close_action: 'closed',
    });

    const store = openTaskLifecycleStore(tempDir);
    try {
      expect(store.getLifecycle('20260420-999-test-task')?.status).toBe('closed');
      const reviews = store.listReviews('20260420-999-test-task');
      expect(reviews[0]?.verdict).toBe('accepted');
      expect(reviews.some((review) => review.verdict === 'rejected')).toBe(true);
      const latestAdmission = store.getLatestEvidenceAdmissionResult('20260420-999-test-task');
      expect(latestAdmission?.verdict).toBe('admitted');
      const confirmation = JSON.parse(latestAdmission!.confirmation_json) as {
        latest_review_verdict: string;
        historical_rejected_review_ids: string[];
      };
      expect(confirmation.latest_review_verdict).toBe('accepted');
      expect(confirmation.historical_rejected_review_ids.length).toBeGreaterThan(0);
    } finally {
      store.db.close();
    }
  });

  it('requires reviewer or admin authority', async () => {
    await moveToReview(tempDir);

    const denied = await reviewTaskService({
      taskNumber: '999',
      agent: 'worker',
      verdict: 'accepted',
      cwd: tempDir,
    });

    expect(denied.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(denied.result.error).toContain('without admitted review authority');
    expect(denied.result.review_authority_repair?.commands[0]).toContain('narada task roster add worker');

    const accepted = await reviewTaskService({
      taskNumber: '999',
      agent: 'admin',
      verdict: 'accepted',
      cwd: tempDir,
    });
    expect(accepted.exitCode).toBe(ExitCode.SUCCESS);
  });

  it('validates findings before writing review or mutating status', async () => {
    await moveToReview(tempDir);

    const result = await reviewTaskService({
      taskNumber: '999',
      agent: 'reviewer',
      verdict: 'accepted',
      findings: JSON.stringify([{ severity: 'bad', description: 'invalid' }]),
      cwd: tempDir,
    });

    expect(result.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(result.result.error).toContain('severity');
    const store = openTaskLifecycleStore(tempDir);
    try {
      expect(store.listReviews('20260420-999-test-task')).toHaveLength(0);
      expect(store.getLifecycle('20260420-999-test-task')?.status).toBe('in_review');
    } finally {
      store.db.close();
    }
  });

  it('updates linked report status on review', async () => {
    await claimTaskService({ taskNumber: '999', agent: 'worker', cwd: tempDir });
    const report = await reportTaskService({
      taskNumber: '999',
      agent: 'worker',
      summary: 'Done',
      cwd: tempDir,
    });
    const reportId = report.result.report_id!;

    const result = await reviewTaskService({
      taskNumber: '999',
      agent: 'reviewer',
      verdict: 'accepted',
      report: reportId,
      cwd: tempDir,
    });

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    const store = openTaskLifecycleStore(tempDir);
    try {
      const record = store.getReportRecord(reportId);
      const parsed = JSON.parse(record!.report_json) as { report_status: string };
      expect(parsed.report_status).toBe('accepted');
    } finally {
      store.db.close();
    }
  });

  it('keeps accepted reviews repairable when evidence is incomplete', async () => {
    writeFileSync(
      join(tempDir, '.ai', 'do-not-open', 'tasks', '20260420-998-no-verification.md'),
      '---\ntask_id: 998\nstatus: opened\n---\n\n# Task 998\n\n## Acceptance Criteria\n\n- [x] Done\n\n## Execution Notes\nDone.\n',
    );
    await claimTaskService({ taskNumber: '998', agent: 'worker', cwd: tempDir });
    await releaseTaskService({ taskNumber: '998', reason: 'completed', cwd: tempDir });

    const result = await reviewTaskService({
      taskNumber: '998',
      agent: 'reviewer',
      verdict: 'accepted',
      cwd: tempDir,
    });

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.result).toMatchObject({
      new_status: 'needs_continuation',
      evidence_blocked: true,
    });
    expect(result.result.evidence_reason).toContain('verification');
    expect(result.result.blocked_rationale).toContain('verification');
    expect(result.result.next_command).toContain('narada task continue 998');
  });
});
