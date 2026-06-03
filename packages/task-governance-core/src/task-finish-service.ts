import { resolve } from 'node:path';
import {
  findTaskFile,
  inspectTaskEvidence,
  listReportsForTask,
  listReviewsForTask,
  readTaskFile,
  writeTaskProjection,
  updateAgentRosterEntry,
  type WorkResultReport,
  type ReviewRecord,
  type TaskCompletionEvidence,
} from './task-governance.js';
import { admitTaskEvidence } from './evidence-admission.js';
import { closeTaskService } from './task-close-service.js';
import { parseTaskSpecFromMarkdown, extractProjectionSections, renderTaskBodyFromSpec } from './task-spec.js';
import { openTaskLifecycleStore, type TaskLifecycleStore } from './task-lifecycle-store.js';
import { ExitCode } from './exit-codes.js';
import { reportTaskService, type ReportTaskServiceOptions, type ReportTaskServiceResult } from './task-report-service.js';
import {
  GENERATED_ARTIFACT_AUTHORITY_NOTE,
  reviewTaskService,
  type GeneratedArtifactAuthorityNote,
  type ReviewTaskServiceOptions,
} from './task-review-service.js';

export interface FinishTaskServiceOptions {
  taskNumber?: string;
  agent?: string;
  reviewer?: string;
  summary?: string;
  directiveId?: string;
  changedFiles?: string;
  verification?: string;
  residuals?: string;
  verdict?: 'accepted' | 'accepted_with_notes' | 'rejected';
  findings?: string;
  report?: string;
  allowIncomplete?: boolean;
  close?: boolean;
  proveCriteria?: boolean;
  cwd?: string;
  store?: TaskLifecycleStore;
}

export interface FinishTaskServiceResponse {
  exitCode: ExitCode;
  result: {
    status: 'success' | 'incomplete' | 'error';
    completion_mode: 'review' | 'report';
    task_id: string;
    agent_id: string;
    report_action: 'submitted' | 'reused' | 'skipped';
    review_action: 'submitted' | 'reused' | 'skipped';
    report_id: string | null;
    review_id: string | null;
    evidence_verdict: TaskCompletionEvidence['verdict'];
    roster_transition: 'done' | 'blocked';
    roster_data?: {
      status?: string;
      warnings?: string[];
      allow_incomplete?: boolean;
      roster_updated_at?: string;
    };
    close_action: 'closed' | 'blocked' | 'skipped';
    criteria_proof_action: 'proved' | 'skipped' | 'blocked';
    evidence_id?: string;
    admission_id?: string;
    close_blockers?: string[];
    criteria_proof_blockers?: string[];
    review_reuse_posture?: 'reused_valid_acceptance' | 'reused_rejection' | 'submitted_superseding_stale_rejection';
    ignored_review_ids?: string[];
    warnings?: string[];
    allow_incomplete?: boolean;
    error?: string;
    evidence_warnings?: string[];
    generated_artifact_authority_note?: GeneratedArtifactAuthorityNote;
    report_status?: WorkResultReport['report_status'];
    ready_for_review?: boolean;
    new_status?: string;
    assignment_id?: string;
    obligation_id?: string | null;
    evidence_posture?: 'reported_with_incomplete_task_evidence';
    evidence_blockers?: string[];
  };
}

function parseVerification(value: string | undefined): { exitCode: ExitCode; error?: string } | { ok: true; value: Array<{ command: string; result: string }> } {
  if (!value) {
    return { ok: true, value: [] };
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return { exitCode: ExitCode.GENERAL_ERROR, error: 'Verification must be a JSON array' };
    }
    return { ok: true, value: parsed as Array<{ command: string; result: string }> };
  } catch {
    return { exitCode: ExitCode.GENERAL_ERROR, error: 'Failed to parse verification JSON' };
  }
}

function parseJsonStringList(value: string | undefined): { exitCode: ExitCode; error?: string } | { ok: true; value: string[] } {
  if (!value) {
    return { ok: true, value: [] };
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return { exitCode: ExitCode.GENERAL_ERROR, error: 'Expected a JSON array' };
    }
    if (!parsed.every((entry) => typeof entry === 'string')) {
      return { exitCode: ExitCode.GENERAL_ERROR, error: 'Expected a JSON array of strings' };
    }
    return { ok: true, value: parsed as string[] };
  } catch {
    return { exitCode: ExitCode.GENERAL_ERROR, error: 'Failed to parse JSON array' };
  }
}

function isAcceptedReview(review: ReviewRecord): boolean {
  return review.verdict === 'accepted' || review.verdict === 'accepted_with_notes';
}

function isRejectedReview(review: ReviewRecord): boolean {
  return review.verdict === 'rejected';
}

function newestFirst(a: { reviewed_at: string; review_id: string }, b: { reviewed_at: string; review_id: string }): number {
  const time = b.reviewed_at.localeCompare(a.reviewed_at);
  return time !== 0 ? time : b.review_id.localeCompare(a.review_id);
}

function reviewMatchesRequestedVerdict(
  review: ReviewRecord,
  verdict?: FinishTaskServiceOptions['verdict'],
): boolean {
  if (!verdict) return isAcceptedReview(review);
  if (verdict === 'rejected') return isRejectedReview(review);
  return isAcceptedReview(review);
}

async function proveCriteriaInService(params: {
  taskNumber: string;
  taskFileId: string;
  by: string;
  cwd: string;
  store: ReturnType<typeof openTaskLifecycleStore>;
}): Promise<{ blockers: string[] }> {
  const { taskNumber, taskFileId, by, cwd, store } = params;
  const taskNum = Number(taskNumber);
  const { frontMatter, body } = await (await import('./task-governance.js')).readTaskFile(
    (await import('node:path')).join(cwd, '.ai', 'do-not-open', 'tasks', `${taskFileId}.md`),
  );
  const spec = parseTaskSpecFromMarkdown({
    taskId: taskFileId,
    taskNumber: taskNum,
    frontMatter,
    body,
  });

  const taskSpec = spec;
  if (!store.getLifecycleByNumber(taskNum) && !store.getLifecycle(taskFileId)) {
    store.upsertLifecycle({
      task_id: taskFileId,
      task_number: taskNum,
      status: frontMatter.status as never,
      governed_by: typeof frontMatter.governed_by === 'string' ? frontMatter.governed_by : null,
      closed_at: typeof frontMatter.closed_at === 'string' ? frontMatter.closed_at : null,
      closed_by: typeof frontMatter.closed_by === 'string' ? frontMatter.closed_by : null,
      reopened_at: typeof frontMatter.reopened_at === 'string' ? frontMatter.reopened_at : null,
      reopened_by: typeof frontMatter.reopened_by === 'string' ? frontMatter.reopened_by : null,
      continuation_packet_json: null,
      closure_mode: typeof frontMatter.closure_mode === 'string' ? frontMatter.closure_mode as never : null,
      updated_at: new Date().toISOString(),
    });
  }

  const specRow = store.getTaskSpecByNumber(taskNum) ?? store.getTaskSpec(taskFileId);
  if (!specRow) {
    store.upsertTaskSpec({
      task_id: taskFileId,
      task_number: taskNum,
      title: taskSpec.title,
      chapter_markdown: taskSpec.chapter,
      goal_markdown: taskSpec.goal,
      context_markdown: taskSpec.context,
      required_work_markdown: taskSpec.required_work,
      non_goals_markdown: taskSpec.non_goals,
      acceptance_criteria_json: JSON.stringify(taskSpec.acceptance_criteria),
      dependencies_json: JSON.stringify(taskSpec.dependencies),
      updated_at: taskSpec.updated_at,
    });
  }

  const criteria = taskSpec.acceptance_criteria;
  if (criteria.length === 0) {
    return { blockers: ['Task has no acceptance criteria to prove'] };
  }

  const projection = extractProjectionSections(body);
  const newBody = renderTaskBodyFromSpec({
    spec: {
      title: taskSpec.title,
      chapter: taskSpec.chapter,
      goal: taskSpec.goal,
      context: taskSpec.context,
      required_work: taskSpec.required_work,
      non_goals: taskSpec.non_goals,
      acceptance_criteria: criteria,
    },
    executionNotes: projection.executionNotes,
    verification: projection.verification,
    acceptanceCriteriaState: criteria.map((text) => ({ text, checked: true })),
  });

  await writeTaskProjection(
    (await import('node:path')).join(cwd, '.ai', 'do-not-open', 'tasks', `${taskFileId}.md`),
    {
      ...frontMatter,
      criteria_proved_by: by,
      criteria_proved_at: new Date().toISOString(),
      criteria_proof_verification: { state: 'unbound', rationale: 'proof via task finish' },
    },
    newBody,
  );

  const admission = await admitTaskEvidence({
    cwd,
    taskNumber: taskNum,
    admittedBy: by,
    methods: ['criteria_proof'],
    store,
  });

  if (admission.blockers.length === 0) {
    return { blockers: [] };
  }
  return { blockers: admission.blockers };
}

async function markRosterDoneForFinish(params: {
  cwd: string;
  taskNumber: string;
  agentId: string;
  allowIncomplete?: boolean;
  taskEvidence?: TaskCompletionEvidence;
}): Promise<{ exitCode: ExitCode; warnings: string[]; result: { status: string; agent_status: string; last_done: number; warnings?: string[]; allow_incomplete?: boolean } }> {
  const { cwd, taskNumber, agentId, allowIncomplete, taskEvidence } = params;
  const evidence = taskEvidence ?? (await inspectTaskEvidence(cwd, taskNumber));

  const warnings: string[] = [];

  if (!evidence) {
    warnings.push(`Task ${taskNumber} evidence could not be inspected. Roster done marks only agent availability, not task completion.`);
  } else {
    const reports = evidence.task_id ? await listReportsForTask(cwd, evidence.task_id) : [];
    const reviews = evidence.task_id ? await listReviewsForTask(cwd, evidence.task_id) : [];
    const hasAgentReport = reports.some((report: WorkResultReport) => report.agent_id === agentId);
    const hasAgentReview = reviews.some((review: ReviewRecord) => review.reviewer_agent_id === agentId);
    const completionSatisfied = evidence.verdict === 'complete' || hasAgentReport || hasAgentReview;

    if (!completionSatisfied) {
      if (!evidence.has_report && !evidence.has_execution_notes) {
        warnings.push(`Task ${taskNumber} has no execution evidence; roster done marks only agent availability, not task completion.`);
      }
      if (evidence.unchecked_count > 0) {
        warnings.push(`Task ${taskNumber} has ${evidence.unchecked_count} unchecked acceptance criteria.`);
      }
      if (!evidence.has_verification) {
        warnings.push(`Task ${taskNumber} has no verification notes.`);
      }
      if (evidence.verdict === 'needs_review' && !evidence.has_review) {
        warnings.push(`Task ${taskNumber} still requires review before it is complete.`);
      }
      if (evidence.verdict === 'needs_closure') {
        warnings.push(`Task ${taskNumber} is not complete by evidence and still needs closure repair.`);
      }
    }
  }

  const shouldFail = warnings.length > 0 && !allowIncomplete;
  if (shouldFail) {
      return {
        exitCode: ExitCode.GENERAL_ERROR,
        warnings,
        result: {
          status: 'error',
          agent_status: 'error',
          last_done: Number(taskNumber),
          warnings,
          allow_incomplete: false,
        },
      };
  }

  await updateAgentRosterEntry(cwd, agentId, {
    status: 'done',
    task: null,
    last_done: Number(taskNumber),
  });

    return {
      exitCode: ExitCode.SUCCESS,
      warnings,
      result: {
        status: 'ok',
        agent_status: 'done',
        last_done: Number(taskNumber),
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(allowIncomplete ? { allow_incomplete: true } : {}),
      },
    };
}

export async function finishTaskService(
  options: FinishTaskServiceOptions,
): Promise<FinishTaskServiceResponse> {
  const cwd = options.cwd ? resolve(options.cwd) : process.cwd();
  const taskNumber = options.taskNumber;
  const agentId = options.agent;

  if (!taskNumber) {
    return {
      exitCode: ExitCode.GENERAL_ERROR,
      result: { status: 'error', completion_mode: 'report', task_id: '', agent_id: agentId ?? '', report_action: 'skipped', review_action: 'skipped', report_id: null, review_id: null, evidence_verdict: 'unknown', roster_transition: 'blocked', close_action: 'skipped', criteria_proof_action: 'skipped', error: 'Task number is required' },
    };
  }

  if (!agentId) {
    return {
      exitCode: ExitCode.GENERAL_ERROR,
      result: { status: 'error', completion_mode: 'report', task_id: '', agent_id: '', report_action: 'skipped', review_action: 'skipped', report_id: null, review_id: null, evidence_verdict: 'unknown', roster_transition: 'blocked', close_action: 'skipped', criteria_proof_action: 'skipped', error: '--agent is required' },
    };
  }

  let taskFile;
  try {
    taskFile = await findTaskFile(cwd, taskNumber);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      exitCode: ExitCode.GENERAL_ERROR,
      result: { status: 'error', completion_mode: 'report', task_id: '', agent_id: agentId, report_action: 'skipped', review_action: 'skipped', report_id: null, review_id: null, evidence_verdict: 'unknown', roster_transition: 'blocked', close_action: 'skipped', criteria_proof_action: 'skipped', error: msg },
    };
  }

  if (!taskFile) {
    return {
      exitCode: ExitCode.INVALID_CONFIG,
      result: { status: 'error', completion_mode: 'report', task_id: '', agent_id: agentId, report_action: 'skipped', review_action: 'skipped', report_id: null, review_id: null, evidence_verdict: 'unknown', roster_transition: 'blocked', close_action: 'skipped', criteria_proof_action: 'skipped', error: `Task not found: ${taskNumber}` },
    };
  }

  const { frontMatter } = await readTaskFile(taskFile.path);
  const statusStore = options.store ?? openTaskLifecycleStore(cwd);
  const ownsStatusStore = options.store ? null : statusStore;
  let taskStatus = frontMatter.status as string | undefined;
  try {
    const lifecycle = statusStore.getLifecycle(taskFile.taskId) ?? statusStore.getLifecycleByNumber(Number(taskNumber));
    taskStatus = lifecycle?.status ?? taskStatus;
  } finally {
    if (ownsStatusStore) ownsStatusStore.db.close();
  }

  let reportAction: 'submitted' | 'reused' | 'skipped' = 'skipped';
  let reviewAction: 'submitted' | 'reused' | 'skipped' = 'skipped';
  let reportId: string | null = null;
  let reviewId: string | null = null;
  let reviewReusePosture: FinishTaskServiceResponse['result']['review_reuse_posture'];
  let ignoredReviewIds: string[] = [];
  let criteriaProofAction: 'proved' | 'skipped' | 'blocked' = 'skipped';
  let criteriaProofBlockers: string[] = [];
  let submittedReportResult: ReportTaskServiceResult | null = null;

  const existingReviews = await listReviewsForTask(cwd, taskFile.taskId);
  const existingReports = await listReportsForTask(cwd, taskFile.taskId);
  const myReviews = existingReviews
    .filter((review) => review.reviewer_agent_id === agentId)
    .sort(newestFirst);
  const validReviewVerdicts = ['accepted', 'accepted_with_notes', 'rejected'] as const;
  if (options.verdict !== undefined && !(validReviewVerdicts as readonly string[]).includes(options.verdict)) {
    return {
      exitCode: ExitCode.GENERAL_ERROR,
      result: {
        status: 'error',
        completion_mode: taskStatus === 'claimed' ? 'report' : 'review',
        task_id: taskFile.taskId,
        agent_id: agentId,
        report_action: reportAction,
        review_action: reviewAction,
        report_id: null,
        review_id: null,
        evidence_verdict: 'unknown',
        roster_transition: 'blocked',
        close_action: 'skipped',
        criteria_proof_action: 'skipped',
        error: 'invalid_finish_verdict',
        invalid_verdict: options.verdict,
        valid_review_verdicts: [...validReviewVerdicts],
        remediation: 'For claimed-state finish, run without verdict and provide summary plus changed_files or no_files_changed. For review-state finish, use accepted, accepted_with_notes, or rejected.',
      } as FinishTaskServiceResponse['result'],
    };
  }
  const reusableReview = myReviews.find((review) => reviewMatchesRequestedVerdict(review, options.verdict));
  const staleRejectedReviews = myReviews.filter(isRejectedReview);
  const myReport = existingReports.find((report) => report.agent_id === agentId);
  const completionMode = options.verdict !== undefined || Boolean(reusableReview) || (!myReport && taskStatus === 'in_review')
    ? 'review'
    : 'report';

  if (completionMode === 'review') {
    if (reusableReview) {
      reviewAction = 'reused';
      reviewId = reusableReview.review_id;
      reviewReusePosture = isAcceptedReview(reusableReview)
        ? 'reused_valid_acceptance'
        : 'reused_rejection';
    } else {
      if (taskStatus !== 'in_review') {
        return {
          exitCode: ExitCode.GENERAL_ERROR,
          result: {
            status: 'error',
            completion_mode: 'review',
            task_id: taskFile.taskId,
            agent_id: agentId,
            report_action: reportAction,
            review_action: reviewAction,
            report_id: null,
            review_id: null,
            evidence_verdict: 'unknown',
            roster_transition: 'blocked',
            close_action: 'skipped',
            criteria_proof_action: 'skipped',
            error: `Task ${taskFile.taskId} is in status '${taskStatus ?? 'missing'}'; review finish requires in_review.`,
          },
        };
      }
      if (!options.verdict) {
        return {
          exitCode: ExitCode.GENERAL_ERROR,
          result: {
            status: 'error',
            completion_mode: 'review',
            task_id: taskFile.taskId,
            agent_id: agentId,
            report_action: reportAction,
            review_action: reviewAction,
            report_id: null,
            review_id: null,
            evidence_verdict: 'unknown',
            roster_transition: 'blocked',
            close_action: 'skipped',
            criteria_proof_action: 'skipped',
            error: 'Review finish requires --verdict (accepted, accepted_with_notes, or rejected)',
          },
        };
      }

      const reviewResult = await reviewTaskService({
        taskNumber,
        agent: agentId,
        verdict: options.verdict,
        findings: options.findings,
        report: options.report,
        cwd,
        store: options.store,
      });
      if (reviewResult.exitCode !== ExitCode.SUCCESS) {
        return {
          exitCode: reviewResult.exitCode,
          result: {
            status: 'error',
            completion_mode: 'review',
            task_id: taskFile.taskId,
            agent_id: agentId,
            report_action: reportAction,
            review_action: reviewAction,
            report_id: null,
            review_id: null,
            evidence_verdict: 'unknown',
            roster_transition: 'blocked',
            close_action: 'skipped',
            criteria_proof_action: 'skipped',
            error: (reviewResult.result as { error?: string })?.error,
          },
        };
      }
      reviewAction = 'submitted';
      reviewId = (reviewResult.result as { review_id?: string }).review_id ?? null;
      ignoredReviewIds = options.verdict && options.verdict !== 'rejected'
        ? staleRejectedReviews.map((review) => review.review_id)
        : [];
      if (ignoredReviewIds.length > 0) {
        reviewReusePosture = 'submitted_superseding_stale_rejection';
      }
    }
    reportAction = myReport ? 'reused' : 'skipped';
    reportId = myReport?.report_id ?? null;
  } else {
    if (myReport) {
      reportAction = 'reused';
      reportId = myReport.report_id;
    } else if (taskStatus === 'claimed') {
      if (!options.summary) {
        return {
          exitCode: ExitCode.GENERAL_ERROR,
          result: {
            status: 'error',
            completion_mode: 'report',
            task_id: taskFile.taskId,
            agent_id: agentId,
            report_action: reportAction,
            review_action: reviewAction,
            report_id: null,
            review_id: null,
            evidence_verdict: 'unknown',
            roster_transition: 'blocked',
            close_action: 'skipped',
            criteria_proof_action: 'skipped',
            error: 'Report finish requires --summary when no report exists. Run with --summary, changed-files, verification, and residuals.',
          },
        };
      }
      const parsedVerification = parseVerification(options.verification);
      if ('exitCode' in parsedVerification) {
        return {
          exitCode: parsedVerification.exitCode,
          result: {
            status: 'error',
            completion_mode: 'report',
            task_id: taskFile.taskId,
            agent_id: agentId,
            report_action: reportAction,
            review_action: reviewAction,
            report_id: null,
            review_id: null,
            evidence_verdict: 'unknown',
            roster_transition: 'blocked',
            close_action: 'skipped',
            criteria_proof_action: 'skipped',
            error: parsedVerification.error,
          },
        };
      }

      if (options.proveCriteria) {
        const proofStore = options.store ?? openTaskLifecycleStore(cwd);
        const proofOwn = options.store ? null : proofStore;
        try {
          const proofResult = await proveCriteriaInService({
            taskNumber,
            taskFileId: taskFile.taskId,
            by: agentId,
            cwd,
            store: proofStore,
          });
          if (proofResult.blockers.length === 0) {
            criteriaProofAction = 'proved';
          } else {
            criteriaProofAction = 'blocked';
            criteriaProofBlockers = proofResult.blockers;
          }
        } finally {
          if (proofOwn) proofOwn.db.close();
        }
      }

      const reportResult = await reportTaskService({
        taskNumber,
        agent: agentId,
        reviewer: options.reviewer,
        summary: options.summary,
        directiveId: options.directiveId,
        changedFiles: options.changedFiles,
        verification: JSON.stringify(parsedVerification.value),
        residuals: options.residuals,
        cwd,
        store: options.store,
      } as ReportTaskServiceOptions);
      if (reportResult.exitCode !== ExitCode.SUCCESS) {
        return {
          exitCode: reportResult.exitCode,
          result: {
            status: 'error',
            completion_mode: 'report',
            task_id: taskFile.taskId,
            agent_id: agentId,
            report_action: reportAction,
            review_action: reviewAction,
            report_id: null,
            review_id: null,
            evidence_verdict: 'unknown',
            roster_transition: 'blocked',
            close_action: 'skipped',
            criteria_proof_action: 'skipped',
            error: (reportResult.result as { error?: string })?.error,
          },
        };
      }
      reportAction = 'submitted';
      reportId = (reportResult.result as { report_id?: string }).report_id ?? null;
      submittedReportResult = reportResult.result;
    } else if (taskStatus === 'in_review') {
      reportAction = 'skipped';
    } else {
      return {
        exitCode: ExitCode.GENERAL_ERROR,
        result: {
          status: 'error',
          completion_mode: 'report',
          task_id: taskFile.taskId,
          agent_id: agentId,
          report_action: reportAction,
          review_action: reviewAction,
          report_id: null,
          review_id: null,
          evidence_verdict: 'unknown',
          roster_transition: 'blocked',
          close_action: 'skipped',
          criteria_proof_action: 'skipped',
          error: `Task ${taskFile.taskId} is in status '${taskStatus ?? 'missing'}'; cannot finish from this state.`,
        },
      };
    }
    reviewAction = reusableReview ? 'reused' : 'skipped';
    reviewId = reusableReview?.review_id ?? null;
    if (reusableReview) {
      reviewReusePosture = isAcceptedReview(reusableReview)
        ? 'reused_valid_acceptance'
        : 'reused_rejection';
    }
  }

  let evidence = await inspectTaskEvidence(cwd, taskNumber, options.store);

  if (options.proveCriteria && criteriaProofAction === 'skipped') {
    const proofStore = options.store ?? openTaskLifecycleStore(cwd);
    const proofOwn = options.store ? null : proofStore;
    try {
      const proofResult = await proveCriteriaInService({
        taskNumber,
        taskFileId: taskFile.taskId,
        by: agentId,
        cwd,
        store: proofStore,
      });
      if (proofResult.blockers.length === 0) {
        criteriaProofAction = 'proved';
        evidence = await inspectTaskEvidence(cwd, taskNumber, options.store);
      } else {
        criteriaProofAction = 'blocked';
        criteriaProofBlockers = proofResult.blockers;
      }
    } finally {
      if (proofOwn) proofOwn.db.close();
    }
  }

  let admissionId: string | null = null;
  let closeAction: 'closed' | 'blocked' | 'skipped' = 'skipped';
  let closeBlockers: string[] = [];

  if (options.close && criteriaProofAction === 'blocked') {
    closeAction = 'blocked';
    closeBlockers = ['Criteria proof failed before evidence admission'];
  } else if (options.close) {
      const admitResult = await admitTaskEvidence({
      taskNumber: Number(taskNumber),
      admittedBy: agentId,
      cwd,
      methods: ['admission'],
      store: options.store,
    });

    if (admitResult.result.verdict !== 'admitted') {
      closeAction = 'blocked';
      closeBlockers = admitResult.blockers;
    } else {
      admissionId = admitResult.result.admission_id;
      const closeResult = await closeTaskService({
        taskNumber,
        by: agentId,
        cwd,
        mode: 'agent_finish',
        store: options.store,
      });

      if (closeResult.exitCode === ExitCode.SUCCESS) {
        closeAction = 'closed';
        evidence = await inspectTaskEvidence(cwd, taskNumber, options.store);
      } else {
        closeAction = 'blocked';
        closeBlockers = (closeResult.result as { gate_failures?: string[]; error?: string }).gate_failures
          ?? [(closeResult.result as { error?: string }).error ?? 'Lifecycle close failed'];
      }
    }
  }

  const evidenceForRoster = evidence;
  const rosterResult = await markRosterDoneForFinish({
    cwd,
    taskNumber,
    agentId,
    allowIncomplete: options.allowIncomplete,
    taskEvidence: evidenceForRoster,
  });

  if (rosterResult.exitCode !== ExitCode.SUCCESS && !options.allowIncomplete) {
    return {
      exitCode: rosterResult.exitCode,
      result: {
        status: 'error',
        completion_mode: completionMode,
        task_id: taskFile.taskId,
        agent_id: agentId,
        report_action: reportAction,
        review_action: reviewAction,
        report_id: reportId,
        review_id: reviewId,
        evidence_verdict: evidence.verdict,
        roster_transition: 'blocked',
        close_action: closeAction,
        criteria_proof_action: criteriaProofAction,
        ...(admissionId ? { admission_id: admissionId } : {}),
        ...(closeBlockers.length > 0 ? { close_blockers: closeBlockers } : {}),
        ...(criteriaProofBlockers.length > 0 ? { criteria_proof_blockers: criteriaProofBlockers } : {}),
        warnings: rosterResult.warnings,
      },
    };
  }

  const output: FinishTaskServiceResponse['result'] = {
    status: rosterResult.exitCode === ExitCode.SUCCESS ? 'success' : 'incomplete',
    completion_mode: completionMode,
    task_id: taskFile.taskId,
    agent_id: agentId,
    report_action: reportAction,
    review_action: reviewAction,
    report_id: reportId,
    review_id: reviewId,
    evidence_verdict: evidence.verdict,
    roster_transition: rosterResult.exitCode === ExitCode.SUCCESS ? 'done' : 'blocked',
    close_action: closeAction,
    criteria_proof_action: criteriaProofAction,
    generated_artifact_authority_note: GENERATED_ARTIFACT_AUTHORITY_NOTE,
  };
  if (submittedReportResult) {
    output.report_status = submittedReportResult.report_status;
    output.ready_for_review = submittedReportResult.ready_for_review;
    output.new_status = submittedReportResult.new_status;
    output.assignment_id = submittedReportResult.assignment_id;
    output.obligation_id = submittedReportResult.obligation_id;
    if (submittedReportResult.evidence_posture) {
      output.evidence_posture = submittedReportResult.evidence_posture;
    }
    if (submittedReportResult.evidence_blockers) {
      output.evidence_blockers = submittedReportResult.evidence_blockers;
    }
  }

  if (reviewReusePosture) {
    output.review_reuse_posture = reviewReusePosture;
  }
  if (ignoredReviewIds.length > 0) {
    output.ignored_review_ids = ignoredReviewIds;
  }
  if (admissionId) {
    output.admission_id = admissionId;
  }
  if (closeBlockers.length > 0) {
    output.close_blockers = closeBlockers;
  }
  if (criteriaProofBlockers.length > 0) {
    output.criteria_proof_blockers = criteriaProofBlockers;
  }
  if (rosterResult.warnings.length > 0) {
    output.warnings = rosterResult.warnings;
  }
  if (options.allowIncomplete) {
    output.allow_incomplete = true;
  }
  if (evidence.warnings.length > 0) {
    output.evidence_warnings = evidence.warnings;
  }

  return {
    exitCode: rosterResult.exitCode,
    result: output,
  };
}
