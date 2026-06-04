import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  findTaskFile,
  extractTaskNumberFromFileName,
  continuationReasonToIntent,
  isValidTransition,
  loadRoster,
  readTaskFile,
  updateAgentRosterEntry,
  writeTaskFile,
  type ContinuationPacket,
} from './task-governance.js';
import { openTaskLifecycleStore, type TaskStatus } from './task-lifecycle-store.js';
import {
  admitAssignmentIntent,
  ensureLifecycleForAssignment,
  recordAssignmentIntentApplied,
  recordAssignmentIntentFailed,
} from './assignment-intent.js';
import { ExitCode } from './exit-codes.js';

export interface ClaimTaskServiceOptions {
  taskNumber?: string | number;
  agent?: string;
  reason?: string;
  cwd?: string;
}

export interface ClaimTaskServiceResult {
  status: 'success' | 'error';
  task_id?: string;
  agent_id?: string;
  claimed_at?: string;
  assignment_intent_id?: string;
  warnings?: string[];
  error?: string;
}

export type ContinuationReason =
  | 'evidence_repair'
  | 'review_fix'
  | 'handoff'
  | 'blocked_agent'
  | 'operator_override';

export const ALLOWED_CONTINUATION_REASONS: ContinuationReason[] = [
  'evidence_repair',
  'review_fix',
  'handoff',
  'blocked_agent',
  'operator_override',
];

export interface ContinueTaskServiceOptions {
  taskNumber?: string | number;
  agent?: string;
  reason?: ContinuationReason;
  cwd?: string;
}

export interface ContinueTaskServiceResult {
  status: 'success' | 'error';
  task_id?: string;
  agent_id?: string;
  reason?: ContinuationReason;
  supersedes?: boolean;
  previous_agent_id?: string;
  previous_roster_reconciled?: boolean;
  task_status?: string;
  continued_at?: string;
  assignment_intent_id?: string;
  error?: string;
}

export type ReleaseReason = 'completed' | 'abandoned' | 'superseded' | 'transferred' | 'budget_exhausted';

export const VALID_RELEASE_REASONS: ReleaseReason[] = [
  'completed',
  'abandoned',
  'superseded',
  'transferred',
  'budget_exhausted',
];

export interface ReleaseTaskServiceOptions {
  taskNumber?: string | number;
  reason?: ReleaseReason;
  continuation?: string;
  cwd?: string;
}

export interface ReleaseTaskServiceResult {
  status: 'success' | 'error';
  task_id?: string;
  agent_id?: string;
  released_at?: string;
  release_reason?: ReleaseReason;
  new_status?: string;
  error?: string;
}

export async function claimTaskService(
  options: ClaimTaskServiceOptions,
): Promise<{ exitCode: ExitCode; result: ClaimTaskServiceResult }> {
  const cwd = options.cwd ? resolve(options.cwd) : process.cwd();
  const taskNumber = options.taskNumber;
  const agentId = options.agent;
  const reason = options.reason;

  if (taskNumber === undefined || taskNumber === null || String(taskNumber).trim().length === 0) {
    return {
      exitCode: ExitCode.GENERAL_ERROR,
      result: { status: 'error', error: 'Task number is required' },
    };
  }

  if (!agentId) {
    return {
      exitCode: ExitCode.GENERAL_ERROR,
      result: { status: 'error', error: '--agent is required' },
    };
  }

  const parsedTaskNumber = await resolveTaskNumberForAssignment(cwd, taskNumber);
  if (!Number.isInteger(parsedTaskNumber)) {
    return {
      exitCode: ExitCode.INVALID_CONFIG,
      result: { status: 'error', error: `Cannot resolve task number: ${String(taskNumber)}` },
    };
  }
  const admission = await admitAssignmentIntent(cwd, {
    kind: 'claim',
    taskNumber: parsedTaskNumber,
    agentId,
    requestedBy: agentId,
    reason: reason ?? null,
  });
  if (!admission.ok) {
    return {
      exitCode: admission.exitCode,
      result: admission.result,
    };
  }

  const { taskFile, frontMatter, body } = admission;
  const now = new Date().toISOString();

  try {
    const store = openTaskLifecycleStore(cwd);
    try {
      ensureLifecycleForAssignment(store, taskFile.taskId, parsedTaskNumber, frontMatter);
      store.updateStatus(taskFile.taskId, 'claimed', agentId);
    } finally {
      store.db.close();
    }

    frontMatter.status = 'claimed';
    await writeTaskFile(taskFile.path, frontMatter, body);

    const assignmentStore = openTaskLifecycleStore(cwd);
    try {
      assignmentStore.insertAssignment({
        assignment_id: admission.intent.assignment_id ?? `assign-${taskFile.taskId}-${agentId}-${Date.now()}`,
        task_id: taskFile.taskId,
        agent_id: agentId,
        claimed_at: now,
        released_at: null,
        release_reason: null,
        intent: 'primary',
      });
    } finally {
      assignmentStore.db.close();
    }

    await updateAgentRosterEntry(cwd, agentId, {
      status: 'working',
      task: parsedTaskNumber,
    });

    recordAssignmentIntentApplied(cwd, admission.intent.request_id, {
      lifecycleStatusAfter: 'claimed',
      rosterStatusAfter: 'working',
      assignmentId: admission.intent.assignment_id,
      warnings: admission.warnings,
      confirmation: {
        task_id: taskFile.taskId,
        task_number: parsedTaskNumber,
        lifecycle_status: 'claimed',
        roster_status: 'working',
        assignment_agent_id: agentId,
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    recordAssignmentIntentFailed(cwd, admission.intent.request_id, msg);
    return {
      exitCode: ExitCode.GENERAL_ERROR,
      result: { status: 'error', error: msg, assignment_intent_id: admission.intent.request_id },
    };
  }

  return {
    exitCode: ExitCode.SUCCESS,
    result: {
      status: 'success',
      task_id: taskFile.taskId,
      agent_id: agentId,
      claimed_at: now,
      assignment_intent_id: admission.intent.request_id,
      warnings: admission.warnings.length > 0 ? admission.warnings : undefined,
    },
  };
}

async function resolveTaskNumberForAssignment(cwd: string, taskNumber: string | number): Promise<number> {
  const numeric = Number(taskNumber);
  if (Number.isInteger(numeric)) return numeric;
  const taskFile = await findTaskFile(cwd, String(taskNumber));
  if (!taskFile) return Number.NaN;
  return extractTaskNumberFromFileName(`${taskFile.taskId}.md`) ?? Number.NaN;
}

export async function continueTaskService(
  options: ContinueTaskServiceOptions,
): Promise<{ exitCode: ExitCode; result: ContinueTaskServiceResult }> {
  const cwd = options.cwd ? resolve(options.cwd) : process.cwd();
  const taskNumber = options.taskNumber;
  const agentId = options.agent;
  const reason = options.reason;

  if (taskNumber === undefined || taskNumber === null || String(taskNumber).trim().length === 0) {
    return {
      exitCode: ExitCode.GENERAL_ERROR,
      result: { status: 'error', error: 'Task number is required' },
    };
  }

  if (!agentId) {
    return {
      exitCode: ExitCode.GENERAL_ERROR,
      result: { status: 'error', error: '--agent is required' },
    };
  }

  if (!reason) {
    return {
      exitCode: ExitCode.GENERAL_ERROR,
      result: { status: 'error', error: '--reason is required' },
    };
  }

  if (!ALLOWED_CONTINUATION_REASONS.includes(reason)) {
    return {
      exitCode: ExitCode.GENERAL_ERROR,
      result: {
        status: 'error',
        error: `Invalid reason: ${reason}. Must be one of: ${ALLOWED_CONTINUATION_REASONS.join(', ')}`,
      },
    };
  }

  const parsedTaskNumber = Number(taskNumber);
  const admission = await admitAssignmentIntent(cwd, {
    kind: 'continue',
    taskNumber: parsedTaskNumber,
    agentId,
    requestedBy: agentId,
    reason,
  });
  if (!admission.ok) {
    return {
      exitCode: admission.exitCode,
      result: admission.result,
    };
  }

  const { taskFile, frontMatter, body } = admission;
  const currentStatus = admission.currentStatus;
  const assignmentStoreForAdmission = openTaskLifecycleStore(cwd);
  let active: ReturnType<typeof assignmentStoreForAdmission.getActiveAssignment> | undefined;
  try {
    active = assignmentStoreForAdmission.getActiveAssignment(taskFile.taskId);
  } finally {
    assignmentStoreForAdmission.db.close();
  }
  const canStartWithoutActive =
    currentStatus === 'needs_continuation' ||
    (currentStatus === 'in_review' && reason === 'evidence_repair');
  if (!active && !canStartWithoutActive) {
    recordAssignmentIntentFailed(cwd, admission.intent.request_id, 'Active assignment disappeared after admission');
    return {
      exitCode: ExitCode.GENERAL_ERROR,
      result: {
        status: 'error',
        error: `Task ${taskFile.taskId} has no active assignment to continue from.`,
        assignment_intent_id: admission.intent.request_id,
      },
    };
  }

  const now = new Date().toISOString();
  const supersedes = admission.supersedes;
  let previousRosterReconciled = false;

  try {
    if (currentStatus === 'needs_continuation' || (currentStatus === 'in_review' && reason === 'evidence_repair')) {
      frontMatter.status = 'claimed';
      await writeTaskFile(taskFile.path, frontMatter, body);
    }

    const store = openTaskLifecycleStore(cwd);
    try {
      ensureLifecycleForAssignment(store, taskFile.taskId, parsedTaskNumber, frontMatter);
      if (currentStatus === 'needs_continuation' || (currentStatus === 'in_review' && reason === 'evidence_repair')) {
        store.updateStatus(taskFile.taskId, 'claimed', agentId);
      }
    } finally {
      store.db.close();
    }
    const assignmentStore = openTaskLifecycleStore(cwd);
    try {
      if (supersedes) {
        const activeRow = assignmentStore.getActiveAssignment(taskFile.taskId);
        if (activeRow) {
          assignmentStore.releaseAssignment(activeRow.assignment_id, 'continued');
        }
      }
      assignmentStore.insertAssignment({
        assignment_id: admission.intent.assignment_id ?? `assign-${taskFile.taskId}-${agentId}-${Date.now()}`,
        task_id: taskFile.taskId,
        agent_id: agentId,
        claimed_at: now,
        released_at: null,
        release_reason: null,
        intent: continuationReasonToIntent(reason),
      });
    } finally {
      assignmentStore.db.close();
    }

    await updateAgentRosterEntry(cwd, agentId, {
      status: 'working',
      task: parsedTaskNumber || null,
    });

    if (supersedes && active && active.agent_id !== agentId) {
      const roster = await loadRoster(cwd);
      const previousAgent = roster.agents.find((entry) => entry.agent_id === active.agent_id);
      if (previousAgent?.task === parsedTaskNumber) {
        await updateAgentRosterEntry(cwd, active.agent_id, {
          status: 'idle',
          task: null,
        });
        previousRosterReconciled = true;
      }
    }

    recordAssignmentIntentApplied(cwd, admission.intent.request_id, {
      lifecycleStatusAfter: (frontMatter.status as string | undefined) ?? null,
      rosterStatusAfter: 'working',
      assignmentId: admission.intent.assignment_id,
      confirmation: {
        task_id: taskFile.taskId,
        task_number: parsedTaskNumber,
        supersedes,
        previous_agent_id: active?.agent_id ?? null,
        previous_roster_reconciled: previousRosterReconciled,
        lifecycle_status: frontMatter.status,
        roster_status: 'working',
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    recordAssignmentIntentFailed(cwd, admission.intent.request_id, msg);
    return {
      exitCode: ExitCode.GENERAL_ERROR,
      result: { status: 'error', error: msg, assignment_intent_id: admission.intent.request_id },
    };
  }

  return {
    exitCode: ExitCode.SUCCESS,
    result: {
      status: 'success',
      task_id: taskFile.taskId,
      agent_id: agentId,
      reason,
      supersedes,
      previous_agent_id: active?.agent_id,
      previous_roster_reconciled: previousRosterReconciled,
      task_status: frontMatter.status as string | undefined,
      continued_at: now,
      assignment_intent_id: admission.intent.request_id,
    },
  };
}

function releaseStatusForReason(reason: ReleaseReason): string {
  switch (reason) {
    case 'completed':
      return 'closed';
    case 'budget_exhausted':
      return 'needs_continuation';
    case 'abandoned':
    case 'superseded':
    case 'transferred':
      return 'opened';
  }
}

export async function releaseTaskService(
  options: ReleaseTaskServiceOptions,
): Promise<{ exitCode: ExitCode; result: ReleaseTaskServiceResult }> {
  const cwd = options.cwd ? resolve(options.cwd) : process.cwd();
  const taskNumber = options.taskNumber;
  const releaseReason = options.reason;

  if (taskNumber === undefined || taskNumber === null || String(taskNumber).trim().length === 0) {
    return {
      exitCode: ExitCode.GENERAL_ERROR,
      result: { status: 'error', error: 'Task number is required' },
    };
  }

  if (!releaseReason || !VALID_RELEASE_REASONS.includes(releaseReason)) {
    return {
      exitCode: ExitCode.GENERAL_ERROR,
      result: { status: 'error', error: `--reason must be one of: ${VALID_RELEASE_REASONS.join(', ')}` },
    };
  }

  let taskFile;
  try {
    taskFile = await findTaskFile(cwd, String(taskNumber));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      exitCode: ExitCode.GENERAL_ERROR,
      result: { status: 'error', error: msg },
    };
  }

  if (!taskFile) {
    return {
      exitCode: ExitCode.INVALID_CONFIG,
      result: { status: 'error', error: `Task not found: ${taskNumber}` },
    };
  }

  const assignmentStore = openTaskLifecycleStore(cwd);
  const active = assignmentStore.getActiveAssignment(taskFile.taskId);
  assignmentStore.db.close();
  if (!active) {
    return {
      exitCode: ExitCode.GENERAL_ERROR,
      result: { status: 'error', error: `Task ${taskFile.taskId} has no active SQL assignment` },
    };
  }

  const { frontMatter, body } = await readTaskFile(taskFile.path);
  if (frontMatter.status !== 'claimed') {
    return {
      exitCode: ExitCode.GENERAL_ERROR,
      result: {
        status: 'error',
        error: `Task ${taskFile.taskId} consistency error: assignment is active but task status is '${String(frontMatter.status ?? 'missing')}', expected 'claimed'`,
      },
    };
  }

  const newStatus = releaseStatusForReason(releaseReason);
  if (!isValidTransition(frontMatter.status, newStatus)) {
    return {
      exitCode: ExitCode.GENERAL_ERROR,
      result: {
        status: 'error',
        error: `Transition from '${String(frontMatter.status)}' to '${newStatus}' is not allowed by the state machine`,
      },
    };
  }

  let continuationPacket: ContinuationPacket | undefined;
  if (releaseReason === 'budget_exhausted') {
    if (!options.continuation) {
      return {
        exitCode: ExitCode.GENERAL_ERROR,
        result: {
          status: 'error',
          error: '--continuation <path> is required when releasing with reason budget_exhausted',
        },
      };
    }
    try {
      const raw = await readFile(options.continuation, 'utf8');
      continuationPacket = JSON.parse(raw) as ContinuationPacket;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        exitCode: ExitCode.GENERAL_ERROR,
        result: { status: 'error', error: `Failed to read continuation packet: ${msg}` },
      };
    }
  }

  const now = new Date().toISOString();
  frontMatter.status = newStatus;
  if (continuationPacket) {
    frontMatter.continuation_packet = continuationPacket;
  }
  await writeTaskFile(taskFile.path, frontMatter, body);

  const store = openTaskLifecycleStore(cwd);
  try {
    const activeRow = store.getActiveAssignment(taskFile.taskId);
    if (activeRow) {
      store.releaseAssignment(activeRow.assignment_id, releaseReason);
    }
    ensureLifecycleForAssignment(store, taskFile.taskId, Number(taskNumber), frontMatter);
    store.updateStatus(taskFile.taskId, newStatus as TaskStatus, active.agent_id);
    if (continuationPacket) {
      const row = store.getLifecycle(taskFile.taskId);
      if (row) {
        store.upsertLifecycle({
          ...row,
          continuation_packet_json: JSON.stringify(continuationPacket),
          updated_at: now,
        });
      }
    }
  } finally {
    store.db.close();
  }

  return {
    exitCode: ExitCode.SUCCESS,
    result: {
      status: 'success',
      task_id: taskFile.taskId,
      agent_id: active.agent_id,
      released_at: now,
      release_reason: releaseReason,
      new_status: frontMatter.status as string,
    },
  };
}
