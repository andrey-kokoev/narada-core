import { findTaskFile, readTaskFile, inspectTaskEvidence } from './task-governance.js';
import { inspectTaskEvidenceWithProjection } from './task-projection.js';
import {
  openTaskLifecycleStore,
  type EvidenceAdmissionResultRow,
  type EvidenceBundleRow,
  type TaskLifecycleStore,
  type TaskStatus,
} from './task-lifecycle-store.js';

export type EvidenceAdmissionMethod =
  | 'inspection'
  | 'admission'
  | 'report'
  | 'verification_run'
  | 'criteria_proof'
  | 'review'
  | 'close';

export interface EvidenceAdmission {
  bundle: EvidenceBundleRow;
  result: EvidenceAdmissionResultRow;
  blockers: string[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function id(prefix: string, taskNumber: number): string {
  return `${prefix}_${taskNumber}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function parseJsonArray<T>(value: string | null | undefined): T[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

async function ensureLifecycle(cwd: string, taskNumber: number, store: TaskLifecycleStore): Promise<string> {
  const existing = store.getLifecycleByNumber(taskNumber);
  if (existing) return existing.task_id;

  const taskFile = await findTaskFile(cwd, String(taskNumber));
  if (!taskFile) {
    throw new Error(`Task not found: ${taskNumber}`);
  }
  const { frontMatter } = await readTaskFile(taskFile.path);
  store.upsertLifecycle({
    task_id: taskFile.taskId,
    task_number: taskNumber,
    status: String(frontMatter.status ?? 'opened') as TaskStatus,
    governed_by: typeof frontMatter.governed_by === 'string' ? frontMatter.governed_by : null,
    closed_at: typeof frontMatter.closed_at === 'string' ? frontMatter.closed_at : null,
    closed_by: typeof frontMatter.closed_by === 'string' ? frontMatter.closed_by : null,
    reopened_at: typeof frontMatter.reopened_at === 'string' ? frontMatter.reopened_at : null,
    reopened_by: typeof frontMatter.reopened_by === 'string' ? frontMatter.reopened_by : null,
    continuation_packet_json: null,
    updated_at: nowIso(),
  });
  return taskFile.taskId;
}

export async function admitTaskEvidence(options: {
  cwd: string;
  taskNumber: number;
  admittedBy: string;
  methods: EvidenceAdmissionMethod[];
  requireReview?: boolean;
  store?: TaskLifecycleStore;
}): Promise<EvidenceAdmission> {
  const ownStore = options.store ? null : openTaskLifecycleStore(options.cwd);
  const store = options.store ?? ownStore!;
  try {
    const taskId = await ensureLifecycle(options.cwd, options.taskNumber, store);
    const evidence =
      (await inspectTaskEvidenceWithProjection(options.cwd, String(options.taskNumber)))
      ?? await inspectTaskEvidence(options.cwd, String(options.taskNumber), store);

    const reports = store.listReportRecords(taskId);
    const verificationRuns = store.listVerificationRunsForTask(taskId);
    const reviews = store.listReviews(taskId);
    const latestReview = reviews[0] ?? null;
    const latestReviewVerdict = latestReview?.verdict ?? null;
    const acceptedReview = latestReviewVerdict === 'accepted';
    const rejectedReview = latestReviewVerdict === 'needs_changes' || latestReviewVerdict === 'rejected';
    const historicalRejectedReviewIds = reviews
      .slice(1)
      .filter((review) => review.verdict === 'needs_changes' || review.verdict === 'rejected')
      .map((review) => review.review_id);

    const changedFiles = reports.flatMap((report) => {
      try {
        const parsed = JSON.parse(report.report_json) as { changed_files?: string[] };
        return Array.isArray(parsed.changed_files) ? parsed.changed_files : [];
      } catch {
        return [];
      }
    });
    const residuals = reports.flatMap((report) => {
      try {
        const parsed = JSON.parse(report.report_json) as { residuals?: string[] };
        return Array.isArray(parsed.residuals) ? parsed.residuals : [];
      } catch {
        return [];
      }
    });

    const bundle: EvidenceBundleRow = {
      bundle_id: id('evb', options.taskNumber),
      task_id: taskId,
      task_number: options.taskNumber,
      report_ids_json: JSON.stringify(reports.map((report) => report.report_id)),
      verification_run_ids_json: JSON.stringify(verificationRuns.map((run) => run.run_id)),
      acceptance_criteria_json: JSON.stringify({
        all_checked: evidence.all_criteria_checked,
        unchecked_count: evidence.unchecked_count,
      }),
      review_ids_json: JSON.stringify(reviews.map((review) => review.review_id)),
      changed_files_json: JSON.stringify([...new Set(changedFiles)]),
      residuals_json: JSON.stringify([...new Set(residuals)]),
      assembled_at: nowIso(),
      assembled_by: options.admittedBy,
    };

    const criteriaOnly = options.methods.length === 1 && options.methods.includes('criteria_proof');
    const blockers: string[] = [];
    if (evidence.all_criteria_checked === false) {
      blockers.push(`${evidence.unchecked_count} acceptance criteria remain unchecked`);
    }
    if (!criteriaOnly && !evidence.has_execution_notes && !evidence.has_report) {
      blockers.push('Task lacks execution notes');
    }
    const hasPassedVerificationRun = verificationRuns.some((run) => run.status === 'passed');
    if (!criteriaOnly && !evidence.has_verification && !hasPassedVerificationRun) {
      blockers.push('Task lacks verification evidence');
    }
    if (evidence.violations.includes('terminal_with_derivative_files')) {
      blockers.push('Derivative task-status files exist');
    }
    if (options.requireReview && !acceptedReview) {
      blockers.push('Review-gated admission requires accepted review');
    }
    if (rejectedReview && options.methods.includes('review')) {
      blockers.push('Latest review rejected admission');
    }

    const result: EvidenceAdmissionResultRow = {
      admission_id: id('ear', options.taskNumber),
      bundle_id: bundle.bundle_id,
      task_id: taskId,
      task_number: options.taskNumber,
      verdict: blockers.length === 0 ? 'admitted' : 'rejected',
      methods_json: JSON.stringify(options.methods),
      blockers_json: JSON.stringify(blockers),
      lifecycle_eligible_status: blockers.length === 0 && !criteriaOnly ? 'closed' : null,
      admitted_at: nowIso(),
      admitted_by: options.admittedBy,
      confirmation_json: JSON.stringify({
        has_report: evidence.has_report,
        has_review: evidence.has_review,
        has_verification_notes: evidence.has_verification,
        verification_run_ids: parseJsonArray<string>(bundle.verification_run_ids_json),
        latest_review_id: latestReview?.review_id ?? null,
        latest_review_verdict: latestReviewVerdict,
        historical_rejected_review_ids: historicalRejectedReviewIds,
        observation_output_counted: false,
      }),
    };

    store.upsertEvidenceBundle(bundle);
    store.upsertEvidenceAdmissionResult(result);
    return { bundle, result, blockers };
  } finally {
    if (ownStore) ownStore.db.close();
  }
}
