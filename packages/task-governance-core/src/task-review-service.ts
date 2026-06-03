import { resolve } from 'node:path';
import {
  findTaskFile,
  isValidTransition,
  loadAssignment,
  loadReport,
  loadRoster,
  type WorkResultReport,
  readTaskFile,
  saveReport,
  saveReview,
  updateAgentRosterEntry,
  writeTaskProjection,
  type ReviewFinding,
  inspectTaskEvidence,
} from './task-governance.js';
import { admitTaskEvidence } from './evidence-admission.js';
import { openTaskLifecycleStore, type TaskLifecycleStore, type TaskStatus } from './task-lifecycle-store.js';
import { closeTaskService } from './task-close-service.js';
import { ExitCode } from './exit-codes.js';
import { analyzePrototypeClosure, type PrototypeClosurePosture } from './prototype-closure.js';
import {
  explainTaskReviewAuthority,
  hasTaskReviewAuthority,
  reviewerAuthorityRepair,
  type ReviewAuthorityAdmission,
  type ReviewAuthorityRepair,
} from './task-review-authority.js';

export interface ReviewTaskServiceOptions {
  taskNumber?: string;
  agent?: string;
  verdict?: 'accepted' | 'accepted_with_notes' | 'rejected';
  findings?: string;
  report?: string;
  noCapaReason?: string;
  cwd?: string;
  store?: TaskLifecycleStore;
}

export type ReviewFindingPosture = 'blocking' | 'non_blocking' | 'compatibility_only' | 'projection_only';

export type ReviewFindingAuthorityClass =
  | 'lifecycle_authority_defect'
  | 'compatibility_projection_noise'
  | 'review_content';

export interface ReviewFindingDiagnostic {
  index: number;
  severity: ReviewFinding['severity'];
  posture: ReviewFindingPosture;
  authority_class: ReviewFindingAuthorityClass;
  blocking: boolean;
  compatibility_only: boolean;
  projection_only: boolean;
  lifecycle_authority_defect: boolean;
  capa_relevant: boolean;
  triggers: string[];
  reason: string;
}

export interface ReviewDiagnostics {
  findings: ReviewFindingDiagnostic[];
  has_blocking_finding: boolean;
  has_lifecycle_authority_defect: boolean;
  compatibility_projection_only: boolean;
}

export interface ReviewTaskServiceResponse {
  exitCode: ExitCode;
  result: {
    status: 'success' | 'error';
    review_id?: string;
    task_id?: string;
    verdict?: 'accepted' | 'accepted_with_notes' | 'rejected';
    review_verdict_status?: 'accepted' | 'rejected';
    lifecycle_status?: string;
    new_status?: string;
    admission_id?: string;
    close_action?: 'closed' | 'blocked' | 'skipped';
    close_blockers?: string[];
    evidence_blocked?: boolean;
    evidence_reason?: string;
    blocked_rationale?: string;
    next_command?: string;
    capa_recommendation?: {
      recommended: boolean;
      triggers: string[];
      rationale: string;
      next_command?: string;
      no_capa_reason?: string;
    };
    review_diagnostics?: ReviewDiagnostics;
    review_authority_repair?: {
      reason: ReviewAuthorityRepair['reason'];
      commands: string[];
      no_workaround: string;
    };
    review_authority?: ReviewAuthorityAdmission;
    generated_artifact_authority_note?: GeneratedArtifactAuthorityNote;
    closure_posture?: PrototypeClosurePosture | Record<string, unknown>;
    closure_claim?: PrototypeClosurePosture;
    remediation?: string[];
    duty_loop_continuation?: {
      required: boolean;
      reason: string;
      next_command: string;
      terminal: false;
    };
    error?: string;
  };
}

export interface GeneratedArtifactAuthorityNote {
  posture: 'not_self_authorizing';
  message: string;
  generated_artifacts: string[];
  authority_requires: string[];
}

export const GENERATED_ARTIFACT_AUTHORITY_NOTE: GeneratedArtifactAuthorityNote = {
  posture: 'not_self_authorizing',
  message: 'Generated review/report artifacts are not self-authorizing; authority requires lifecycle admission, reviewer identity, task evidence verdict, and closure status.',
  generated_artifacts: ['review_artifact', 'work_result_report', 'evidence_admission'],
  authority_requires: ['lifecycle_admission_rule', 'reviewer_identity', 'task_evidence_verdict', 'closure_status'],
};

const CAPA_TRIGGER_PATTERNS: Array<{ trigger: string; pattern: RegExp }> = [
  { trigger: 'authority_boundary_bug', pattern: /\bauthority\b|\bboundary\b|\billicit crossing\b|\bpermission\b/i },
  { trigger: 'safety_or_secret_boundary_bug', pattern: /\bsecret\b|\bcredential\b|\bsafety\b|\bprivate\b|\btoken\b/i },
  { trigger: 'lifecycle_or_roster_authority_mismatch', pattern: /\blifecycle\b|\broster\b|\bassignment\b|\bclaimed\b|\bclosed\b|\bevidence\b/i },
  { trigger: 'workaround_identity', pattern: /\bworkaround identity\b|\bwrong identity\b|\bimpersonat/i },
  { trigger: 'repeated_operator_correction', pattern: /\brepeated\b|\bagain\b|\boperator correction\b|\brecurr/i },
  { trigger: 'cross_site_recurrence_risk', pattern: /\bcross-site\b|\bacross sites\b|\bfuture sites\b|\brecurrence risk\b/i },
];

const COMPATIBILITY_PROJECTION_PATTERN =
  /\bcompatibility\b|\blegacy\b|\bprojection\b|\bprojection-only\b|\bprojection only\b|\bcompatibility-only\b|\bcompatibility only\b|\broster\.json\b|\blast_done\b/i;
const ROSTER_PROJECTION_PATTERN =
  /\broster\b|\blast_done\b|\bassignment projection\b|\bolder task\b|\bnewer task\b/i;
const PROJECTION_NOISE_PATTERN =
  /\bnoise\b|\bdrift\b|\bprojection-only\b|\bprojection only\b|\bcompatibility-only\b|\bcompatibility only\b|\blegacy roster\b|\blast_done\b.*\b(older|newer)\b|\bolder task\b|\bnewer task\b/i;
const NEGATED_AUTHORITY_DEFECT_PATTERN =
  /\bnot (?:a |an )?(?:lifecycle )?authority defect\b|\bno (?:lifecycle )?authority defect\b/i;
const EXPLICIT_AUTHORITY_DEFECT_PATTERN =
  /\bauthority defect\b|\bauthority mismatch\b|\bboundary mismatch\b|\blifecycle row\b|\btransition defect\b|\badmission defect\b|\badmission mismatch\b|\bclosure artifact\b|\bstate machine\b|\btamper\b|\bcorrupt\b|\billicit crossing\b|\bunauthori[sz]ed\b/i;
const LIFECYCLE_AUTHORITY_PATTERN =
  /\blifecycle\b|\bauthority\b|\bboundary\b|\billicit crossing\b|\bstate machine\b|\bevidence\b|\btamper\b|\bunauthori[sz]ed\b|\bwrong authority\b/i;

function findingText(finding: ReviewFinding): string {
  return `${finding.severity} ${finding.description} ${finding.location ?? ''}`;
}

function triggersForFinding(finding: ReviewFinding): string[] {
  const text = findingText(finding);
  const triggers = new Set<string>();
  for (const item of CAPA_TRIGGER_PATTERNS) {
    if (item.pattern.test(text)) triggers.add(item.trigger);
  }
  return [...triggers].sort();
}

function isCompatibilityProjectionNoise(finding: ReviewFinding): boolean {
  const text = findingText(finding);
  const explicitAuthorityDefect =
    EXPLICIT_AUTHORITY_DEFECT_PATTERN.test(text) && !NEGATED_AUTHORITY_DEFECT_PATTERN.test(text);
  return (
    COMPATIBILITY_PROJECTION_PATTERN.test(text) &&
    ROSTER_PROJECTION_PATTERN.test(text) &&
    PROJECTION_NOISE_PATTERN.test(text) &&
    !explicitAuthorityDefect
  );
}

function classifyReviewFinding(finding: ReviewFinding, index: number): ReviewFindingDiagnostic {
  const blocking = finding.severity === 'blocking';
  const text = findingText(finding);
  const triggers = triggersForFinding(finding);
  const projectionOnly = isCompatibilityProjectionNoise(finding);
  const explicitAuthorityDefect =
    EXPLICIT_AUTHORITY_DEFECT_PATTERN.test(text) && !NEGATED_AUTHORITY_DEFECT_PATTERN.test(text);
  const lifecycleAuthorityDefect = !projectionOnly && explicitAuthorityDefect && LIFECYCLE_AUTHORITY_PATTERN.test(text);
  const compatibilityOnly = projectionOnly || (
    COMPATIBILITY_PROJECTION_PATTERN.test(text) && !lifecycleAuthorityDefect
  );
  const posture: ReviewFindingPosture = projectionOnly
    ? 'projection_only'
    : compatibilityOnly
      ? 'compatibility_only'
      : blocking
        ? 'blocking'
        : 'non_blocking';
  const authorityClass: ReviewFindingAuthorityClass = projectionOnly || compatibilityOnly
    ? 'compatibility_projection_noise'
    : lifecycleAuthorityDefect
      ? 'lifecycle_authority_defect'
      : 'review_content';

  return {
    index,
    severity: finding.severity,
    posture,
    authority_class: authorityClass,
    blocking,
    compatibility_only: compatibilityOnly,
    projection_only: projectionOnly,
    lifecycle_authority_defect: lifecycleAuthorityDefect,
    capa_relevant: !compatibilityOnly && (blocking || lifecycleAuthorityDefect),
    triggers,
    reason: projectionOnly
      ? 'Legacy roster compatibility projection drift is not lifecycle authority.'
      : lifecycleAuthorityDefect
        ? 'Finding names a lifecycle or authority defect.'
        : blocking
          ? 'Blocking finding requires review attention.'
          : 'Finding is review content without authority-defect posture.',
  };
}

function buildReviewDiagnostics(findings: ReviewFinding[]): ReviewDiagnostics {
  const diagnostics = findings.map((finding, index) => classifyReviewFinding(finding, index));
  return {
    findings: diagnostics,
    has_blocking_finding: diagnostics.some((finding) => finding.blocking),
    has_lifecycle_authority_defect: diagnostics.some((finding) => finding.lifecycle_authority_defect),
    compatibility_projection_only: diagnostics.length > 0 && diagnostics.every((finding) => finding.compatibility_only || finding.projection_only),
  };
}

function capaRecommendationForReview(args: {
  verdict: 'accepted' | 'accepted_with_notes' | 'rejected';
  diagnostics: ReviewDiagnostics;
  taskNumber: string;
  noCapaReason?: string;
}): ReviewTaskServiceResponse['result']['capa_recommendation'] | undefined {
  const triggers = new Set<string>();
  if (args.verdict === 'rejected' && args.diagnostics.has_blocking_finding) {
    triggers.add('blocking_rejected_review');
  }
  for (const finding of args.diagnostics.findings) {
    if (!finding.capa_relevant) continue;
    for (const trigger of finding.triggers) triggers.add(trigger);
  }
  if (triggers.size === 0 && !args.noCapaReason) return undefined;
  if (triggers.size === 0 && args.noCapaReason) {
    return {
      recommended: false,
      triggers: [],
      rationale: args.noCapaReason,
      no_capa_reason: args.noCapaReason,
    };
  }
  const rejected = args.verdict === 'rejected';
  return {
    recommended: true,
    triggers: [...triggers].sort(),
    rationale: rejected
      ? 'Rejected review findings indicate recurrence risk; route containment/prevention/verification through CAPA if this is not a one-off local defect.'
      : 'Review findings indicate recurrence risk; route containment/prevention/verification through CAPA if this is not a one-off local defect.',
    next_command: rejected
      ? `narada inbox submit --kind proposal --topic "CAPA for task ${args.taskNumber} review rejection" --payload-file <capa-proposal.json>`
      : `narada inbox submit --kind proposal --topic "CAPA for task ${args.taskNumber} review findings" --payload-file <capa-proposal.json>`,
    ...(args.noCapaReason ? { no_capa_reason: args.noCapaReason } : {}),
  };
}

function reviewerIdentityCapaRecommendation(agentId: string): NonNullable<ReviewTaskServiceResponse['result']['capa_recommendation']> {
  return {
    recommended: true,
    triggers: ['authority_boundary_bug', 'reviewer_identity_mismatch'],
    rationale: `Review requested by ${agentId} could not be admitted under declared review authority; route CAPA if this caused or could cause workaround principal substitution.`,
    next_command: `narada inbox submit --kind proposal --topic "CAPA for reviewer identity mismatch: ${agentId}" --payload-file <capa-proposal.json>`,
  };
}

export async function reviewTaskService(
  options: ReviewTaskServiceOptions,
): Promise<ReviewTaskServiceResponse> {
  const cwd = options.cwd ? resolve(options.cwd) : process.cwd();
  const taskNumber = options.taskNumber;
  const agentId = options.agent;
  const verdict = options.verdict;
  const findingsRaw = options.findings;

  if (!taskNumber) {
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

  if (!verdict) {
    return {
      exitCode: ExitCode.GENERAL_ERROR,
      result: { status: 'error', error: '--verdict is required (accepted, accepted_with_notes, rejected)' },
    };
  }

  const VALID_VERDICTS = ['accepted', 'accepted_with_notes', 'rejected'] as const;
  if (!VALID_VERDICTS.includes(verdict as typeof VALID_VERDICTS[number])) {
    return {
      exitCode: ExitCode.GENERAL_ERROR,
      result: { status: 'error', error: `--verdict must be one of: ${VALID_VERDICTS.join(', ')}` },
    };
  }

  let roster;
  try {
    roster = await loadRoster(cwd);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      exitCode: ExitCode.GENERAL_ERROR,
      result: { status: 'error', error: `Failed to load agent roster: ${msg}` },
    };
  }

  const agent = roster.agents.find((entry) => entry.agent_id === agentId);
  if (!agent) {
    return {
      exitCode: ExitCode.INVALID_CONFIG,
      result: {
        status: 'error',
        error: `Agent not found in roster: ${agentId}`,
        review_authority_repair: reviewerAuthorityRepair({
          taskNumber,
          agentId,
          reason: 'missing_reviewer_identity',
        }),
        capa_recommendation: reviewerIdentityCapaRecommendation(agentId),
      },
    };
  }
  const reviewAuthority = explainTaskReviewAuthority(agent);
  if (!hasTaskReviewAuthority(agent)) {
    return {
      exitCode: ExitCode.GENERAL_ERROR,
      result: {
        status: 'error',
        error: `Agent ${agentId} has role '${agent.role}' without admitted review authority`,
        review_authority: reviewAuthority,
        review_authority_repair: reviewerAuthorityRepair({
          taskNumber,
          agentId,
          reason: 'review_authority_not_admitted',
          role: agent.role,
        }),
        capa_recommendation: reviewerIdentityCapaRecommendation(agentId),
      },
    };
  }

  let taskFile;
  try {
    taskFile = await findTaskFile(cwd, taskNumber);
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

  const { frontMatter, body } = await readTaskFile(taskFile.path);
  const closureClaim = analyzePrototypeClosure(frontMatter, body);
  const ownStore = options.store ? null : openTaskLifecycleStore(cwd);
  const closeOwnStore = () => {
    if (ownStore) ownStore.db.close();
  };
  const store = options.store ?? ownStore ?? undefined;

  let sqliteStatus: string | undefined;
  if (store) {
    let lifecycle = store.getLifecycle(taskFile.taskId);
    if (!lifecycle) {
      const taskNum = Number(taskNumber);
      if (!Number.isFinite(taskNum)) {
        closeOwnStore();
        return {
          exitCode: ExitCode.GENERAL_ERROR,
          result: { status: 'error', error: 'Cannot determine task number for SQLite backfill' },
        };
      }
      store.upsertLifecycle({
        task_id: taskFile.taskId,
        task_number: taskNum,
        status: (frontMatter.status as TaskStatus) || 'opened',
        governed_by: (frontMatter.governed_by as string) || null,
        closed_at: (frontMatter.closed_at as string) || null,
        closed_by: (frontMatter.closed_by as string) || null,
        reopened_at: (frontMatter.reopened_at as string) || null,
        reopened_by: (frontMatter.reopened_by as string) || null,
        continuation_packet_json: null,
        closure_mode: (frontMatter.closure_mode as Parameters<typeof store.upsertLifecycle>[0]['closure_mode']) || null,
        updated_at: new Date().toISOString(),
      });
      lifecycle = store.getLifecycle(taskFile.taskId)!;
    }
    sqliteStatus = lifecycle.status;
  }

  let currentStatus = sqliteStatus ?? (frontMatter.status as string | undefined);
  if (store && sqliteStatus === 'claimed' && frontMatter.status === 'in_review') {
    try {
      store.updateStatus(taskFile.taskId, 'in_review', agentId);
      currentStatus = 'in_review';
    } catch {
      // ignore
    }
  }

  if (currentStatus !== 'in_review') {
    closeOwnStore();
    return {
      exitCode: ExitCode.GENERAL_ERROR,
      result: {
        status: 'error',
        error: `Task ${taskFile.taskId} cannot be reviewed (status: ${currentStatus ?? 'missing'}, expected: in_review)`,
      },
    };
  }

  let newStatus: TaskStatus | 'in_review' = verdict === 'rejected' ? 'opened' : 'closed';
  let evidenceBlocked = false;
  let evidenceReason: string | undefined;

  if (verdict !== 'rejected') {
    const existing = await inspectTaskEvidence(cwd, taskNumber, store);
    if (existing.all_criteria_checked === false) {
      evidenceBlocked = true;
      evidenceReason = `${existing.unchecked_count} acceptance criteria remain unchecked`;
    } else if (!existing.has_report && !existing.has_execution_notes) {
      evidenceBlocked = true;
      evidenceReason = 'Task lacks execution evidence (no report or execution notes)';
    } else if (!existing.has_verification) {
      evidenceBlocked = true;
      evidenceReason = 'Task lacks verification notes';
    } else if (existing.violations.includes('terminal_with_derivative_files')) {
      evidenceBlocked = true;
      evidenceReason = 'Derivative task-status files exist';
    }
    if (evidenceBlocked) {
      newStatus = 'in_review';
    }
  }

  if (newStatus !== currentStatus && !isValidTransition(currentStatus, newStatus)) {
    closeOwnStore();
    return {
      exitCode: ExitCode.GENERAL_ERROR,
      result: {
        status: 'error',
        error: `Transition from '${String(currentStatus)}' to '${newStatus}' is not allowed by the state machine`,
      },
    };
  }

  let findings: ReviewFinding[] = [];
  if (findingsRaw) {
    try {
      const parsed = JSON.parse(findingsRaw) as unknown;
      if (!Array.isArray(parsed)) {
        closeOwnStore();
        return {
          exitCode: ExitCode.GENERAL_ERROR,
          result: { status: 'error', error: 'Findings must be a JSON array' },
        };
      }
      const validSeverities = ['blocking', 'major', 'minor', 'note'] as const;
      for (let i = 0; i < parsed.length; i++) {
        const item = parsed[i];
        if (typeof item !== 'object' || item === null) {
          closeOwnStore();
          return {
            exitCode: ExitCode.GENERAL_ERROR,
            result: { status: 'error', error: `Findings[${i}] is not an object` },
          };
        }
        const finding = item as Record<string, unknown>;
        if (!validSeverities.includes(finding.severity as typeof validSeverities[number])) {
          closeOwnStore();
          return {
            exitCode: ExitCode.GENERAL_ERROR,
            result: {
              status: 'error',
              error: `Findings[${i}].severity must be one of: ${validSeverities.join(', ')}`,
            },
          };
        }
        if (typeof finding.description !== 'string') {
          closeOwnStore();
          return {
            exitCode: ExitCode.GENERAL_ERROR,
            result: {
              status: 'error',
              error: `Findings[${i}].description must be a string`,
            },
          };
        }
        if (finding.location !== undefined && finding.location !== null && typeof finding.location !== 'string') {
          closeOwnStore();
          return {
            exitCode: ExitCode.GENERAL_ERROR,
            result: {
              status: 'error',
              error: `Findings[${i}].location must be a string or null`,
            },
          };
        }
      }
      findings = parsed as ReviewFinding[];
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      closeOwnStore();
      return {
        exitCode: ExitCode.GENERAL_ERROR,
        result: { status: 'error', error: `Failed to parse findings: ${msg}` },
      };
    }
  }
  const reviewDiagnostics = buildReviewDiagnostics(findings);

  let linkedReport = null;
  if (options.report) {
    linkedReport = await loadReport(cwd, options.report);
    if (!linkedReport) {
      closeOwnStore();
      return {
        exitCode: ExitCode.INVALID_CONFIG,
        result: { status: 'error', error: `Report not found: ${options.report}` },
      };
    }
    if (linkedReport.task_id !== taskFile.taskId) {
      closeOwnStore();
      return {
        exitCode: ExitCode.GENERAL_ERROR,
        result: {
          status: 'error',
          error: `Report ${options.report} belongs to task ${linkedReport.task_id}, not ${taskFile.taskId}`,
        },
      };
    }
  }

  const now = new Date().toISOString();
  const reviewId = `review-${taskFile.taskId}-${Date.now()}`;
  const reviewRecord = {
    review_id: reviewId,
    reviewer_agent_id: agentId,
    task_id: taskFile.taskId,
    findings,
    verdict,
    reviewed_at: now,
    report_id: options.report ?? null,
  };

  if (store) {
    store.insertReview({
      review_id: reviewId,
      reviewer_agent_id: agentId,
      task_id: taskFile.taskId,
      findings_json: findings.length > 0 ? JSON.stringify(findings) : null,
      verdict: verdict === 'accepted_with_notes' ? 'accepted' : verdict,
      reviewed_at: now,
    });
  } else {
    await saveReview(cwd, reviewRecord);
  }

  const admission = await admitTaskEvidence({
    cwd,
    taskNumber: Number(taskNumber),
    admittedBy: agentId,
    methods: ['review'],
    requireReview: verdict !== 'rejected',
    store,
  });

  if (verdict !== 'rejected' && admission.result.verdict === 'rejected') {
    evidenceBlocked = true;
    evidenceReason = admission.blockers.join('; ');
    newStatus = 'needs_continuation';
  }

  if (store && newStatus === 'opened') {
    try {
      store.updateStatus(taskFile.taskId, 'opened', agentId);
    } catch {
      // fallback through projection if needed
      frontMatter.status = 'opened';
      await writeTaskProjection(taskFile.path, frontMatter, body);
    }
  }

  if (linkedReport) {
    const updatedReport: WorkResultReport = {
      ...linkedReport,
      report_status: verdict === 'rejected' ? 'rejected' : 'accepted',
    };
    if (store) {
      const existing = store.getReportRecord(linkedReport.report_id);
      if (existing) {
        try {
          const parsed = JSON.parse(existing.report_json) as WorkResultReport;
          const next = {
            ...parsed,
            report_status: updatedReport.report_status,
          };
          store.upsertReportRecord({
            task_id: next.task_id,
            report_id: next.report_id,
            report_json: JSON.stringify(next),
          } as Parameters<typeof store.upsertReportRecord>[0]);
        } catch {
          await saveReport(cwd, updatedReport);
        }
      } else {
        await saveReport(cwd, updatedReport);
      }
    } else {
      await saveReport(cwd, updatedReport);
    }
  }

  let closeAction: 'closed' | 'blocked' | 'skipped' = 'skipped';
  let closeBlockers: string[] = [];
  let resultNextCommandFromClose: string | undefined;
  let resultRemediationFromClose: string[] | undefined;

  if (newStatus === 'closed') {
    const closeResult = await closeTaskService({
      taskNumber,
      by: agentId,
      cwd,
      store,
      mode: 'peer_reviewed',
    });
    if (closeResult.exitCode === ExitCode.SUCCESS) {
      closeAction = 'closed';
    } else {
      closeAction = 'blocked';
      newStatus = 'in_review';
      evidenceBlocked = true;
      const blockedResult = closeResult.result as { gate_failures?: string[]; error?: string; remediation?: string[]; repair_command?: string; next_command?: string; closure_posture?: { next_command?: string } };
      closeBlockers = blockedResult.gate_failures ?? [blockedResult.error ?? 'Lifecycle close failed'];
      evidenceReason = closeBlockers.join('; ');
      const remediationTaskCommand = blockedResult.remediation
        ?.map((line) => line.replace(/^  ->\s*/, ''))
        .map((line) => {
          const commandIndex = line.indexOf('narada task ');
          return commandIndex >= 0 ? line.slice(commandIndex) : line;
        })
        .find((line) => line.startsWith('narada task '));
      const blockedNextCommand = blockedResult.next_command ?? blockedResult.repair_command ?? blockedResult.closure_posture?.next_command ?? remediationTaskCommand;
      if (blockedNextCommand) {
        resultNextCommandFromClose = blockedNextCommand;
      }
      resultRemediationFromClose = blockedResult.remediation;
    }
  } else {
    const nextFrontMatter = { ...frontMatter, status: newStatus } as typeof frontMatter;
    await writeTaskProjection(taskFile.path, nextFrontMatter, body);
    if (store) {
      store.updateStatus(taskFile.taskId, newStatus as Parameters<typeof store.updateStatus>[1], agentId);
    }
  }

  await updateAgentRosterEntry(cwd, agentId, {});

  const result: ReviewTaskServiceResponse['result'] = {
    status: 'success',
    review_id: reviewId,
    task_id: taskFile.taskId,
    verdict,
    review_verdict_status: verdict === 'rejected' ? 'rejected' : 'accepted',
    lifecycle_status: newStatus,
    new_status: newStatus,
    admission_id: admission.result.admission_id,
    close_action: closeAction,
    review_authority: reviewAuthority,
    generated_artifact_authority_note: GENERATED_ARTIFACT_AUTHORITY_NOTE,
  };
  if (reviewDiagnostics.findings.length > 0) {
    result.review_diagnostics = reviewDiagnostics;
  }

  if (closeBlockers.length > 0) {
    result.close_blockers = closeBlockers;
  }
  if (evidenceBlocked) {
    result.evidence_blocked = true;
    if (evidenceReason) {
      result.evidence_reason = evidenceReason;
      result.blocked_rationale = evidenceReason;
    }
    result.next_command = resultNextCommandFromClose ?? (admission.result.verdict === 'rejected'
      ? `narada task continue ${taskNumber} --agent ${agentId} --reason evidence_repair`
      : `narada task evidence inspect ${taskNumber} --cwd "${cwd}"`);
    if (resultRemediationFromClose?.length) {
      result.remediation = resultRemediationFromClose;
    }
    result.duty_loop_continuation = {
      required: true,
      reason: 'task_review_returned_nonterminal_next_command',
      next_command: result.next_command,
      terminal: false,
    };
    result.closure_posture = admission.result.verdict === 'rejected'
      ? {
          closure_posture: 'repair_required',
          repair_reason: 'accepted_review_failed_evidence_admission',
          residual_crossing_required: true,
          residual_crossing: 'evidence_repair_continuation',
          next_command: `narada task continue ${taskNumber} --agent ${agentId} --reason evidence_repair`,
        }
      : {
          closure_posture: 'blocked',
          repair_reason: 'close_gate_failed',
          residual_crossing_required: true,
          residual_crossing: 'closure_gate_repair',
          next_command: result.next_command,
        };
  }
  if (closureClaim.applies) {
    result.closure_claim = closureClaim;
    if (!result.closure_posture) result.closure_posture = closureClaim;
    if (closureClaim.warning && !result.evidence_reason) {
      result.evidence_reason = closureClaim.warning;
    }
  }
  const capaRecommendation = capaRecommendationForReview({
    verdict,
    diagnostics: reviewDiagnostics,
    taskNumber,
    noCapaReason: options.noCapaReason,
  });
  if (capaRecommendation) {
    result.capa_recommendation = capaRecommendation;
  }
  const consumedObligations: string[] = [];
  if (store) {
    const obligations = store.listDirectedObligationsForTask(taskFile.taskId, 'open')
      .filter((obligation) => obligation.kind === 'review_request')
      .filter((obligation) => (
        obligation.target_agent_id === agentId
        || (!obligation.target_agent_id && obligation.target_role === agent.role)
      ));
    const obligationStatus = verdict === 'rejected' ? 'rejected' : 'completed';
    for (const obligation of obligations) {
      store.transitionDirectedObligation(obligation.obligation_id, obligationStatus, agentId, reviewId);
      consumedObligations.push(obligation.obligation_id);
    }
  }
  if (consumedObligations.length > 0) {
    (result as Record<string, unknown>).directed_obligations = {
      consumed: consumedObligations,
      consumption_ref: reviewId,
      consumption_kind: verdict === 'rejected' ? 'rejection' : 'review_completion',
    };
  }

  closeOwnStore();
  return {
    exitCode: ExitCode.SUCCESS,
    result,
  };
}
