import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ExitCode } from './exit-codes.js';
import {
  extractTaskNumberFromFileName,
  parseFrontMatter,
} from './task-governance.js';
import { openTaskLifecycleStore, type TaskLifecycleStore } from './task-lifecycle-store.js';

const TASKS_DIR = '.ai/do-not-open/tasks';
const DERIVATIVE_SUFFIXES = ['-EXECUTED.md', '-DONE.md', '-RESULT.md', '-FINAL.md', '-SUPERSEDED.md'];

export interface TaskSearchServiceOptions {
  query: string;
  cwd?: string;
  maxSnippets?: number;
}

export interface TaskSearchResult {
  task_id: string;
  task_number: number | null;
  status: string | undefined;
  title: string | undefined;
  matches: string[];
}

export interface TaskSearchServiceResult {
  status: 'success' | 'error';
  query?: string;
  count?: number;
  results?: TaskSearchResult[];
  error?: string;
}

function isDerivative(fileName: string): boolean {
  return DERIVATIVE_SUFFIXES.some((suffix) => fileName.endsWith(suffix));
}

function extractTitle(body: string): string | undefined {
  const heading = body.match(/^#\s+(.+)$/m);
  return heading ? heading[1].trim() : undefined;
}

export function findTaskSearchMatches(content: string, query: string, maxSnippets = 3): string[] {
  const lowerContent = content.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const snippets: string[] = [];
  let idx = 0;

  while (snippets.length < maxSnippets) {
    const found = lowerContent.indexOf(lowerQuery, idx);
    if (found === -1) break;

    const start = Math.max(0, found - 60);
    const end = Math.min(content.length, found + query.length + 60);
    let snippet = content.slice(start, end).replace(/\s+/g, ' ').trim();
    if (start > 0) snippet = '...' + snippet;
    if (end < content.length) snippet = snippet + '...';
    snippets.push(snippet);

    idx = found + query.length;
  }

  return snippets;
}

function loadMetadataMaps(cwd: string): {
  store: TaskLifecycleStore | null;
  lifecycleByNumber: Map<number, string>;
  specTitleByNumber: Map<number, string>;
} {
  const lifecycleByNumber = new Map<number, string>();
  const specTitleByNumber = new Map<number, string>();

  try {
    const store = openTaskLifecycleStore(cwd);
    for (const row of store.getAllLifecycle()) {
      lifecycleByNumber.set(row.task_number, row.status);
    }
    for (const row of store.db
      .prepare('select task_number, title from task_specs')
      .all() as Array<{ task_number: number; title: string }>) {
      specTitleByNumber.set(Number(row.task_number), String(row.title));
    }
    return { store, lifecycleByNumber, specTitleByNumber };
  } catch {
    return { store: null, lifecycleByNumber, specTitleByNumber };
  }
}

export async function searchTasksService(
  options: TaskSearchServiceOptions,
): Promise<{ exitCode: ExitCode; result: TaskSearchServiceResult }> {
  const cwd = options.cwd ? resolve(options.cwd) : process.cwd();
  const query = options.query.trim();

  if (!query) {
    return {
      exitCode: ExitCode.GENERAL_ERROR,
      result: { status: 'error', error: 'Search query is required' },
    };
  }

  const dir = join(cwd, TASKS_DIR);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return {
      exitCode: ExitCode.GENERAL_ERROR,
      result: { status: 'error', error: `Cannot read tasks directory: ${dir}` },
    };
  }

  const mdFiles = files.filter((f) => f.endsWith('.md') && !isDerivative(f));
  const results: TaskSearchResult[] = [];
  const { store, lifecycleByNumber, specTitleByNumber } = loadMetadataMaps(cwd);

  try {
    for (const f of mdFiles) {
      const content = await readFile(join(dir, f), 'utf8');
      if (!content.toLowerCase().includes(query.toLowerCase())) continue;

      const { frontMatter, body } = parseFrontMatter(content);
      const taskNumber = extractTaskNumberFromFileName(f);
      const title = taskNumber !== null
        ? (specTitleByNumber.get(taskNumber) ?? extractTitle(body))
        : extractTitle(body);
      const status = taskNumber !== null
        ? (lifecycleByNumber.get(taskNumber) ?? frontMatter.status as string | undefined)
        : frontMatter.status as string | undefined;

      results.push({
        task_id: f.replace(/\.md$/, ''),
        task_number: taskNumber,
        status,
        title,
        matches: findTaskSearchMatches(content, query, options.maxSnippets),
      });
    }
  } finally {
    if (store) {
      try { store.db.close(); } catch { /* ignore close failure */ }
    }
  }

  results.sort((a, b) => (b.task_number ?? 0) - (a.task_number ?? 0));

  return {
    exitCode: ExitCode.SUCCESS,
    result: {
      status: 'success',
      query,
      count: results.length,
      results,
    },
  };
}
