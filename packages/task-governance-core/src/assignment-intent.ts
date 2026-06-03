import {
  checkDependencies,
  findTaskFile,
  getActiveAssignment,
  isValidTransition,
  loadAssignment,
  loadRoster,
  readTaskFile,
  type TaskFrontMatter,
} from './task-governance.js';
import {
  openTaskLifecycleStore,
  type AssignmentIntentKind,
  type AssignmentIntentRow,
  type TaskLifecycleStore,
  type TaskStatus,
} from './task-lifecycle-store.js';
import { ExitCode } from './exit-codes.js';

export type ContinuationReason =
  | 'evidence_repair'
  | 'review_fix'
  | 'handoff'
  | 'blocked_agent'
  | 'operator_override';

export interface AssignmentAdmissionRequest {
  kind: AssignmentIntentKind;
  taskNumber: number;
  agentId: string;
  requestedBy?: string;
  reason?: string | null;
  noClaim?: boolean;
}

export interface AssignmentAdmissionAccepted {
  ok: true;
  intent: AssignmentIntentRow;
  taskFile: { path: string; taskId: string };
  frontMatter: TaskFrontMatter;
  body: string;
  currentStatus: string | undefined;
  shouldClaim: boolean;
  shouldBackfillAssignment: boolean;
  supersedes: boolean;
  previousAgentId: string | null;
  warnings: string[];
}

export interface AssignmentAdmissionRejected {
  ok: false;
  exitCode: ExitCode;
  result: { status: 'error'; error: string; assignment_intent_id?: string };
}

export type AssignmentAdmissionResult = AssignmentAdmissionAccepted | AssignmentAdmissionRejected;

function nowIso(): string {
  return new Date().toISOString();
}

function generateRequestId(kind: AssignmentIntentKind, taskNumber: number, agentId: string): string {
  return `air_${kind}_${taskNumber}_${agentId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateAssignmentId(taskId: string, agentId: string): string {
  return `assign-${taskId}-${agentId}-${Date.now()}`;
}

function makeIntent(
  request: AssignmentAdmissionRequest,
  values: Partial<AssignmentIntentRow>,
): AssignmentIntentRow {
  const requestedAt = values.requested_at ?? nowIso();
  return {
    request_id: values.request_id ?? generateRequestId(request.kind, request.taskNumber, request.agentId),
    kind: request.kind,
    task_id: values.task_id ?? null,
    task_number: request.taskNumber,
    agent_id: request.agentId,
    requested_by: request.requestedBy ?? request.agentId,
    requested_at: requestedAt,
    reason: request.reason ?? null,
    no_claim: request.noClaim ? 1 : 0,
    status: values.status ?? 'accepted',
    rejection_reason: values.rejection_reason ?? null,
    assignment_id: values.assignment_id ?? null,
    previous_agent_id: values.previous_agent_id ?? null,
    lifecycle_status_before: values.lifecycle_status_before ?? null,
    lifecycle_status_after: values.lifecycle_status_after ?? null,
    roster_status_after: values.roster_status_after ?? null,
    confirmation_json: values.confirmation_json ?? null,
    warnings_json: values.warnings_json ?? null,
    updated_at: values.updated_at ?? requestedAt,
  };
}

function recordIntent(cwd: string, intent: AssignmentIntentRow): void {
  const store = openTaskLifecycleStore(cwd);
  try {
    store.upsertAssignmentIntent(intent);
  } finally {
    store.db.close();
  }
}

function reject(
  cwd: string,
  request: AssignmentAdmissionRequest,
  error: string,
  values: Partial<AssignmentIntentRow> = {},
  exitCode: ExitCode = ExitCode.GENERAL_ERROR,
): AssignmentAdmissionRejected {
  const intent = makeIntent(request, {
    ...values,
    status: 'rejected',
    rejection_reason: error,
    updated_at: nowIso(),
  });
  recordIntent(cwd, intent);
  return {
    ok: false,
    exitCode,
    result: { status: 'error', error, assignment_intent_id: intent.request_id },
  };
}

function readLifecycleStatus(store: TaskLifecycleStore, taskId: string): string | undefined {
  return store.getLifecycle(taskId)?.status;
}

async function computeClaimAffinityWarning(
  cwd: string,
  agentId: string,
  frontMatter: TaskFrontMatter,
): Promise<string | null> {
  const manual = frontMatter.continuation_affinity;
  let preferredAgentId: string | null = manual?.preferred_agent_id ?? null;
  let affinityReason: string | null = manual?.affinity_reason ?? null;
  let affinitySource: 'manual' | 'history' = 'manual';

  if (!preferredAgentId) {
    const deps = Array.isArray(frontMatter.depends_on) ? frontMatter.depends_on : [];
    const completionCounts = new Map<string, number>();
    for (const dep of deps) {
      const depTask = await findTaskFile(cwd, String(dep));
      if (!depTask) continue;
      const assignment = await loadAssignment(cwd, depTask.taskId);
      if (!assignment) continue;
      for (const item of assignment.assignments) {
        if (item.release_reason === 'completed') {
          completionCounts.set(item.agent_id, (completionCounts.get(item.agent_id) ?? 0) + 1);
        }
      }
    }

    let bestCount = 0;
    for (const [candidateAgentId, count] of completionCounts) {
      if (count > bestCount) {
        preferredAgentId = candidateAgentId;
        bestCount = count;
      }
    }
    if (preferredAgentId) {
      affinitySource = 'history';
      affinityReason = `Completed ${bestCount} prerequisite task${bestCount > 1 ? 's' : ''}`;
    }
  }

  if (!preferredAgentId) return null;
  const match = preferredAgentId === agentId ? 'matches' : 'prefers another agent';
  return `Continuation affinity (${affinitySource}) ${match}: preferred_agent_id=${preferredAgentId}${affinityReason ? `; reason=${affinityReason}` : ''}`;
}

export async function admitAssignmentIntent(
  cwd: string,
  request: AssignmentAdmissionRequest,
): Promise<AssignmentAdmissionResult> {
  let roster;
  try {
    roster = await loadRoster(cwd);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return reject(cwd, request, `Failed to load agent roster: ${msg}`);
  }

  const agent = roster.agents.find((a) => a.agent_id === request.agentId);
  if (!agent) {
    return reject(cwd, request, `Agent not found in roster: ${request.agentId}`, {}, ExitCode.INVALID_CONFIG);
  }

  let taskFile: { path: string; taskId: string } | null;
  try {
    taskFile = await findTaskFile(cwd, String(request.taskNumber));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return reject(cwd, request, msg);
  }
  if (!taskFile) {
    return reject(cwd, request, `Task not found: ${request.taskNumber}`, {}, ExitCode.INVALID_CONFIG);
  }

  const { frontMatter, body } = await readTaskFile(taskFile.path);
  const store = openTaskLifecycleStore(cwd);
  let lifecycleStatus: string | undefined;
  let blockedBy: string[] = [];
  let dependencyDetails: Array<{ taskId: string; reason: string }> = [];
  let latestAdmissionVerdict: string | undefined;
  let hasAcceptedReview = false;
  try {
    lifecycleStatus = readLifecycleStatus(store, taskFile.taskId);
    if (request.kind === 'continue') {
      latestAdmissionVerdict = store.getLatestEvidenceAdmissionResult(taskFile.taskId)?.verdict;
      hasAcceptedReview = store.listReviews(taskFile.taskId).some((review) => review.verdict === 'accepted');
    }
    if (request.kind !== 'continue') {
      const dependencyCheck = await checkDependencies(cwd, frontMatter.depends_on as number[] | undefined, store);
      blockedBy = dependencyCheck.blockedBy;
      dependencyDetails = dependencyCheck.details;
    }
  } finally {
    store.db.close();
  }

  const currentStatus = lifecycleStatus ?? (frontMatter.status as string | undefined);
  const existing = await loadAssignment(cwd, taskFile.taskId);
  const active = existing ? getActiveAssignment(existing) : null;
  const warnings: string[] = [];
  let shouldClaim = false;
  let shouldBackfillAssignment = false;
  let supersedes = false;
  let previousAgentId: string | null = null;
  let assignmentId: string | null = null;

  if (request.kind === 'continue') {
    const evidenceRepairInReview =
      currentStatus === 'in_review' &&
      request.reason === 'evidence_repair' &&
      latestAdmissionVerdict === 'rejected' &&
      hasAcceptedReview;
    const evidenceRepairContinuation = currentStatus === 'needs_continuation' || evidenceRepairInReview;
    if (currentStatus === 'opened') {
      return reject(cwd, request, `Task ${taskFile.taskId} is opened, not claimed. Use 'narada task claim' or 'narada task roster assign' instead of 'task continue'.`, {
        task_id: taskFile.taskId,
        lifecycle_status_before: currentStatus ?? null,
      });
    }
    if (currentStatus !== 'claimed' && currentStatus !== 'needs_continuation' && !evidenceRepairInReview) {
      return reject(cwd, request, `Task ${taskFile.taskId} cannot be continued (status: ${currentStatus ?? 'missing'}). Only 'claimed', 'needs_continuation', or evidence-repair-needed in_review tasks support continuation.`, {
        task_id: taskFile.taskId,
        lifecycle_status_before: currentStatus ?? null,
      });
    }
    if (!active && !evidenceRepairContinuation) {
      return reject(cwd, request, `Task ${taskFile.taskId} has no active assignment to continue from.`, {
        task_id: taskFile.taskId,
        lifecycle_status_before: currentStatus ?? null,
      });
    }
    if (active?.agent_id === request.agentId) {
      return reject(cwd, request, `Agent ${request.agentId} is already the active assignee for task ${taskFile.taskId}.`, {
        task_id: taskFile.taskId,
        lifecycle_status_before: currentStatus ?? null,
        previous_agent_id: active.agent_id,
      });
    }
    previousAgentId = active?.agent_id ?? null;
    supersedes = active ? ['handoff', 'blocked_agent', 'operator_override'].includes(request.reason ?? '') : false;
    assignmentId = supersedes || !active ? generateAssignmentId(taskFile.taskId, request.agentId) : null;
  } else if (request.noClaim) {
    warnings.push('Claim skipped due to --no-claim flag');
  } else if (currentStatus === 'claimed' && request.kind === 'roster_assign') {
    if (!active) {
      shouldBackfillAssignment = true;
      assignmentId = generateAssignmentId(taskFile.taskId, request.agentId);
      warnings.push(`Task ${taskFile.taskId} is already claimed but has no active SQL assignment; SQL assignment backfilled`);
    } else {
      warnings.push(`Task ${taskFile.taskId} is already claimed; roster updated without re-claiming`);
    }
  } else {
    if (currentStatus !== 'opened' && currentStatus !== 'needs_continuation') {
      return reject(cwd, request, `Task ${taskFile.taskId} is not claimable (status: ${currentStatus ?? 'missing'})`, {
        task_id: taskFile.taskId,
        lifecycle_status_before: currentStatus ?? null,
      });
    }
    if (!isValidTransition(currentStatus, 'claimed')) {
      return reject(cwd, request, `Transition from '${currentStatus}' to 'claimed' is not allowed by the state machine`, {
        task_id: taskFile.taskId,
        lifecycle_status_before: currentStatus ?? null,
      });
    }
    if (blockedBy.length > 0) {
      const detailMessages = dependencyDetails.map((d) => `${d.taskId}: ${d.reason}`).join('; ');
      return reject(cwd, request, `Task ${taskFile.taskId} has unmet dependencies: ${blockedBy.join(', ')}. ${detailMessages}`, {
        task_id: taskFile.taskId,
        lifecycle_status_before: currentStatus ?? null,
      });
    }
    if (active) {
      return reject(cwd, request, `Task ${taskFile.taskId} is already claimed by ${active.agent_id} at ${active.claimed_at}`, {
        task_id: taskFile.taskId,
        lifecycle_status_before: currentStatus ?? null,
        previous_agent_id: active.agent_id,
      });
    }
    const affinityWarning = await computeClaimAffinityWarning(cwd, request.agentId, frontMatter);
    if (affinityWarning) {
      warnings.push(affinityWarning);
    }
    shouldClaim = true;
    assignmentId = generateAssignmentId(taskFile.taskId, request.agentId);
  }

  const intent = makeIntent(request, {
    task_id: taskFile.taskId,
    status: 'accepted',
    assignment_id: assignmentId,
    previous_agent_id: previousAgentId,
    lifecycle_status_before: currentStatus ?? null,
    warnings_json: warnings.length > 0 ? JSON.stringify(warnings) : null,
  });
  recordIntent(cwd, intent);

  return {
    ok: true,
    intent,
    taskFile,
    frontMatter,
    body,
    currentStatus,
    shouldClaim,
    shouldBackfillAssignment,
    supersedes,
    previousAgentId,
    warnings,
  };
}

export function ensureLifecycleForAssignment(
  store: TaskLifecycleStore,
  taskId: string,
  taskNumber: number,
  frontMatter: TaskFrontMatter,
): void {
  if (store.getLifecycle(taskId)) return;
  store.upsertLifecycle({
    task_id: taskId,
    task_number: taskNumber,
    status: ((frontMatter.status as string | undefined) ?? 'opened') as TaskStatus,
    governed_by: (frontMatter.governed_by as string) || null,
    closed_at: (frontMatter.closed_at as string) || null,
    closed_by: (frontMatter.closed_by as string) || null,
    reopened_at: (frontMatter.reopened_at as string) || null,
    reopened_by: (frontMatter.reopened_by as string) || null,
    continuation_packet_json: null,
    updated_at: nowIso(),
  });
}

export function recordAssignmentIntentApplied(
  cwd: string,
  requestId: string,
  updates: {
    lifecycleStatusAfter: string | null;
    rosterStatusAfter: string | null;
    confirmation: Record<string, unknown>;
    assignmentId?: string | null;
    warnings?: string[];
  },
): void {
  const store = openTaskLifecycleStore(cwd);
  try {
    const existing = store.getAssignmentIntent(requestId);
    if (!existing) return;
    store.upsertAssignmentIntent({
      ...existing,
      status: 'applied',
      assignment_id: updates.assignmentId ?? existing.assignment_id,
      lifecycle_status_after: updates.lifecycleStatusAfter,
      roster_status_after: updates.rosterStatusAfter,
      confirmation_json: JSON.stringify(updates.confirmation),
      warnings_json: updates.warnings && updates.warnings.length > 0 ? JSON.stringify(updates.warnings) : existing.warnings_json,
      updated_at: nowIso(),
    });
  } finally {
    store.db.close();
  }
}

export function recordAssignmentIntentFailed(cwd: string, requestId: string, error: string): void {
  const store = openTaskLifecycleStore(cwd);
  try {
    const existing = store.getAssignmentIntent(requestId);
    if (!existing) return;
    store.upsertAssignmentIntent({
      ...existing,
      status: 'failed',
      rejection_reason: error,
      updated_at: nowIso(),
    });
  } finally {
    store.db.close();
  }
}
