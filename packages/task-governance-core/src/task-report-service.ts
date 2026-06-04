import { resolve } from 'node:path';
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

export interface ReportTaskServiceOptions {
  taskNumber?: string;
  agent?: string;
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
  const selectReportingAnchor = (store: TaskLifecycleStore) => {
    const active = store.getAssignments(taskId).filter((assignment) => assignment.released_at === null);
    return active.find((assignment) => assignment.intent === 'primary' || assignment.intent === 'takeover')
      ?? active[0]
      ?? null;
  };
  if (providedStore) {
    return selectReportingAnchor(providedStore);
  }
  const store = openTaskLifecycleStore(cwd);
  try {
    return selectReportingAnchor(store);
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
  const nextStatus = hasEvidenceBlockers ? 'needs_continuation' : 'closed';
  if (!isValidTransition(taskStatus, nextStatus)) {
    return {
      exitCode: ExitCode.GENERAL_ERROR,
      result: {
        status: 'error',
        error: `Transition from '${String(taskStatus)}' to '${nextStatus}' is not allowed by the state machine`,
      },
    };
  }
  const now = new Date().toISOString();
  const reportAssignmentId = hasEvidenceBlockers ? `${assignmentId}:blocked` : assignmentId;
  const reportId = createReportId(taskFile.taskId, agentId, reportAssignmentId);
  const obligationId = null;

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
    ready_for_review: false,
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
  } else {
    const nextFrontMatter = { ...frontMatter, status: nextStatus } as typeof frontMatter;
    if (!hasEvidenceBlockers) {
      nextFrontMatter.closed_at = now;
      nextFrontMatter.closed_by = agentId;
      nextFrontMatter.governed_by = `task_report:${agentId}`;
      nextFrontMatter.closure_mode = 'agent_finish';
    }
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
        store.updateStatus(taskFile.taskId, nextStatus, agentId, !hasEvidenceBlockers ? {
          closed_at: now,
          closed_by: agentId,
          governed_by: `task_report:${agentId}`,
          closure_mode: 'agent_finish',
        } : undefined);
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
      new_status: nextStatus,
      assignment_id: reportAssignmentId,
      report_status: report.report_status,
      ready_for_review: false,
      obligation_id: obligationId,

      ...(hasEvidenceBlockers ? {
        evidence_blockers: evidenceBlockers,
        evidence_posture: 'reported_with_incomplete_task_evidence' as const,
      } : {}),
    },
  };
}
