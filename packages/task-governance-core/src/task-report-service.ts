import { resolve, join } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  createReportId,
  findReportByAssignmentId,
  findTaskFile,
  getActiveContinuation,
  loadAssignment,
  loadRoster,
  readTaskFile,
  saveAssignment,
  updateAgentRosterEntry,
  writeTaskProjection,
  isValidTransition,
  type WorkResultReport,
} from './task-governance.js';
import { openTaskLifecycleStore, type TaskLifecycleStore } from './task-lifecycle-store.js';
import { ExitCode } from './exit-codes.js';
import { resolveReviewTargetFromRoster, resolveDefaultReviewerFromRoster, type ResolvedReviewTarget } from './task-review-authority.js';

function readSiteConfigDefaultReviewerRole(cwd: string): string | undefined {
  try {
    const configPath = join(cwd, 'config.json');
    const raw = readFileSync(configPath, 'utf8');
    const config = JSON.parse(raw) as Record<string, unknown>;
    const governance = config?.task_governance as Record<string, unknown> | undefined;
    return typeof governance?.default_reviewer_role === 'string'
      ? governance.default_reviewer_role
      : undefined;
  } catch {
    return undefined;
  }
}

export interface ReportTaskServiceOptions {
  taskNumber?: string;
  agent?: string;
  reviewer?: string;
  summary?: string;
  directiveId?: string;
  changedFiles?: string;
  verification?: string;
  residuals?: string;
  cwd?: string;
  store?: TaskLifecycleStore;
}

export interface ReportTaskServiceResult {
  status: 'success' | 'error';
  report_id?: string;
  task_id?: string;
  agent_id?: string;
  new_status?: string;
  note?: string;
  task_number?: number;
  assignment_id?: string;
  obligation_id?: string | null;
  report_status?: WorkResultReport['report_status'];
  ready_for_review?: boolean;
  evidence_posture?: 'reported_with_incomplete_task_evidence';
  review_target?: {
    requested: string;
    target_agent_id: string | null;
    target_role: string | null;
    resolution: 'agent_id' | 'role_alias';
    review_authority: {
      admitted: true;
      authority_kind?: string;
      rationale: string;
      accepted_capabilities?: string[];
    };
  };
  review_authority_repair?: {
    reason: 'missing_reviewer_identity' | 'review_authority_not_admitted';
    commands: string[];
    no_workaround: string;
  };
  error?: string;
  evidence_blockers?: string[];
  guidance?: never;
}

export interface ReportTaskServiceResponse {
  exitCode: ExitCode;
  result: ReportTaskServiceResult;
}

function sectionBody(markdown: string, heading: string): string | null {
  const headingPattern = new RegExp(`^##\\s+${heading}\\s*$`, 'gim');
  const match = headingPattern.exec(markdown);
  if (!match) return null;

  const start = match.index + match[0].length;
  const rest = markdown.slice(start);
  const nextHeading = rest.search(/^##\s+/m);
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
}

function findTaskEvidenceBlockers(markdown: string): string[] {
  const blockers: string[] = [];
  const acceptanceCriteria = sectionBody(markdown, 'Acceptance Criteria');
  if (acceptanceCriteria && /^\s*-\s*\[\s\]/m.test(acceptanceCriteria)) {
    blockers.push('Acceptance Criteria contains unchecked checklist items.');
  }

  const executionNotes = sectionBody(markdown, 'Execution Notes');
  if (executionNotes?.includes('<!-- Record what was done, decisions made, and files changed. -->')) {
    blockers.push('Execution Notes still contains scaffold placeholder text.');
  }

  const verification = sectionBody(markdown, 'Verification');
  if (verification?.includes('<!-- Record commands run, results observed, and how correctness was checked. -->')) {
    blockers.push('Verification still contains scaffold placeholder text.');
  }

  return blockers;
}

function loadSqlActiveAssignment(cwd: string, taskId: string, providedStore?: TaskLifecycleStore) {
  if (providedStore) {
    return providedStore.getActiveAssignment(taskId) ?? null;
  }
  const store = openTaskLifecycleStore(cwd);
  try {
    return store.getActiveAssignment(taskId) ?? null;
  } finally {
    store.db.close();
  }
}

function loadSqlTaskStatus(cwd: string, taskId: string, taskNumber: string, providedStore?: TaskLifecycleStore): string | undefined {
  if (providedStore) {
    return providedStore.getLifecycle(taskId)?.status
      ?? providedStore.getLifecycleByNumber(Number(taskNumber))?.status;
  }
  const store = openTaskLifecycleStore(cwd);
  try {
    return store.getLifecycle(taskId)?.status
      ?? store.getLifecycleByNumber(Number(taskNumber))?.status;
  } finally {
    store.db.close();
  }
}

function persistReportInStore(store: TaskLifecycleStore, report: WorkResultReport): void {
  store.upsertReportRecord({
    report_id: report.report_id,
    task_id: report.task_id,
    assignment_id: report.assignment_id,
    agent_id: report.agent_id,
    reported_at: report.reported_at,
    report_json: JSON.stringify(report),
  });
  store.insertReport({
    report_id: report.report_id,
    task_id: report.task_id,
    agent_id: report.agent_id,
    summary: report.summary,
    changed_files_json: JSON.stringify(report.changed_files),
    verification_json: JSON.stringify(report.verification),
    directive_id: report.directive_id ?? null,
    submitted_at: report.reported_at,
  });
}

function parseChangedFiles(value: string | undefined): ReportTaskServiceResponse | null | { ok: true; value: string[] } {
  if (!value) {
    return { ok: true, value: [] };
  }

  const trimmed = value.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!Array.isArray(parsed)) {
        return {
          exitCode: ExitCode.GENERAL_ERROR,
          result: { status: 'error', error: 'changed_files must be a JSON array or comma-separated list' },
        };
      }
      for (let i = 0; i < parsed.length; i++) {
        if (typeof parsed[i] !== 'string') {
          return {
            exitCode: ExitCode.GENERAL_ERROR,
            result: { status: 'error', error: `changed_files[${i}] must be a string` },
          };
        }
      }
      return { ok: true, value: parsed as string[] };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        exitCode: ExitCode.GENERAL_ERROR,
        result: { status: 'error', error: `Failed to parse changed files: ${msg}` },
      };
    }
  }

  return {
    ok: true,
    value: trimmed.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0),
  };
}

function parseStringJsonArray(value: string | undefined, label: string): ReportTaskServiceResponse | null | { ok: true; value: string[] } {
  if (!value) {
    return { ok: true, value: [] };
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return {
        exitCode: ExitCode.GENERAL_ERROR,
        result: { status: 'error', error: `${label} must be a JSON array` },
      };
    }
    const list: string[] = [];
    for (let i = 0; i < parsed.length; i++) {
      if (typeof parsed[i] !== 'string') {
        return {
          exitCode: ExitCode.GENERAL_ERROR,
          result: { status: 'error', error: `${label}[${i}] must be a string` },
        };
      }
      list.push(parsed[i] as string);
    }
    return { ok: true, value: list };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      exitCode: ExitCode.GENERAL_ERROR,
      result: { status: 'error', error: `Failed to parse ${label}: ${msg}` },
    };
  }
}

function parseVerification(value: string | undefined): ReportTaskServiceResponse | null | { ok: true; value: Array<{ command: string; result: string }> } {
  if (!value) {
    return { ok: true, value: [] };
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return {
        exitCode: ExitCode.GENERAL_ERROR,
        result: { status: 'error', error: '--verification must be a JSON array' },
      };
    }
    for (let i = 0; i < parsed.length; i++) {
      const item = parsed[i];
      if (typeof item !== 'object' || item === null) {
        return {
          exitCode: ExitCode.GENERAL_ERROR,
          result: {
            status: 'error',
            error: `verification[${i}] is not an object`,
          },
        };
      }
      const record = item as Record<string, unknown>;
      if (typeof record.command !== 'string') {
        return {
          exitCode: ExitCode.GENERAL_ERROR,
          result: {
            status: 'error',
            error: `verification[${i}].command must be a string`,
          },
        };
      }
      if (typeof record.result !== 'string') {
        return {
          exitCode: ExitCode.GENERAL_ERROR,
          result: {
            status: 'error',
            error: `verification[${i}].result must be a string`,
          },
        };
      }
    }
    return { ok: true, value: parsed as Array<{ command: string; result: string }> };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      exitCode: ExitCode.GENERAL_ERROR,
      result: {
        status: 'error',
        error: [
          `Failed to parse verification: ${msg}`,
          'Expected --verification to be a JSON array of {command, result} objects.',
          'Example: --verification \'[{"command":"pnpm verify","result":"passed"}]\'',
        ].join('\n'),
      },
    };
  }
}

function safeIdPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function reviewTargetIdPart(target: ResolvedReviewTarget): string {
  return target.target_agent_id ?? (target.target_role ? `role_${target.target_role}` : 'unknown');
}

function reviewCommandAgentPlaceholder(target: ResolvedReviewTarget): string {
  return target.target_agent_id ?? `<${target.target_role ?? 'reviewer'}-agent>`;
}

function hasDistinctRoleReviewer(args: {
  roster: Awaited<ReturnType<typeof loadRoster>>;
  reporterAgentId: string;
  role: string | null;
  taskNumber: string;
}): boolean {
  if (!args.role) return false;
  return args.roster.agents.some((entry) =>
    entry.agent_id !== args.reporterAgentId
    && entry.role === args.role
    && resolveReviewTargetFromRoster(args.roster, entry.agent_id, { taskNumber: args.taskNumber })?.ok === true
  );
}

function resolveMandatoryReviewTarget(args: {
  roster: Awaited<ReturnType<typeof loadRoster>>;
  requested?: string;
  reporterAgentId: string;
  cwd: string;
  taskNumber: string;
}): ReportTaskServiceResponse | { ok: true; value: ResolvedReviewTarget } {
  const explicit = resolveReviewTargetFromRoster(args.roster, args.requested, { taskNumber: args.taskNumber });
  if (explicit && !explicit.ok) {
    return {
      exitCode: ExitCode.INVALID_CONFIG,
      result: {
        status: 'error',
        error: explicit.error,
        review_authority_repair: explicit.review_authority_repair,
      },
    };
  }
  if (explicit?.ok) {
    const reporter = args.roster.agents.find((entry) => entry.agent_id === args.reporterAgentId);
    const onlyTargetsReporterRole = explicit.target_agent_id === null
      && explicit.target_role === reporter?.role
      && !hasDistinctRoleReviewer({
        roster: args.roster,
        reporterAgentId: args.reporterAgentId,
        role: explicit.target_role,
        taskNumber: args.taskNumber,
      });
    if (explicit.target_agent_id === args.reporterAgentId || onlyTargetsReporterRole) {
      return {
        exitCode: ExitCode.GENERAL_ERROR,
        result: {
          status: 'error',
          error: `Review target ${explicit.requested} resolves only to the reporting agent; self-review is not admitted.`,
          review_authority_repair: {
            reason: 'missing_reviewer_identity',
            commands: [
              `narada task report ${args.taskNumber} --agent ${args.reporterAgentId} --reviewer <distinct-reviewer> ...`,
              `narada task roster add <distinct-reviewer> --role reviewer --capability review`,
            ],
            no_workaround: 'Do not create an unrouted review request or self-review the report.',
          },
        },
      };
    }
    return { ok: true, value: explicit };
  }

  const defaultRole = readSiteConfigDefaultReviewerRole(args.cwd);
  if (defaultRole) {
    const resolved = resolveDefaultReviewerFromRoster(args.roster, defaultRole);
    const reporter = args.roster.agents.find((entry) => entry.agent_id === args.reporterAgentId);
    const roleHasDistinctReviewer = resolved.ok
      ? hasDistinctRoleReviewer({
          roster: args.roster,
          reporterAgentId: args.reporterAgentId,
          role: resolved.target_role,
          taskNumber: args.taskNumber,
        })
      : false;
    if (
      resolved.ok
      && (
        resolved.target_agent_id !== args.reporterAgentId
        || (resolved.target_agent_id === null && resolved.target_role !== reporter?.role)
        || roleHasDistinctReviewer
      )
    ) {
      return { ok: true, value: { ...resolved, requested: `default_routed:${defaultRole}` } };
    }
    if (resolved.ok) {
      return {
        exitCode: ExitCode.GENERAL_ERROR,
        result: {
          status: 'error',
          error: `Configured default reviewer role '${defaultRole}' resolves to the reporting agent ${args.reporterAgentId}; self-review is not admitted.`,
          review_authority_repair: {
            reason: 'missing_reviewer_identity',
            commands: [
              `narada task roster add <distinct-reviewer> --role ${defaultRole} --capability review`,
              `narada task report ${args.taskNumber} --agent ${args.reporterAgentId} --reviewer <distinct-reviewer> ...`,
            ],
            no_workaround: 'Do not create an unrouted review request or self-review the report.',
          },
        },
      };
    }
  }

  const distinctBuilders = args.roster.agents.filter((entry) =>
    entry.agent_id !== args.reporterAgentId
    && entry.role === 'builder'
    && resolveReviewTargetFromRoster(args.roster, entry.agent_id, { taskNumber: args.taskNumber })?.ok === true
  );
  if (distinctBuilders.length > 0) {
    const resolved = resolveReviewTargetFromRoster(args.roster, 'builder', { taskNumber: args.taskNumber });
    if (resolved?.ok) return { ok: true, value: { ...resolved, requested: 'auto_routed:builder_role' } };
  }

  const distinctReviewers = args.roster.agents.filter((entry) =>
    entry.agent_id !== args.reporterAgentId
    && entry.agent_id !== 'operator'
    && resolveReviewTargetFromRoster(args.roster, entry.agent_id, { taskNumber: args.taskNumber })?.ok === true
    && entry.role === 'reviewer'
  );
  if (distinctReviewers.length > 0) {
    const resolved = resolveReviewTargetFromRoster(args.roster, 'reviewer', { taskNumber: args.taskNumber });
    if (resolved?.ok) return { ok: true, value: { ...resolved, requested: 'auto_routed:reviewer_role' } };
  }

  return {
    exitCode: ExitCode.GENERAL_ERROR,
    result: {
      status: 'error',
      error: distinctReviewers.length > 1
        ? `Review routing is ambiguous: multiple distinct reviewer-role agents exist (${distinctReviewers.map((entry) => entry.agent_id).join(', ')}); pass --reviewer.`
        : 'Review routing failed: no distinct admitted reviewer could be resolved. Unrouted review obligations are not admitted.',
      review_authority_repair: {
        reason: 'missing_reviewer_identity',
        commands: [
          `narada task report ${args.taskNumber} --agent ${args.reporterAgentId} --reviewer <distinct-reviewer> ...`,
          'narada task roster add <distinct-reviewer> --role reviewer --capability review',
        ],
        no_workaround: 'Do not create an unrouted review request; report-time review routing must resolve to a distinct admitted reviewer.',
      },
    },
  };
}

export async function reportTaskService(
  options: ReportTaskServiceOptions,
): Promise<ReportTaskServiceResponse> {
  const cwd = options.cwd ? resolve(options.cwd) : process.cwd();
  const taskNumber = options.taskNumber;
  const agentId = options.agent;
  const summary = options.summary;

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

  if (!summary) {
    return {
      exitCode: ExitCode.GENERAL_ERROR,
      result: { status: 'error', error: '--summary is required' },
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
      result: { status: 'error', error: `Agent not found in roster: ${agentId}` },
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

  const { frontMatter, body: baseBody } = await readTaskFile(taskFile.path);
  let body = baseBody;

  const taskStatus = loadSqlTaskStatus(cwd, taskFile.taskId, taskNumber, options.store);
  if (taskStatus !== 'claimed') {
    return {
      exitCode: ExitCode.GENERAL_ERROR,
      result: {
        status: 'error',
        error: `Task ${taskFile.taskId} cannot be reported (status: ${taskStatus ?? 'missing'}, expected: claimed)`,
      },
    };
  }

  const activeAssignment = loadSqlActiveAssignment(cwd, taskFile.taskId, options.store);
  if (!activeAssignment) {
    return {
      exitCode: ExitCode.GENERAL_ERROR,
      result: {
        status: 'error',
        error: `Task ${taskFile.taskId} has no active SQL assignment`,
      },
    };
  }

  const assignmentRecord = await loadAssignment(cwd, taskFile.taskId);
  const activeContinuation = assignmentRecord ? getActiveContinuation(assignmentRecord, agentId) : null;

  const isPrimary = activeAssignment.agent_id === agentId;
  const isContinuation = activeContinuation != null;
  const activeIntent = activeAssignment.intent ?? 'primary';

  if (activeIntent === 'review' && isPrimary) {
    return {
      exitCode: ExitCode.GENERAL_ERROR,
      result: {
        status: 'error',
        error: `Agent ${agentId} has review intent for task ${taskFile.taskId}; use 'narada task review' instead of 'narada task report'.`,
      },
    };
  }

  if (!isPrimary && !isContinuation) {
    return {
      exitCode: ExitCode.GENERAL_ERROR,
      result: {
        status: 'error',
        error: `Task ${taskFile.taskId} is claimed by ${activeAssignment.agent_id}, not ${agentId}`,
      },
    };
  }

  const assignmentId = isContinuation
    ? `${taskFile.taskId}-continuation-${activeContinuation!.started_at}`
    : activeAssignment.assignment_id;

  const existingReport = await findReportByAssignmentId(cwd, assignmentId);
  if (existingReport) {
    return {
      exitCode: ExitCode.SUCCESS,
      result: {
        status: 'success',
        report_id: existingReport.report_id,
        task_id: taskFile.taskId,
        agent_id: agentId,
        new_status: taskStatus,
        note: 'Report already exists for this assignment; returning existing report without duplicate.',
      },
    };
  }

  const parsedChangedFilesResult = parseChangedFiles(options.changedFiles);
  if (parsedChangedFilesResult && 'exitCode' in parsedChangedFilesResult) {
    return parsedChangedFilesResult;
  }
  const changedFiles = parsedChangedFilesResult && 'ok' in parsedChangedFilesResult
    ? parsedChangedFilesResult.value
    : [];

  const parsedResidualsResult = parseStringJsonArray(options.residuals, 'residuals');
  if (parsedResidualsResult && 'exitCode' in parsedResidualsResult) {
    return parsedResidualsResult;
  }
  const knownResiduals = parsedResidualsResult && 'ok' in parsedResidualsResult
    ? parsedResidualsResult.value
    : [];

  const parsedVerificationResult = parseVerification(options.verification);
  if (parsedVerificationResult && 'exitCode' in parsedVerificationResult) {
    return parsedVerificationResult;
  }
  const verification = parsedVerificationResult && 'ok' in parsedVerificationResult
    ? parsedVerificationResult.value
    : [];

  const evidenceBlockers = findTaskEvidenceBlockers(body);
  const hasEvidenceBlockers = evidenceBlockers.length > 0;
  const nextStatus = hasEvidenceBlockers ? 'needs_continuation' : 'in_review';
  if (!isValidTransition(taskStatus, nextStatus)) {
    return {
      exitCode: ExitCode.GENERAL_ERROR,
      result: {
        status: 'error',
        error: `Transition from '${String(taskStatus)}' to '${nextStatus}' is not allowed by the state machine`,
      },
    };
  }
  let reviewTarget: ResolvedReviewTarget | null = null;
  if (!hasEvidenceBlockers) {
    const reviewTargetResult = resolveMandatoryReviewTarget({
      roster,
      requested: options.reviewer,
      reporterAgentId: agentId,
      cwd,
      taskNumber,
    });
    if (!('ok' in reviewTargetResult)) return reviewTargetResult;
    reviewTarget = reviewTargetResult.value;
  }

  const now = new Date().toISOString();
  const reportAssignmentId = hasEvidenceBlockers ? `${assignmentId}:blocked` : assignmentId;
  const reportId = createReportId(taskFile.taskId, agentId, reportAssignmentId);
  const obligationId = reviewTarget
    ? `obl_review_${safeIdPart(taskFile.taskId)}_${safeIdPart(reportId)}_${safeIdPart(reviewTargetIdPart(reviewTarget))}`
    : null;
  const report: WorkResultReport = {
    report_id: reportId,
    task_number: taskNumber,
    task_id: taskFile.taskId,
    agent_id: agentId,
    assignment_id: reportAssignmentId,
    directive_id: options.directiveId ?? null,
    reported_at: now,
    summary,
    changed_files: changedFiles,
    verification,
    known_residuals: knownResiduals,
    ready_for_review: !hasEvidenceBlockers,
    report_status: hasEvidenceBlockers ? 'blocked' : 'submitted',
  };

  const missingSections: string[] = [];
  if (!/##\s*Execution Notes\s*\n/i.test(body)) {
    missingSections.push('## Execution Notes\n\n<!-- Record what was done, decisions made, and files changed. -->\n');
  }
  if (!/##\s*Verification\s*\n/i.test(body)) {
    missingSections.push('## Verification\n\n<!-- Record commands run, results observed, and how correctness was checked. -->\n');
  }
  if (missingSections.length > 0) {
    body = body.trimEnd() + '\n\n' + missingSections.join('\n');
  }

  if (isContinuation) {
    activeContinuation!.completed_at = now;
    if (missingSections.length > 0) {
      await writeTaskProjection(taskFile.path, frontMatter, body);
    }
    const store = options.store ?? openTaskLifecycleStore(cwd);
    const closeOwnStore = () => {
      if (!options.store) {
        store.db.close();
      }
    };
    try {
      const persist = store.db.transaction(() => {
        persistReportInStore(store, report);
      });
      persist();
      closeOwnStore();
    } catch (error) {
      closeOwnStore();
      const msg = error instanceof Error ? error.message : String(error);
      return {
        exitCode: ExitCode.GENERAL_ERROR,
        result: {
          status: 'error',
          error: `Failed to update task lifecycle store: ${msg}`,
          report_id: reportId,
          task_id: taskFile.taskId,
          agent_id: agentId,
          report_status: report.report_status,
        },
      };
    }
    if (assignmentRecord) await saveAssignment(cwd, assignmentRecord);
  } else {
    const nextFrontMatter = { ...frontMatter, status: nextStatus } as typeof frontMatter;
    await writeTaskProjection(taskFile.path, nextFrontMatter, body);

    const store = options.store ?? openTaskLifecycleStore(cwd);
    const closeOwnStore = () => {
      if (!options.store) {
        store.db.close();
      }
    };

    try {
      const persist = store.db.transaction(() => {
        persistReportInStore(store, report);
        store.releaseAssignment(activeAssignment.assignment_id, hasEvidenceBlockers ? 'blocked' : 'completed');
        store.updateStatus(taskFile.taskId, nextStatus, agentId);
        if (reviewTarget && obligationId) {
          store.upsertDirectedObligation({
            obligation_id: obligationId,
            source_kind: 'task_report',
            source_ref: reportId,
            source_agent_id: agentId,
            target_agent_id: reviewTarget.target_agent_id,
            target_role: reviewTarget.target_role,
            target_ref: reviewTarget.requested,
            kind: 'review_request',
            status: 'open',
            task_id: taskFile.taskId,
            task_number: Number(taskNumber),
            evidence_json: JSON.stringify({
              report_id: reportId,
              assignment_id: reportAssignmentId,
              task_number: Number(taskNumber),
              requested_target: reviewTarget.requested,
              target_resolution: reviewTarget.resolution,
            }),
            consumption_rule_json: JSON.stringify({
              consume_on: ['task_review', 'task_defer', 'delegation', 'rejection', 'completion'],
              review_command: `narada task review ${taskNumber} --agent ${reviewCommandAgentPlaceholder(reviewTarget)} --verdict accepted --report ${reportId}`,
            }),
            created_at: now,
            updated_at: now,
            consumed_at: null,
            consumed_by: null,
            consumption_ref: null,
          });
        }
      });
      persist();

      closeOwnStore();
    } catch (error) {
      closeOwnStore();
      const msg = error instanceof Error ? error.message : String(error);
      return {
        exitCode: ExitCode.GENERAL_ERROR,
        result: {
          status: 'error',
          error: `Failed to update task lifecycle store: ${msg}`,
          report_id: reportId,
          task_id: taskFile.taskId,
          agent_id: agentId,
          report_status: report.report_status,
        },
      };
    }
  }

  await updateAgentRosterEntry(cwd, agentId, {
    status: 'done',
    task: null,
    last_done: Number(taskNumber) || null,
  });

  return {
    exitCode: ExitCode.SUCCESS,
    result: {
      status: 'success',
      report_id: reportId,
      task_id: taskFile.taskId,
      agent_id: agentId,
      new_status: hasEvidenceBlockers ? 'needs_continuation' : 'in_review',
      assignment_id: reportAssignmentId,
      report_status: report.report_status,
      ready_for_review: report.ready_for_review,
      obligation_id: obligationId,
      review_target: reviewTarget
        ? {
            requested: reviewTarget.requested,
            target_agent_id: reviewTarget.target_agent_id,
            target_role: reviewTarget.target_role,
            resolution: reviewTarget.resolution,
            review_authority: reviewTarget.review_authority,
          }
        : undefined,
      ...(hasEvidenceBlockers ? {
        evidence_blockers: evidenceBlockers,
        evidence_posture: 'reported_with_incomplete_task_evidence' as const,
      } : {}),
    },
  };
}
