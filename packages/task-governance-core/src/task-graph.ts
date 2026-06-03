/**
 * Task graph read model and Mermaid renderer.
 *
 * Inspection operator: read-only, non-authoritative.
 * Turns `.ai/do-not-open/tasks` into a human-observable graph.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  parseFrontMatter,
  loadRoster,
  isExecutableTaskFile,
  resolveExecutableTaskNumberOwnership,
  type TaskFrontMatter,
} from './task-governance.js';
import { openTaskLifecycleStore } from './task-lifecycle-store.js';

const TASKS_DIR = '.ai/do-not-open/tasks';

export interface TaskGraphNode {
  taskNumber: number;
  title: string;
  status: string;
  file: string;
  assignedAgentId?: string;
  kind: 'task' | 'chapter';
}

export interface TaskGraphEdge {
  from: number;
  to: number;
  kind: 'depends_on' | 'blocked_by';
  toKind: 'task' | 'chapter';
}

export interface TaskGraph {
  nodes: TaskGraphNode[];
  edges: TaskGraphEdge[];
}

export interface ReadTaskGraphOptions {
  cwd: string;
  includeClosed?: boolean;
  range?: { start: number; end: number };
  statusFilter?: string[];
}

interface RawTaskEntry {
  taskNumber: number;
  title: string;
  status: string;
  file: string;
  dependsOn: number[];
  blockedBy: number[];
  kind: 'task' | 'chapter';
}

/**
 * Read all task files and build the graph model.
 */
export async function readTaskGraph(options: ReadTaskGraphOptions): Promise<TaskGraph> {
  const cwd = resolve(options.cwd);
  const dir = join(cwd, TASKS_DIR);
  const files = await readdir(dir).catch(() => [] as string[]);
  const mdFiles = files.filter((f) => f.endsWith('.md'));
  const store = openTaskLifecycleStore(cwd);
  const ownership = await resolveExecutableTaskNumberOwnership(cwd, store);
  const specByNumber = new Map<number, { title: string; dependencies: number[] }>();
  try {
    const rows = store.db
      .prepare('select task_number, title, dependencies_json from task_specs')
      .all() as Array<{ task_number: number; title: string; dependencies_json: string }>;
    for (const row of rows) {
      specByNumber.set(Number(row.task_number), {
        title: String(row.title),
        dependencies: JSON.parse(String(row.dependencies_json)) as number[],
      });
    }
  } finally {
    store.db.close();
  }

  const entries: RawTaskEntry[] = [];

  for (const file of mdFiles) {
    const content = await readFile(join(dir, file), 'utf8').catch(() => null);
    if (!content) continue;

    const { frontMatter, body } = parseFrontMatter(content);
    const status = String(frontMatter.status ?? 'unknown');

    const base = file.replace(/\.md$/, '');
    const numMatch = base.match(/-(\d+)-/);
    const taskNumber = numMatch ? Number(numMatch[1]) : (typeof frontMatter.task_id === 'number' ? frontMatter.task_id : null);
    if (taskNumber === null) continue;

    // Detect chapter files by range pattern: DATE-START-END-...
    const isChapter = /^[0-9]{8}-[0-9]+-[0-9]+/.test(base);
    if (!isChapter && isExecutableTaskFile(file)) {
      if (ownership.conflictedNumbers.has(taskNumber)) continue;
      const ownerTaskId = ownership.ownerByNumber.get(taskNumber);
      if (ownerTaskId && ownerTaskId !== base) continue;
    }

    const spec = specByNumber.get(taskNumber);
    const title = spec?.title ?? base;

    const dependsOn = spec?.dependencies ?? normalizeNumberArray(frontMatter.depends_on);
    const blockedBy = normalizeNumberArray(frontMatter.blocked_by);

    entries.push({
      taskNumber,
      title,
      status,
      file: base,
      dependsOn,
      blockedBy,
      kind: isChapter ? 'chapter' : 'task',
    });
  }

  // Sort by task number for stability
  entries.sort((a, b) => a.taskNumber - b.taskNumber);

  // Load roster for assignment overlay
  let assignedByTaskNumber: Map<number, string> | undefined;
  try {
    const roster = await loadRoster(cwd);
    assignedByTaskNumber = new Map<number, string>();
    for (const agent of roster.agents) {
      if (agent.task != null) {
        assignedByTaskNumber.set(agent.task, agent.agent_id);
      }
    }
  } catch {
    // Roster may not exist; proceed without assignments
  }

  // Build full node list
  const allNodes: TaskGraphNode[] = entries.map((e) => ({
    taskNumber: e.taskNumber,
    title: e.title,
    status: e.status,
    file: e.file,
    assignedAgentId: assignedByTaskNumber?.get(e.taskNumber),
    kind: e.kind,
  }));

  // Build full edge list
  const allEdges: TaskGraphEdge[] = [];
  for (const entry of entries) {
    for (const dep of entry.dependsOn) {
      allEdges.push({ from: dep, to: entry.taskNumber, kind: 'depends_on', toKind: entry.kind });
    }
    for (const blocker of entry.blockedBy) {
      allEdges.push({ from: blocker, to: entry.taskNumber, kind: 'blocked_by', toKind: entry.kind });
    }
  }

  // Apply filters
  const isClosed = (status: string) => status === 'closed' || status === 'confirmed';
  const terminalStatuses = ['closed', 'confirmed'];

  let visibleNodes = allNodes;

  // Range filter
  if (options.range) {
    visibleNodes = visibleNodes.filter(
      (n) => n.taskNumber >= options.range!.start && n.taskNumber <= options.range!.end,
    );
  }

  // Status filter
  if (options.statusFilter && options.statusFilter.length > 0) {
    visibleNodes = visibleNodes.filter((n) => options.statusFilter!.includes(n.status));
  }

  // Closed filter (default: exclude unless included)
  if (!options.includeClosed) {
    visibleNodes = visibleNodes.filter((n) => !isClosed(n.status));
  }

  const visibleNumbers = new Set(visibleNodes.map((n) => n.taskNumber));

  // Include closed dependency context: if a visible node depends on a filtered-out
  // node, include that dependency as a compact node
  const dependencyContextNodes = new Map<number, TaskGraphNode>();
  for (const edge of allEdges) {
    if (visibleNumbers.has(edge.to) && !visibleNumbers.has(edge.from)) {
      // Prefer task nodes over chapter nodes for dependency context
      const depNode = allNodes.find((n) => n.taskNumber === edge.from && n.kind === 'task')
        ?? allNodes.find((n) => n.taskNumber === edge.from);
      if (depNode) {
        dependencyContextNodes.set(edge.from, depNode);
      }
    }
  }

  const mergedNodes = [...visibleNodes];
  for (const depNode of dependencyContextNodes.values()) {
    if (!visibleNumbers.has(depNode.taskNumber)) {
      mergedNodes.push(depNode);
    }
  }
  mergedNodes.sort((a, b) => a.taskNumber - b.taskNumber);

  const mergedNumbers = new Set(mergedNodes.map((n) => n.taskNumber));

  // Keep only edges where both ends are visible
  const visibleEdges = allEdges.filter(
    (e) => mergedNumbers.has(e.from) && mergedNumbers.has(e.to),
  );

  return { nodes: mergedNodes, edges: visibleEdges };
}

function normalizeNumberArray(value: unknown): number[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is number => typeof v === 'number');
  }
  return [];
}

/**
 * Render the task graph as Mermaid flowchart TD.
 */
export function renderMermaid(graph: TaskGraph): string {
  const lines: string[] = ['flowchart TD'];

  for (const node of graph.nodes) {
    const id = mermaidNodeId(node);
    const label = mermaidNodeLabel(node);
    lines.push(`  ${id}["${label}"]`);
  }

  // De-duplicate edges by string representation
  const edgeLines = new Set<string>();
  for (const edge of graph.edges) {
    const fromId = mermaidNodeIdForNumber(graph, edge.from, 'task');
    const toId = mermaidNodeIdForNumber(graph, edge.to, edge.toKind);
    const line = edge.kind === 'blocked_by'
      ? `  ${fromId} -.->|blocked| ${toId}`
      : `  ${fromId} --> ${toId}`;
    edgeLines.add(line);
  }
  for (const line of edgeLines) {
    lines.push(line);
  }

  return lines.join('\n') + '\n';
}

function mermaidNodeId(node: TaskGraphNode): string {
  return node.kind === 'chapter' ? `C${node.taskNumber}` : `T${node.taskNumber}`;
}

function mermaidNodeIdForNumber(graph: TaskGraph, taskNumber: number, preferredKind: 'task' | 'chapter'): string {
  // Look for node matching the preferred kind first, then fallback
  const node = graph.nodes.find((n) => n.taskNumber === taskNumber && n.kind === preferredKind)
    ?? graph.nodes.find((n) => n.taskNumber === taskNumber);
  return node ? mermaidNodeId(node) : `T${taskNumber}`;
}

function mermaidNodeLabel(node: TaskGraphNode): string {
  const parts: string[] = [String(node.taskNumber)];

  const title = node.title
    .replace(/"/g, '&quot;')
    .replace(/\[/g, '&#91;')
    .replace(/\]/g, '&#93;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  parts.push(title);

  parts.push(node.status);

  if (node.assignedAgentId) {
    parts.push(`working: ${node.assignedAgentId}`);
  }

  return parts.join('<br/>');
}

/**
 * Render the task graph as explicit JSON.
 */
export interface TaskGraphJson {
  nodes: Array<{
    task_number: number;
    title: string;
    status: string;
    file: string;
    assigned_agent_id: string | null;
    kind: 'task' | 'chapter';
  }>;
  edges: Array<{
    from: number;
    to: number;
    kind: 'depends_on' | 'blocked_by';
  }>;
}

export function renderJson(graph: TaskGraph): TaskGraphJson {
  return {
    nodes: graph.nodes.map((n) => ({
      task_number: n.taskNumber,
      title: n.title,
      status: n.status,
      file: n.file,
      assigned_agent_id: n.assignedAgentId ?? null,
      kind: n.kind,
    })),
    edges: graph.edges.map((e) => ({
      from: e.from,
      to: e.to,
      kind: e.kind,
    })),
  };
}
