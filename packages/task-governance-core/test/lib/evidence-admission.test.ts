import { vi } from 'vitest';

vi.unmock('node:fs');
vi.unmock('node:fs/promises');

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { admitTaskEvidence } from '../../src/evidence-admission.js';
import { openTaskLifecycleStore } from '../../src/task-lifecycle-store.js';

describe('evidence admission', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'narada-evidence-admission-'));
    mkdirSync(join(tempDir, '.ai'), { recursive: true });
    mkdirSync(join(tempDir, '.ai', 'do-not-open', 'tasks'), { recursive: true });
    writeFileSync(
      join(tempDir, '.ai', 'do-not-open', 'tasks', '20260425-653-evidence.md'),
      [
        '---',
        'status: in_review',
        '---',
        '',
        '# Task 653',
        '',
        '## Acceptance Criteria',
        '',
        '- [x] Durable evidence exists.',
        '',
      ].join('\n'),
    );
    const store = openTaskLifecycleStore(tempDir);
    try {
      store.upsertLifecycle({
        task_id: '20260425-653-evidence',
        task_number: 653,
        status: 'in_review',
        governed_by: null,
        closed_at: null,
        closed_by: null,
        reopened_at: null,
        reopened_by: null,
        continuation_packet_json: null,
        updated_at: '2026-04-25T12:00:00.000Z',
      });
      store.upsertReportRecord({
        report_id: 'r1',
        task_id: '20260425-653-evidence',
        assignment_id: 'a1',
        agent_id: 'agent',
        reported_at: '2026-04-25T12:01:00.000Z',
        report_json: JSON.stringify({ changed_files: ['x.ts'], residuals: [] }),
      });
      store.insertVerificationRun({
        run_id: 'v1',
        request_id: 'req1',
        task_id: '20260425-653-evidence',
        target_command: 'pnpm test',
        scope: 'focused',
        timeout_seconds: 120,
        requester_identity: 'agent',
        requested_at: '2026-04-25T12:02:00.000Z',
        status: 'passed',
        exit_code: 0,
        duration_ms: 10,
        metrics_json: null,
        stdout_digest: null,
        stderr_digest: null,
        stdout_excerpt: null,
        stderr_excerpt: null,
        completed_at: '2026-04-25T12:02:10.000Z',
      });
    } finally {
      store.db.close();
    }
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

  it('admits report plus TIZ verification without requiring review', async () => {
    const admission = await admitTaskEvidence({
      cwd: tempDir,
      taskNumber: 653,
      admittedBy: 'agent',
      methods: ['report', 'verification_run'],
    });

    expect(admission.result.verdict).toBe('admitted');
    expect(JSON.parse(admission.bundle.verification_run_ids_json)).toEqual(['v1']);
    expect(JSON.parse(admission.result.confirmation_json).observation_output_counted).toBe(false);
  });

  it('rejects unchecked criteria', async () => {
    writeFileSync(
      join(tempDir, '.ai', 'do-not-open', 'tasks', '20260425-653-evidence.md'),
      '---\nstatus: in_review\n---\n\n# Task 653\n\n## Acceptance Criteria\n\n- [ ] Durable evidence exists.\n',
    );

    const admission = await admitTaskEvidence({
      cwd: tempDir,
      taskNumber: 653,
      admittedBy: 'agent',
      methods: ['report'],
    });

    expect(admission.result.verdict).toBe('rejected');
    expect(admission.blockers.join(' ')).toContain('acceptance criteria');
  });
});
