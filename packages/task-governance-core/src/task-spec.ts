import type { TaskFrontMatter } from './task-governance.js';

export interface TaskSpecRecord {
  task_id: string;
  task_number: number;
  title: string;
  chapter: string | null;
  goal: string | null;
  context: string | null;
  required_work: string | null;
  non_goals: string | null;
  acceptance_criteria: string[];
  dependencies: number[];
  updated_at: string;
}

export interface TaskProjectionSections {
  executionNotes: string | null;
  verification: string | null;
  acceptanceCriteriaState: Array<{ text: string; checked: boolean }>;
}

export function extractSection(body: string, heading: string): string | null {
  const pattern = new RegExp(`##\\s*${escapeRegExp(heading)}\\s*\\n`, 'i');
  const match = body.match(pattern);
  if (!match) return null;
  const startIdx = match.index! + match[0].length;
  const nextHeading = body.slice(startIdx).match(/\n##\s/);
  const sectionEnd = nextHeading ? startIdx + nextHeading.index! : body.length;
  const text = body.slice(startIdx, sectionEnd).trim();
  return text.length > 0 ? text : null;
}

export function hasMaterialSection(body: string, heading: string): boolean {
  const section = extractSection(body, heading);
  if (section === null) return false;
  const withoutHtmlComments = section.replace(/<!--[\s\S]*?-->/g, '').trim();
  return withoutHtmlComments.length > 0;
}

export function extractTitle(body: string, fallback: string): string {
  const match = body.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() || fallback;
}

export function extractAcceptanceCriteriaState(
  body: string,
): Array<{ text: string; checked: boolean }> {
  const match = body.match(/##\s*Acceptance Criteria\s*\n/i);
  if (!match) return [];
  const startIdx = match.index! + match[0].length;
  const nextHeading = body.slice(startIdx).match(/\n##\s/);
  const sectionEnd = nextHeading ? startIdx + nextHeading.index! : body.length;
  const section = body.slice(startIdx, sectionEnd);

  const items: Array<{ text: string; checked: boolean }> = [];
  for (const line of section.split('\n')) {
    const trimmed = line.trim();
    const itemMatch = trimmed.match(/^-\s+\[([xX ])\]\s*(.*)$/);
    if (itemMatch) {
      items.push({
        text: itemMatch[2].trim(),
        checked: itemMatch[1].toLowerCase() === 'x',
      });
      continue;
    }
    const bulletMatch = trimmed.match(/^[-*]\s+(.*)$/);
    if (bulletMatch) {
      items.push({
        text: bulletMatch[1].trim(),
        checked: false,
      });
      continue;
    }
    const numberedMatch = trimmed.match(/^\d+\.\s+(.*)$/);
    if (numberedMatch) {
      items.push({
        text: numberedMatch[1].trim(),
        checked: false,
      });
    }
  }
  return items;
}

export function parseTaskSpecFromMarkdown(args: {
  taskId: string;
  taskNumber: number;
  frontMatter: TaskFrontMatter;
  body: string;
}): TaskSpecRecord {
  const { taskId, taskNumber, frontMatter, body } = args;
  const acceptanceCriteria = extractAcceptanceCriteriaState(body).map((item) => item.text);
  const dependsOn = Array.isArray(frontMatter.depends_on)
    ? frontMatter.depends_on
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value))
    : [];

  return {
    task_id: taskId,
    task_number: taskNumber,
    title: extractTitle(body, taskId),
    chapter: extractSection(body, 'Chapter'),
    goal: extractSection(body, 'Goal'),
    context: extractSection(body, 'Context'),
    required_work: extractSection(body, 'Required Work'),
    non_goals: extractSection(body, 'Non-Goals'),
    acceptance_criteria: acceptanceCriteria,
    dependencies: dependsOn,
    updated_at: new Date().toISOString(),
  };
}

export function extractProjectionSections(body: string): TaskProjectionSections {
  return {
    executionNotes: extractSection(body, 'Execution Notes'),
    verification: extractSection(body, 'Verification'),
    acceptanceCriteriaState: extractAcceptanceCriteriaState(body),
  };
}

export function mergeAcceptanceCriteriaState(
  specCriteria: string[],
  projectionState: Array<{ text: string; checked: boolean }>,
): Array<{ text: string; checked: boolean }> {
  if (specCriteria.length === 0) {
    return projectionState;
  }
  return specCriteria.map((text, index) => ({
    text,
    checked: projectionState[index]?.checked ?? false,
  }));
}

export function renderTaskBodyFromSpec(args: {
  spec: Pick<
    TaskSpecRecord,
    'title' | 'chapter' | 'goal' | 'context' | 'required_work' | 'non_goals' | 'acceptance_criteria'
  >;
  executionNotes?: string | null;
  verification?: string | null;
  acceptanceCriteriaState?: Array<{ text: string; checked: boolean }>;
}): string {
  const {
    spec,
    executionNotes,
    verification,
    acceptanceCriteriaState,
  } = args;

  const criteriaState =
    acceptanceCriteriaState && acceptanceCriteriaState.length > 0
      ? mergeAcceptanceCriteriaState(spec.acceptance_criteria, acceptanceCriteriaState)
      : spec.acceptance_criteria.map((text) => ({ text, checked: false }));

  const lines: string[] = [`# ${spec.title}`, ''];

  if (spec.chapter) {
    lines.push('## Chapter', '', spec.chapter, '');
  }

  lines.push('## Goal', '', spec.goal || spec.title, '');
  lines.push('## Context', '', spec.context || '<!-- Context placeholder -->', '');
  lines.push('## Required Work', '', spec.required_work || '1. TBD', '');
  lines.push(
    '## Non-Goals',
    '',
    spec.non_goals ||
      [
        '- Do not expand scope beyond this task.',
        '- Do not create derivative task-status files.',
        '- Do not mutate live external systems unless explicitly authorized.',
      ].join('\n'),
    '',
  );
  lines.push(
    '## Execution Notes',
    '',
    executionNotes || '<!-- Record what was done, decisions made, and files changed during execution. -->',
    '',
  );
  lines.push(
    '## Verification',
    '',
    verification || '<!-- Record commands run, results observed, and how correctness was checked. -->',
    '',
  );
  lines.push('## Acceptance Criteria', '');
  if (criteriaState.length > 0) {
    for (const item of criteriaState) {
      lines.push(`- [${item.checked ? 'x' : ' '}] ${item.text}`);
    }
  } else {
    lines.push('- [ ] TBD');
  }
  lines.push('');

  return lines.join('\n');
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
