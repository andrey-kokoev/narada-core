import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimTaskService, continueTaskService, releaseTaskService } from '../../src/task-assignment-lifecycle-service.js';
import { ExitCode } from '../../src/exit-codes.js';
import { loadAssignment } from '../../src/task-governance.js';
import { openTaskLifecycleStore } from '../../src/task-lifecycle-store.js';

process.env.NARADA_TASK_LIFECYCLE_FAST_SQLITE = '1';

function seedRoster(tempDir: string, agents: Array<{
  agent_id: string;
  role: string;
  capabilities: string[];
  first_seen_at: string;
  last_active_at: string;
  status?: string;
  task?: number | null;
}>): void {
  const store = openTaskLifecycleStore(tempDir);
  try {
    for (const agent of agents) {
      store.upsertRosterEntry({
        agent_id: agent.agent_id,
        role: agent.role,
        capabilities_json: JSON.stringify(agent.capabilities),
        first_seen_at: agent.first_seen_at,
        last_active_at: agent.last_active_at,
        status: agent.status ?? 'idle',
        task_number: agent.task ?? null,
        last_done: null,
        updated_at: agent.last_active_at,
      });
    }
  } finally {
    store.db.close();
  }
}

function setupRepo(tempDir: string): void {
  mkdirSync(join(tempDir, '.ai', 'agents'), { recursive: true });
  mkdirSync(join(tempDir, '.ai', 'do-not-open', 'tasks'), { recursive: true });

  const agents = [
    {
      agent_id: 'test-agent',
      role: 'implementer',
      capabilities: ['claim'],
      first_seen_at: '2026-01-01T00:00:00Z',
      last_active_at: '2026-01-01T00:00:00Z',
    },
  ];

  writeFileSync(
    join(tempDir, '.ai', 'agents', 'roster.json'),
    JSON.stringify({
      version: 1,
      updated_at: '2026-01-01T00:00:00Z',
      agents,
    }, null, 2),
  );
  seedRoster(tempDir, agents);

  writeFileSync(
    join(tempDir, '.ai', 'do-not-open', 'tasks', '20260420-999-test-task.md'),
    '---\ntask_id: 999\nstatus: opened\n---\n\n# Task 999: Test Task\n',
  );
}

function setupContinuationRepo(tempDir: string): void {
  mkdirSync(join(tempDir, '.ai', 'agents'), { recursive: true });
  mkdirSync(join(tempDir, '.ai', 'do-not-open', 'tasks'), { recursive: true });

  const agents = [
    { agent_id: 'alpha', role: 'implementer', capabilities: ['typescript'], first_seen_at: '2026-01-01T00:00:00Z', last_active_at: '2026-01-01T00:00:00Z', status: 'working', task: 100 },
    { agent_id: 'beta', role: 'implementer', capabilities: ['testing'], first_seen_at: '2026-01-01T00:00:00Z', last_active_at: '2026-01-01T00:00:00Z', status: 'done', task: null },
  ];

  writeFileSync(
    join(tempDir, '.ai', 'agents', 'roster.json'),
    JSON.stringify({
      version: 1,
      updated_at: '2026-01-01T00:00:00Z',
      agents,
    }, null, 2),
  );
  seedRoster(tempDir, agents);

  writeFileSync(
    join(tempDir, '.ai', 'do-not-open', 'tasks', '20260420-100-claimed-task.md'),
    '---\ntask_id: 100\nstatus: claimed\n---\n\n# Task 100: Claimed Task\n',
  );
  writeFileSync(
    join(tempDir, '.ai', 'do-not-open', 'tasks', '20260420-101-needs-continuation.md'),
    '---\ntask_id: 101\nstatus: needs_continuation\n---\n\n# Task 101: Needs Continuation\n',
  );
  writeFileSync(
    join(tempDir, '.ai', 'do-not-open', 'tasks', '20260420-102-opened-task.md'),
    '---\ntask_id: 102\nstatus: opened\n---\n\n# Task 102: Opened Task\n',
  );

  const store = openTaskLifecycleStore(tempDir);
  try {
    for (const [task_id, task_number, status] of [
      ['20260420-100-claimed-task', 100, 'claimed'],
      ['20260420-101-needs-continuation', 101, 'needs_continuation'],
      ['20260420-102-opened-task', 102, 'opened'],
    ] as const) {
      store.upsertLifecycle({
        task_id,
        task_number,
        status,
        governed_by: null,
        closed_at: null,
        closed_by: null,
        reopened_at: null,
        reopened_by: null,
        continuation_packet_json: null,
        updated_at: '2026-04-20T10:00:00.000Z',
      });
    }
    for (const taskId of ['20260420-100-claimed-task', '20260420-101-needs-continuation']) {
      store.upsertAssignmentRecord({
        task_id: taskId,
        record_json: JSON.stringify({
          task_id: taskId,
          assignments: [
            {
              agent_id: 'alpha',
              claimed_at: '2026-04-20T10:00:00Z',
              claim_context: null,
              released_at: null,
              release_reason: null,
            },
          ],
        }),
        updated_at: '2026-04-20T10:00:00.000Z',
      });
      store.insertAssignment({
        assignment_id: `assign-${taskId}-alpha`,
        task_id: taskId,
        agent_id: 'alpha',
        claimed_at: '2026-04-20T10:00:00Z',
        released_at: null,
        release_reason: null,
        intent: 'primary',
      });
    }
  } finally {
    store.db.close();
  }
}

describe('task assignment lifecycle service', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'narada-assignment-lifecycle-'));
    setupRepo(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('claims an opened task and records lifecycle, assignment, roster, and intent authority', async () => {
    const result = await claimTaskService({
      taskNumber: '999',
      agent: 'test-agent',
      reason: 'Testing claim',
      cwd: tempDir,
    });

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.result).toMatchObject({
      status: 'success',
      task_id: '20260420-999-test-task',
      agent_id: 'test-agent',
    });

    const taskContent = readFileSync(join(tempDir, '.ai', 'do-not-open', 'tasks', '20260420-999-test-task.md'), 'utf8');
    expect(taskContent).toContain('status: claimed');

    const assignment = await loadAssignment(tempDir, '20260420-999-test-task');
    expect(assignment?.assignments).toHaveLength(1);
    expect(assignment?.assignments[0]!.agent_id).toBe('test-agent');
    expect(assignment?.assignments[0]!.claim_context).toBe('Testing claim');

    const store = openTaskLifecycleStore(tempDir);
    try {
      expect(store.getRosterEntry('test-agent')).toMatchObject({
        status: 'working',
        task_number: 999,
      });
      expect(store.getLifecycle('20260420-999-test-task')?.status).toBe('claimed');
      const intent = store.getAssignmentIntent(result.result.assignment_intent_id!);
      expect(intent?.status).toBe('applied');
      expect(intent?.kind).toBe('claim');
      expect(intent?.lifecycle_status_after).toBe('claimed');
      expect(intent?.roster_status_after).toBe('working');
    } finally {
      store.db.close();
    }
  });

  it('rejects already claimed tasks without creating a second active assignment', async () => {
    await claimTaskService({ taskNumber: '999', agent: 'test-agent', cwd: tempDir });

    const result = await claimTaskService({ taskNumber: '999', agent: 'test-agent', cwd: tempDir });

    expect(result.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(result.result.status).toBe('error');
    expect(result.result.error).toContain('not claimable');

    const assignment = await loadAssignment(tempDir, '20260420-999-test-task');
    expect(assignment?.assignments).toHaveLength(1);
  });

  it('rejects unknown agents before mutating task state', async () => {
    const result = await claimTaskService({ taskNumber: '999', agent: 'unknown-agent', cwd: tempDir });

    expect(result.exitCode).toBe(ExitCode.INVALID_CONFIG);
    expect(result.result.error).toContain('Agent not found');
    const taskContent = readFileSync(join(tempDir, '.ai', 'do-not-open', 'tasks', '20260420-999-test-task.md'), 'utf8');
    expect(taskContent).toContain('status: opened');
  });

  it('rejects unmet dependencies and records a rejected assignment intent', async () => {
    writeFileSync(
      join(tempDir, '.ai', 'do-not-open', 'tasks', '20260420-998-blocker.md'),
      '---\ntask_id: 998\nstatus: opened\n---\n\n# Task 998\n',
    );
    writeFileSync(
      join(tempDir, '.ai', 'do-not-open', 'tasks', '20260420-999-test-task.md'),
      '---\ntask_id: 999\nstatus: opened\ndepends_on: [998]\n---\n\n# Task 999: Test Task\n',
    );

    const result = await claimTaskService({ taskNumber: '999', agent: 'test-agent', cwd: tempDir });

    expect(result.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(result.result.error).toContain('unmet dependencies');
    const store = openTaskLifecycleStore(tempDir);
    try {
      const intent = store.getAssignmentIntent(result.result.assignment_intent_id!);
      expect(intent?.status).toBe('rejected');
      expect(store.getLifecycle('20260420-999-test-task')).toBeUndefined();
    } finally {
      store.db.close();
    }
  });

  it('continues a claimed task for evidence repair without releasing the primary assignment', async () => {
    setupContinuationRepo(tempDir);

    const result = await continueTaskService({
      taskNumber: '100',
      agent: 'beta',
      reason: 'evidence_repair',
      cwd: tempDir,
    });

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.result).toMatchObject({
      status: 'success',
      supersedes: false,
      previous_agent_id: 'alpha',
    });
    const assignment = await loadAssignment(tempDir, '20260420-100-claimed-task');
    expect(assignment?.assignments).toHaveLength(1);
    expect(assignment?.assignments[0]!.released_at).toBeNull();
    expect(assignment?.continuations?.[0]).toMatchObject({
      agent_id: 'beta',
      reason: 'evidence_repair',
      previous_agent_id: 'alpha',
    });
  });

  it('continues by handoff and supersedes the prior active assignment', async () => {
    setupContinuationRepo(tempDir);

    const result = await continueTaskService({
      taskNumber: '100',
      agent: 'beta',
      reason: 'handoff',
      cwd: tempDir,
    });

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.result.supersedes).toBe(true);
    const assignment = await loadAssignment(tempDir, '20260420-100-claimed-task');
    expect(assignment?.assignments).toHaveLength(2);
    expect(assignment?.assignments[0]!.release_reason).toBe('continued');
    expect(assignment?.assignments[1]).toMatchObject({
      agent_id: 'beta',
      continuation_reason: 'handoff',
      previous_agent_id: 'alpha',
      intent: 'takeover',
    });
  });

  it('continues needs_continuation tasks by restoring claimed lifecycle status', async () => {
    setupContinuationRepo(tempDir);

    const result = await continueTaskService({
      taskNumber: '101',
      agent: 'beta',
      reason: 'blocked_agent',
      cwd: tempDir,
    });

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    const taskContent = readFileSync(join(tempDir, '.ai', 'do-not-open', 'tasks', '20260420-101-needs-continuation.md'), 'utf8');
    expect(taskContent).toContain('status: claimed');
    const store = openTaskLifecycleStore(tempDir);
    try {
      expect(store.getLifecycle('20260420-101-needs-continuation')?.status).toBe('claimed');
    } finally {
      store.db.close();
    }
  });

  it('rejects opened tasks with claim guidance', async () => {
    setupContinuationRepo(tempDir);

    const result = await continueTaskService({
      taskNumber: '102',
      agent: 'beta',
      reason: 'evidence_repair',
      cwd: tempDir,
    });

    expect(result.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(result.result.error).toContain('task claim');
  });

  it('releases completed tasks to in_review and updates SQLite lifecycle and assignment row', async () => {
    await claimTaskService({ taskNumber: '999', agent: 'test-agent', cwd: tempDir });

    const result = await releaseTaskService({
      taskNumber: '999',
      reason: 'completed',
      cwd: tempDir,
    });

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.result).toMatchObject({
      status: 'success',
      release_reason: 'completed',
      new_status: 'in_review',
    });
    const taskContent = readFileSync(join(tempDir, '.ai', 'do-not-open', 'tasks', '20260420-999-test-task.md'), 'utf8');
    expect(taskContent).toContain('status: in_review');

    const assignment = await loadAssignment(tempDir, '20260420-999-test-task');
    expect(assignment?.assignments[0]!.release_reason).toBe('completed');
    expect(assignment?.assignments[0]!.released_at).not.toBeNull();

    const store = openTaskLifecycleStore(tempDir);
    try {
      expect(store.getLifecycle('20260420-999-test-task')?.status).toBe('in_review');
      expect(store.getActiveAssignment('20260420-999-test-task')).toBeUndefined();
    } finally {
      store.db.close();
    }
  });

  it('releases abandoned tasks back to opened', async () => {
    await claimTaskService({ taskNumber: '999', agent: 'test-agent', cwd: tempDir });

    const result = await releaseTaskService({
      taskNumber: '999',
      reason: 'abandoned',
      cwd: tempDir,
    });

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.result.new_status).toBe('opened');
    const store = openTaskLifecycleStore(tempDir);
    try {
      expect(store.getLifecycle('20260420-999-test-task')?.status).toBe('opened');
    } finally {
      store.db.close();
    }
  });

  it('requires and persists continuation packets for budget_exhausted release', async () => {
    await claimTaskService({ taskNumber: '999', agent: 'test-agent', cwd: tempDir });

    const missing = await releaseTaskService({
      taskNumber: '999',
      reason: 'budget_exhausted',
      cwd: tempDir,
    });
    expect(missing.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(missing.result.error).toContain('--continuation');

    const packetPath = join(tempDir, 'continuation.json');
    writeFileSync(packetPath, JSON.stringify({
      last_completed_step: 'Step 1',
      remaining_work: 'Step 2',
      files_touched: ['src/a.ts'],
      verification_run: 'none',
      known_blockers: 'none',
      resume_recommendation: 'same agent',
    }));

    const result = await releaseTaskService({
      taskNumber: '999',
      reason: 'budget_exhausted',
      continuation: packetPath,
      cwd: tempDir,
    });

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.result.new_status).toBe('needs_continuation');
    const store = openTaskLifecycleStore(tempDir);
    try {
      const lifecycle = store.getLifecycle('20260420-999-test-task');
      expect(lifecycle?.status).toBe('needs_continuation');
      expect(lifecycle?.continuation_packet_json).toContain('Step 2');
    } finally {
      store.db.close();
    }
  });
});
