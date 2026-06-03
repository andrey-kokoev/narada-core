/**
 * Task assignment recommendation engine.
 *
 * Read-only advisory operator. Never mutates task, roster, assignment,
 * report, review, or PrincipalRuntime state.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  loadRoster,
  listRunnableTasks,
  loadAssignment,
  loadReport,
  listReportsForTask,
  parseFrontMatter,
  checkDependencies,
  resolveTaskStatus,
  isExecutableTaskFile,
  extractChapter,
  extractTaskNumberFromFileName,
  resolveExecutableTaskNumberOwnership,
  type AgentRoster,
  type AgentRosterEntry,
  type ChapterTaskInfo,
  type ComputedAffinity,
  type DependencyCheckDetail,
  type WorkResultReport,
} from './task-governance.js';
import { openTaskLifecycleStore, type TaskLifecycleStore } from './task-lifecycle-store.js';

// ── Types ──

export interface TaskRecommendation {
  recommendation_id: string;
  generated_at: string;
  recommender_id: string;
  primary: CandidateAssignment | null;
  alternatives: CandidateAssignment[];
  alternatives_total?: number;
  alternatives_returned?: number;
  alternatives_truncated?: boolean;
  alternatives_limit?: number | null;
  abstained: AbstainedTask[];
  abstained_total?: number;
  abstained_returned?: number;
  abstained_truncated?: boolean;
  abstained_limit?: number | null;
  summary: string;
}

export interface CandidateAssignment {
  task_id: string;
  task_number: number | null;
  task_title: string | null;
  principal_id: string;
  principal_type: 'operator' | 'agent' | 'worker' | 'external';
  score: number;
  confidence: 'high' | 'medium' | 'low';
  breakdown: ScoreBreakdown;
  rationale: string;
  reasons: RecommendationReason[];
  risks: RecommendationRisk[];
}

export interface ScoreBreakdown {
  affinity: number;
  warm_context: number;
  capability: number;
  load: number;
  history: number;
  review_separation: number;
  budget: number;
}

export interface RecommendationReason {
  category: 'dependency' | 'capability' | 'warm_context' | 'workload' | 'availability';
  description: string;
}

export interface RecommendationRisk {
  category: 'blocked' | 'write_set' | 'review_separation' | 'budget' | 'capability_gap' | 'workload' | 'availability';
  severity: 'none' | 'low' | 'medium' | 'high';
  description: string;
}

export interface AbstainedTask {
  task_id: string;
  task_number: number | null;
  reason: string;
  blocked_by?: number[];
  blocked_by_agents?: Array<{ task_number: number; agent_id: string }>;
  blocker_details?: DependencyCheckDetail[];
}

export interface RecommendationOptions {
  cwd: string;
  agentFilter?: string;
  taskFilter?: string;
  limit?: number;
  principalRuntimePath?: string | null;
  /** Architect principal ID that produced this recommendation. Defaults to 'system'. */
  architectId?: string;
  /** SQLite-backed lifecycle store for authoritative status reads. */
  store?: TaskLifecycleStore;
}

export interface PrincipalSnapshot {
  principal_id: string;
  state: string;
  budget_remaining: number | null;
  active_work_item_id: string | null;
}

/**
 * Per-agent score summary for a specific task candidate.
 * Used by downstream consumers that need scoring without full assignment context.
 */
export interface AgentCandidateScore {
  agent_id: string;
  agent_role: string;
  score: number;
  confidence: 'high' | 'medium' | 'low';
  breakdown: ScoreBreakdown;
  reasons: RecommendationReason[];
  risks: RecommendationRisk[];
}

/**
 * Snapshot of all inputs consumed by the recommendation engine at generation time.
 * Advisory diagnostic surface for debugging recommendation quality.
 */
export interface RecommendationInputSnapshot {
  snapshot_id: string;
  captured_at: string;
  task_count: number;
  runnable_task_count: number;
  agent_count: number;
  principal_runtime_available: boolean;
  assignment_count: number;
  report_count: number;
  review_count: number;
}

// Internal task representation used by the recommender
interface TaskInfo {
  taskId: string;
  taskNumber: number | null;
  status: string;
  title: string | null;
  fileName: string;
  dependsOn: number[] | undefined;
  continuationAffinity: ComputedAffinity;
  body: string;
}

// Warm-context record for advisory routing signals
interface WarmContextRecord {
  task_id: string;
  task_number: number | null;
  chapter: string | null;
  claimed_at: string | null;
  released_at: string | null;
  release_reason: 'completed' | 'abandoned' | 'superseded' | 'transferred' | 'budget_exhausted' | 'continued' | null;
}

// ── Default weights ──

const DEFAULT_WEIGHTS: ScoreBreakdown = {
  affinity: 0.25,
  warm_context: 0.10,
  capability: 0.25,
  load: 0.20,
  history: 0.05,
  review_separation: 0.10,
  budget: 0.05,
};

// ── Capability extraction ──

const CAPABILITY_KEYWORDS: Array<{ keywords: string[]; capability: string }> = [
  { keywords: ['TypeScript', 'typecheck', 'type-check'], capability: 'typescript' },
  { keywords: ['test', 'fixture', 'vitest'], capability: 'testing' },
  { keywords: ['SQLite', 'schema', 'database'], capability: 'database' },
  { keywords: ['Graph API', 'mailbox', 'mail', 'exchange'], capability: 'mailbox_vertical' },
  { keywords: ['Cloudflare', 'Durable Object', 'Worker', 'DO'], capability: 'cloudflare' },
  { keywords: ['design', 'contract', 'boundary', 'architecture'], capability: 'architecture' },
  { keywords: ['documentation', 'README', 'docs'], capability: 'documentation' },
  { keywords: ['CLI', 'command'], capability: 'cli' },
  { keywords: ['principal', 'runtime', 'state machine'], capability: 'principal_runtime' },
];

export function extractCapabilities(body: string): string[] {
  const caps = new Set<string>();
  const text = body.toLowerCase();
  for (const { keywords, capability } of CAPABILITY_KEYWORDS) {
    for (const kw of keywords) {
      if (text.includes(kw.toLowerCase())) {
        caps.add(capability);
        break;
      }
    }
  }
  return Array.from(caps);
}

// ── PrincipalRuntime loading (advisory, degrades gracefully) ──

export async function loadPrincipalRuntimeSnapshots(cwd: string): Promise<Map<string, PrincipalSnapshot>> {
  const map = new Map<string, PrincipalSnapshot>();
  const registryPath = join(resolve(cwd), '.ai', 'principal-runtime.json');
  try {
    const raw = await readFile(registryPath, 'utf8');
    const data = JSON.parse(raw) as { principals?: PrincipalSnapshot[] };
    if (Array.isArray(data.principals)) {
      for (const p of data.principals) {
        map.set(p.principal_id, p);
      }
    }
  } catch {
    // Graceful degradation: no registry file means no runtime data
  }
  return map;
}

// ── Write-set risk heuristic ──

async function computeWriteSetRisk(
  cwd: string,
  task: TaskInfo,
  agentId: string,
  activeAssignments: Map<string, string[]>, // task_id -> agent_id[]
): Promise<RecommendationRisk | null> {
  // Load report for this task if any
  const reports = await listReportsForTask(cwd, task.taskId);
  const recentReport = reports[reports.length - 1];
  const taskFiles = recentReport ? recentReport.changed_files : [];

  if (taskFiles.length === 0) {
    return null;
  }

  // Check overlap with other active assignments
  for (const [otherTaskId, otherAgents] of activeAssignments) {
    if (otherTaskId === task.taskId) continue;
    if (otherAgents.includes(agentId)) continue; // Same agent on multiple tasks is a different concern

    const otherReports = await listReportsForTask(cwd, otherTaskId);
    const otherRecent = otherReports[otherReports.length - 1];
    const otherFiles = otherRecent ? otherRecent.changed_files : [];

    const overlap = taskFiles.filter((f) => otherFiles.includes(f));
    if (overlap.length > 0) {
      return {
        category: 'write_set',
        severity: 'medium',
        description: `File overlap with active task ${otherTaskId}: ${overlap.join(', ')}`,
      };
    }
  }

  return null;
}

// ── Scoring dimensions ──

function scoreAffinity(task: TaskInfo, agentId: string, computedAffinity: ComputedAffinity | undefined): number {
  if (task.continuationAffinity?.preferred_agent_id === agentId) return 1.0;
  if (computedAffinity?.preferred_agent_id === agentId) {
    return computedAffinity.source === 'manual' ? 1.0 : 0.7;
  }
  return 0.0;
}

function scoreCapability(taskCaps: string[], agentCaps: string[]): number {
  if (taskCaps.length === 0) return 0.5;
  const intersection = taskCaps.filter((c) => agentCaps.includes(c));
  return intersection.length / taskCaps.length;
}

function scoreLoad(agent: AgentRosterEntry): number {
  const busyStatuses: Array<string | undefined> = ['working', 'reviewing', 'blocked'];
  if (busyStatuses.includes(agent.status)) {
    // Count active assignments from roster task field
    const activeCount = agent.task != null ? 1 : 0;
    const maxConcurrent = 3;
    return Math.max(0, 1 - activeCount / maxConcurrent);
  }
  return 1.0;
}

function scoreHistory(
  completed: number,
  abandoned: number,
): number {
  const total = completed + abandoned;
  if (total === 0) return 0.5;
  return completed / total;
}

function scoreReviewSeparation(taskId: string, agentId: string, lastWorkerMap: Map<string, string | null>): number {
  const lastWorker = lastWorkerMap.get(taskId);
  if (lastWorker === agentId) return 0.0;
  return 1.0;
}

function scoreBudget(snapshot: PrincipalSnapshot | undefined): number {
  if (!snapshot) return 1.0;
  if (snapshot.budget_remaining === null) return 1.0;
  if (snapshot.budget_remaining <= 0) return 0.0;
  return Math.min(1.0, snapshot.budget_remaining / 10000);
}

/**
 * Compute warm-context affinity score for an agent relative to a task.
 * Advisory signal only — never overrides hard blockers.
 *
 * Signals:
 * - Same chapter continuity (agent worked on another task in same chapter)
 * - Adjacent task continuity (agent worked on nearby task numbers)
 * - Dependency recency (agent completed a prerequisite recently)
 *
 * Decay: exponential with 7-day half-life so stale context fades.
 */
function scoreWarmContext(
  task: TaskInfo,
  agentId: string,
  agentWarmContexts: Map<string, WarmContextRecord[]>,
  now: Date,
): number {
  const contexts = agentWarmContexts.get(agentId) ?? [];
  const taskChapter = extractChapter(task.body);

  let bestScore = 0;

  for (const ctx of contexts) {
    if (ctx.task_id === task.taskId) continue;

    const isActive = ctx.released_at === null;
    const timestamp = isActive ? ctx.claimed_at : ctx.released_at;
    if (!timestamp) continue;

    let decay = 1.0;
    if (!isActive) {
      const ageMs = now.getTime() - new Date(timestamp).getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      decay = Math.exp(-ageDays / 7); // 7-day half-life
    }

    // Same chapter signal
    if (taskChapter && ctx.chapter === taskChapter) {
      const baseScore = isActive ? 0.3 : 0.7;
      bestScore = Math.max(bestScore, baseScore * decay);
    }

    // Adjacent task number signal (within ±3)
    if (ctx.task_number !== null && task.taskNumber !== null) {
      const distance = Math.abs(ctx.task_number - task.taskNumber);
      if (distance > 0 && distance <= 3) {
        const baseScore = isActive ? 0.2 : 0.5;
        bestScore = Math.max(bestScore, baseScore * decay);
      }
    }

    // Dependency recency signal (complements history affinity)
    if (task.dependsOn?.includes(ctx.task_number ?? -1)) {
      const baseScore = isActive ? 0.15 : 0.4;
      bestScore = Math.max(bestScore, baseScore * decay);
    }
  }

  return Math.min(1.0, bestScore);
}

// ── Confidence classification ──

function classifyConfidence(score: number, nextBestScore: number): 'high' | 'medium' | 'low' {
  if (score >= 0.8 && score - nextBestScore >= 0.2) return 'high';
  if (score >= 0.5) return 'medium';
  return 'low';
}

// ── Rationale builder ──

function buildRationale(
  agent: AgentRosterEntry,
  taskCaps: string[],
  agentCaps: string[],
  affinityScore: number,
  computedAffinity: ComputedAffinity | undefined,
  warmContextScore: number,
  loadScore: number,
  historyScore: number,
  reviewSepScore: number,
  budgetScore: number,
  budgetWarning: boolean,
): string {
  const capIntersection = taskCaps.filter((c) => agentCaps.includes(c));
  const capSummary = taskCaps.length === 0
    ? 'no capability preference'
    : capIntersection.length === taskCaps.length
      ? `capability match [${capIntersection.join(', ')}] (${capIntersection.length}/${taskCaps.length})`
      : capIntersection.length > 0
        ? `partial match [${capIntersection.join(', ')}] (${capIntersection.length}/${taskCaps.length})`
        : 'no capability match';

  const affinityClause = affinityScore >= 1.0
    ? 'Manual affinity from task file'
    : affinityScore >= 0.7
      ? `History affinity: ${computedAffinity?.affinity_reason ?? 'completed prerequisite tasks'}`
      : 'No affinity';

  const warmContextClause = warmContextScore >= 0.5
    ? `Warm context: recently worked on related task (${Math.round(warmContextScore * 100)}%)`
    : warmContextScore > 0
      ? `Warm context: some related work (${Math.round(warmContextScore * 100)}%)`
      : 'Cold context';

  const loadClause = loadScore >= 1.0
    ? 'Idle'
    : loadScore > 0
      ? `Currently working on task(s)`
      : 'At capacity';

  const historyClause = historyScore >= 0.8
    ? 'Strong completion record'
    : historyScore >= 0.5
      ? 'Moderate completion record'
      : 'No recent history or poor record';

  const caveats: string[] = [];
  if (reviewSepScore === 0.0) {
    caveats.push('Warning: this principal may be disqualified as reviewer for this task');
  }
  if (budgetWarning) {
    caveats.push('Budget low');
  }

  return `${agent.agent_id} is ${agent.status ?? 'unknown'} with ${capSummary}. ${affinityClause}. ${warmContextClause}. ${loadClause}. ${historyClause}.${caveats.length > 0 ? ' ' + caveats.join('. ') + '.' : ''}`;
}

// ── Main recommendation engine ──

export async function generateRecommendations(
  options: RecommendationOptions,
): Promise<TaskRecommendation> {
  const cwd = resolve(options.cwd);
  const weights = DEFAULT_WEIGHTS;
  const now = new Date().toISOString();
  const store = options.store ?? openTaskLifecycleStore(cwd);
  const shouldCloseStore = options.store === undefined;

  // 1. Load task graph directly (need dependsOn which listRunnableTasks omits)
  const tasksDir = join(cwd, '.ai', 'do-not-open', 'tasks');
  const allMdFiles = (await readdir(tasksDir).catch(() => [] as string[])).filter((f) => f.endsWith('.md'));
  const taskFiles = allMdFiles.filter(isExecutableTaskFile);
  const ownership = await resolveExecutableTaskNumberOwnership(cwd, store);

  // Build chapter map for all tasks (needed for warm-context affinity)
  const taskChapterMap = new Map<string, string | null>();
  for (const f of allMdFiles) {
    try {
      const content = await readFile(join(tasksDir, f), 'utf8');
      const { body } = parseFrontMatter(content);
      const chapter = extractChapter(body);
      taskChapterMap.set(f.replace(/\.md$/, ''), chapter);
    } catch {
      // Skip unreadable files
    }
  }

  // Pre-load all SQLite statuses for efficiency
  const sqliteStatusMap = new Map<number, string>();
  const sqliteSpecMap = new Map<number, { title: string; dependencies: number[] }>();
  if (store) {
    for (const row of store.getAllLifecycle()) {
      sqliteStatusMap.set(row.task_number, row.status);
    }
    const specRows = store.db
      .prepare('select task_number, title, dependencies_json from task_specs')
      .all() as Array<{ task_number: number; title: string; dependencies_json: string }>;
    for (const row of specRows) {
      sqliteSpecMap.set(Number(row.task_number), {
        title: String(row.title),
        dependencies: JSON.parse(String(row.dependencies_json)) as number[],
      });
    }
  }

  const allTasks: TaskInfo[] = [];

  for (const f of taskFiles) {
    try {
      const taskId = f.replace(/\.md$/, '');
      const taskNumber = extractTaskNumberFromFileName(f);
      if (taskNumber !== null) {
        if (ownership.conflictedNumbers.has(taskNumber)) continue;
        const ownerTaskId = ownership.ownerByNumber.get(taskNumber);
        if (ownerTaskId && ownerTaskId !== taskId) continue;
      }

      const content = await readFile(join(tasksDir, f), 'utf8');
      const { frontMatter, body } = parseFrontMatter(content);
      if (frontMatter.status === undefined) continue;

      // Prefer SQLite status if available
      let status: string | undefined;
      if (taskNumber !== null && sqliteStatusMap.has(taskNumber)) {
        status = sqliteStatusMap.get(taskNumber);
      } else {
        status = frontMatter.status as string | undefined;
      }

      const spec = taskNumber !== null ? sqliteSpecMap.get(taskNumber) : undefined;
      allTasks.push({
        taskId,
        taskNumber,
        status: status ?? '',
        title: spec?.title ?? null,
        fileName: f,
        dependsOn: spec?.dependencies ?? [],
        continuationAffinity: (frontMatter.continuation_affinity as ComputedAffinity) ?? { preferred_agent_id: null, affinity_strength: 0, affinity_reason: null, source: 'none' },
        body,
      });
    } catch {
      // Skip unreadable files
    }
  }

  // Filter to runnable tasks with satisfied dependencies (evidence-valid)
  const dependencyBlocked: Array<{ task: TaskInfo; blockedBy: number[]; details: DependencyCheckDetail[] }> = [];
  const awaitingReview: TaskInfo[] = [];
  const runnableTasks: TaskInfo[] = [];

  for (const task of allTasks) {
    if (task.status === 'in_review') {
      awaitingReview.push(task);
      continue;
    }
    if (task.status !== 'opened' && task.status !== 'needs_continuation') continue;

    const { blockedBy, details } = await checkDependencies(cwd, task.dependsOn, store);
    if (blockedBy.length > 0) {
      dependencyBlocked.push({
        task,
        blockedBy: blockedBy
          .map((id) => extractTaskNumberFromFileName(id))
          .filter((n): n is number => n !== null),
        details,
      });
      continue;
    }

    runnableTasks.push(task);
  }

  // 2. Load roster
  const roster = await loadRoster(cwd);
  const rosterByTask = new Map<number, string>();
  for (const agent of roster.agents) {
    if (typeof agent.task === 'number' && agent.status === 'working') {
      rosterByTask.set(agent.task, agent.agent_id);
    }
  }

  // 3. Load PrincipalRuntime (advisory, degrades gracefully)
  const runtimeSnapshots = await loadPrincipalRuntimeSnapshots(cwd);

  // 4. Load assignment history and build last-worker map + warm-context records
  const lastWorkerMap = new Map<string, string | null>();
  const completionCounts = new Map<string, { completed: number; abandoned: number }>();
  const agentWarmContexts = new Map<string, WarmContextRecord[]>();
  const assignmentRows = store
    ? (store.db.prepare(
      `select task_id, agent_id, claimed_at, released_at, release_reason
       from task_assignments
       order by claimed_at asc`,
    ).all() as Array<{
      task_id: string;
      agent_id: string;
      claimed_at: string;
      released_at: string | null;
      release_reason: string | null;
    }>)
    : [];
  const assignmentsByTaskId = new Map<string, typeof assignmentRows>();
  for (const row of assignmentRows) {
    const existing = assignmentsByTaskId.get(row.task_id) ?? [];
    existing.push(row);
    assignmentsByTaskId.set(row.task_id, existing);
  }

  for (const [taskId, assignments] of assignmentsByTaskId) {
    const taskNumber = extractTaskNumberFromFileName(`${taskId}.md`);
    if (taskNumber !== null) {
      if (ownership.conflictedNumbers.has(taskNumber)) continue;
      const ownerTaskId = ownership.ownerByNumber.get(taskNumber);
      if (ownerTaskId && ownerTaskId !== taskId) continue;
    }

    // Find last completed worker
    const completed = assignments
      .filter((a) => a.release_reason === 'completed')
      .sort((a, b) => (b.released_at ?? '').localeCompare(a.released_at ?? ''));
    if (completed.length > 0) {
      lastWorkerMap.set(taskId, completed[0]!.agent_id);
    }

    // Count per-agent completion/abandonment + build warm-context records
    for (const a of assignments) {
      const counts = completionCounts.get(a.agent_id) ?? { completed: 0, abandoned: 0 };
      if (a.release_reason === 'completed') counts.completed++;
      else if (a.release_reason === 'abandoned') counts.abandoned++;
      completionCounts.set(a.agent_id, counts);

      const contexts = agentWarmContexts.get(a.agent_id) ?? [];
      contexts.push({
        task_id: taskId,
        task_number: extractTaskNumberFromFileName(taskId + '.json') ?? extractTaskNumberFromFileName(taskId + '.md'),
        chapter: taskChapterMap.get(taskId) ?? null,
        claimed_at: a.claimed_at,
        released_at: a.released_at,
        release_reason: a.release_reason as WarmContextRecord['release_reason'],
      });
      agentWarmContexts.set(a.agent_id, contexts);
    }
  }

  // Build active assignment map for write-set risk
  const activeAssignments = new Map<string, string[]>();
  for (const [taskId, assignments] of assignmentsByTaskId) {
    const active = assignments.find((a) => a.released_at === null);
    if (active) {
      const agents = activeAssignments.get(taskId) ?? [];
      agents.push(active.agent_id);
      activeAssignments.set(taskId, agents);
    }
  }

  // 5. Filter tasks if --task specified
  let tasksToConsider = runnableTasks;
  if (options.taskFilter) {
    tasksToConsider = runnableTasks.filter((t) =>
      t.taskId.includes(options.taskFilter!) ||
      String(t.taskNumber) === options.taskFilter,
    );
  }

  // 6. Filter agents if --agent specified
  let agentsToConsider = roster.agents;
  if (options.agentFilter) {
    agentsToConsider = roster.agents.filter((a) => a.agent_id === options.agentFilter);
  }

  // 7. Score all candidate pairs
  const allCandidates: CandidateAssignment[] = [];
  const abstained: AbstainedTask[] = [];

  // Add dependency-blocked tasks to abstained
  for (const task of awaitingReview) {
    abstained.push({
      task_id: task.taskId,
      task_number: task.taskNumber,
      reason: 'Completed, awaiting review or closure',
    });
  }

  for (const { task, blockedBy, details } of dependencyBlocked) {
    const blockedByAgents = blockedBy
      .map((taskNumber) => {
        const agentId = rosterByTask.get(taskNumber);
        return agentId ? { task_number: taskNumber, agent_id: agentId } : null;
      })
      .filter((entry): entry is { task_number: number; agent_id: string } => entry !== null);
    const hasDeferredDependency = details.some((detail) => detail.reason.includes('Dependency is deferred'));
    abstained.push({
      task_id: task.taskId,
      task_number: task.taskNumber,
      reason: hasDeferredDependency
        ? 'Blocked by deferred dependency'
        : 'Blocked by unmet dependencies',
      blocked_by: blockedBy,
      blocked_by_agents: blockedByAgents.length > 0 ? blockedByAgents : undefined,
      blocker_details: details.length > 0 ? details : undefined,
    });
  }

  for (const task of tasksToConsider) {
    const taskCaps = extractCapabilities(task.body);

    const taskCandidates: CandidateAssignment[] = [];

    for (const agent of agentsToConsider) {
      const reasons: RecommendationReason[] = [];
      const risks: RecommendationRisk[] = [];

      // Check dependency readiness (defensive; listRunnableTasks should filter)
      const deps = task.dependsOn ?? [];
      if (deps.length > 0) {
        // Dependencies should already be satisfied if task is in runnableTasks
        reasons.push({ category: 'dependency', description: 'Dependencies satisfied' });
      }

      // Availability check
      const runtime = runtimeSnapshots.get(agent.agent_id);
      const unavailableStates = ['unavailable', 'stale', 'failed', 'budget_exhausted', 'executing', 'waiting_review', 'claiming'];
      if (runtime && unavailableStates.includes(runtime.state)) {
        risks.push({
          category: 'availability',
          severity: 'high',
          description: `PrincipalRuntime state is ${runtime.state}`,
        });
        continue; // Skip unavailable principals
      }

      // Active work item check
      if (runtime?.active_work_item_id) {
        risks.push({
          category: 'workload',
          severity: 'high',
          description: 'Principal has active work item',
        });
        continue;
      }

      // Budget check
      const budgetScore = scoreBudget(runtime);
      let budgetWarning = false;
      if (runtime && runtime.budget_remaining !== null && runtime.budget_remaining > 0 && runtime.budget_remaining <= 1000) {
        budgetWarning = true;
      }
      if (budgetScore === 0.0) {
        risks.push({ category: 'budget', severity: 'high', description: 'Budget exhausted' });
        continue;
      }

      // Load score
      const loadScore = scoreLoad(agent);
      if (loadScore === 0.0) {
        risks.push({ category: 'workload', severity: 'medium', description: 'Agent at capacity' });
      } else if (loadScore < 1.0) {
        reasons.push({ category: 'workload', description: 'Partially available' });
      } else {
        reasons.push({ category: 'workload', description: 'Idle or done' });
      }

      // Capability score
      const capabilityScore = scoreCapability(taskCaps, agent.capabilities ?? []);
      if (capabilityScore >= 0.5) {
        reasons.push({ category: 'capability', description: `Capability match ${Math.round(capabilityScore * 100)}%` });
      } else if (taskCaps.length > 0) {
        risks.push({ category: 'capability_gap', severity: 'low', description: 'Limited capability match' });
      }

      // Affinity score
      const affinityScore = scoreAffinity(task, agent.agent_id, task.continuationAffinity);
      if (affinityScore > 0.0) {
        reasons.push({ category: 'warm_context', description: 'Continuation affinity' });
      }

      // Warm-context score
      const warmContextScore = scoreWarmContext(task, agent.agent_id, agentWarmContexts, new Date(now));
      if (warmContextScore > 0.0) {
        reasons.push({ category: 'warm_context', description: `Warm context ${Math.round(warmContextScore * 100)}%` });
      }

      // History score
      const counts = completionCounts.get(agent.agent_id) ?? { completed: 0, abandoned: 0 };
      const historyScore = scoreHistory(counts.completed, counts.abandoned);

      // Review separation score
      const reviewSepScore = scoreReviewSeparation(task.taskId, agent.agent_id, lastWorkerMap);
      if (reviewSepScore === 0.0) {
        risks.push({
          category: 'review_separation',
          severity: 'low',
          description: 'Agent was last worker on this task; may be disqualified as reviewer',
        });
      }

      // Write-set risk
      const writeSetRisk = await computeWriteSetRisk(cwd, task, agent.agent_id, activeAssignments);
      if (writeSetRisk) {
        risks.push(writeSetRisk);
      }

      // Composite score
      const score =
        weights.affinity * affinityScore +
        weights.warm_context * warmContextScore +
        weights.capability * capabilityScore +
        weights.load * loadScore +
        weights.history * historyScore +
        weights.review_separation * reviewSepScore +
        weights.budget * budgetScore;

      if (score <= 0) {
        continue; // Completely unsuitable
      }

      taskCandidates.push({
        task_id: task.taskId,
        task_number: task.taskNumber,
        task_title: task.title,
        principal_id: agent.agent_id,
        principal_type: 'agent',
        score: Math.round(score * 1000) / 1000,
        confidence: 'low', // Will be updated after sorting
        breakdown: {
          affinity: Math.round(affinityScore * 1000) / 1000,
          warm_context: Math.round(warmContextScore * 1000) / 1000,
          capability: Math.round(capabilityScore * 1000) / 1000,
          load: Math.round(loadScore * 1000) / 1000,
          history: Math.round(historyScore * 1000) / 1000,
          review_separation: Math.round(reviewSepScore * 1000) / 1000,
          budget: Math.round(budgetScore * 1000) / 1000,
        },
        rationale: buildRationale(agent, taskCaps, agent.capabilities ?? [], affinityScore, task.continuationAffinity, warmContextScore, loadScore, historyScore, reviewSepScore, budgetScore, budgetWarning),
        reasons,
        risks,
      });
    }

    // Sort candidates by score descending
    taskCandidates.sort((a, b) => b.score - a.score);

    // Classify confidence
    for (let i = 0; i < taskCandidates.length; i++) {
      const nextBest = taskCandidates[i + 1]?.score ?? 0;
      taskCandidates[i]!.confidence = classifyConfidence(taskCandidates[i]!.score, nextBest);
    }

    if (taskCandidates.length === 0) {
      abstained.push({
        task_id: task.taskId,
        task_number: task.taskNumber,
        reason: 'No available principal with suitable capabilities',
      });
    } else {
      allCandidates.push(...taskCandidates);
    }
  }

  // 8. Greedy conflict resolution: one task per principal, one principal per task
  allCandidates.sort((a, b) => b.score - a.score);

  const assignedTasks = new Set<string>();
  const assignedAgents = new Set<string>();
  const primaryList: CandidateAssignment[] = [];
  const alternativeList: CandidateAssignment[] = [];

  for (const cand of allCandidates) {
    if (assignedTasks.has(cand.task_id)) {
      // Task already has primary; add as alternative if agent not used elsewhere
      if (!assignedAgents.has(cand.principal_id)) {
        alternativeList.push(cand);
      }
      continue;
    }
    if (assignedAgents.has(cand.principal_id)) {
      // Agent already assigned; add as alternative
      alternativeList.push(cand);
      continue;
    }
    assignedTasks.add(cand.task_id);
    assignedAgents.add(cand.principal_id);
    primaryList.push(cand);
  }

  // Apply limit
  const limit = options.limit ?? primaryList.length;
  const limitedPrimary = primaryList.slice(0, limit);

  const summary = `${limitedPrimary.length} recommendation${limitedPrimary.length !== 1 ? 's' : ''}, ${alternativeList.length} alternative${alternativeList.length !== 1 ? 's' : ''}, ${abstained.length} abstained.`;

  const result = {
    recommendation_id: `rec-${Date.now()}`,
    generated_at: now,
    recommender_id: options.architectId ?? 'system',
    primary: limitedPrimary[0] ?? null,
    alternatives: limitedPrimary.slice(1).concat(alternativeList),
    abstained,
    summary,
  };
  if (shouldCloseStore) {
    store.db.close();
  }
  return result;
}

/**
 * Convert a CandidateAssignment into a per-agent score summary.
 */
export function toAgentCandidateScore(cand: CandidateAssignment): AgentCandidateScore {
  return {
    agent_id: cand.principal_id,
    agent_role: cand.principal_type,
    score: cand.score,
    confidence: cand.confidence,
    breakdown: cand.breakdown,
    reasons: cand.reasons,
    risks: cand.risks,
  };
}

/**
 * Build an input snapshot describing what the recommender consumed.
 */
export async function buildInputSnapshot(
  options: RecommendationOptions,
): Promise<RecommendationInputSnapshot> {
  const cwd = resolve(options.cwd);
  const tasksDir = join(cwd, '.ai', 'do-not-open', 'tasks');
  const taskFiles = (await readdir(tasksDir).catch(() => [] as string[])).filter((f) => f.endsWith('.md'));

  const roster = await loadRoster(cwd).catch(() => ({ version: 1, updated_at: new Date().toISOString(), agents: [] }) as AgentRoster);
  const runtimeSnapshots = await loadPrincipalRuntimeSnapshots(cwd);

  let assignmentCount = 0;
  let reportCount = 0;
  let reviewCount = 0;
  try {
    const store = openTaskLifecycleStore(cwd);
    try {
      assignmentCount = Number((store.db.prepare('select count(*) as count from task_assignments').get() as { count: number } | undefined)?.count ?? 0);
      reportCount = Number((store.db.prepare('select count(*) as count from task_report_records').get() as { count: number } | undefined)?.count ?? 0);
      reviewCount = store.listAllReviews().length;
    } finally {
      store.db.close();
    }
  } catch {
    // Snapshot remains best-effort.
  }

  let runnableCount = 0;
  for (const f of taskFiles) {
    try {
      const content = await readFile(join(tasksDir, f), 'utf8');
      const { frontMatter } = parseFrontMatter(content);
      const status = frontMatter.status as string | undefined;
      if (status === 'opened' || status === 'needs_continuation') {
        runnableCount++;
      }
    } catch {
      // ignore unreadable
    }
  }

  return {
    snapshot_id: `snap-${Date.now()}`,
    captured_at: new Date().toISOString(),
    task_count: taskFiles.length,
    runnable_task_count: runnableCount,
    agent_count: roster.agents.length,
    principal_runtime_available: runtimeSnapshots.size > 0,
    assignment_count: assignmentCount,
    report_count: reportCount,
    review_count: reviewCount,
  };
}
