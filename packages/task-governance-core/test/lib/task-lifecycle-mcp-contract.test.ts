import { describe, expect, it } from 'vitest';
import {
  TASK_LIFECYCLE_TOOL_ALIASES,
  normalizeTaskLifecycleToolName,
  taskLifecycleDomainTools,
} from '../../src/task-lifecycle-mcp-contract.js';

describe('task lifecycle MCP contract', () => {
  it('publishes the canonical domain tool registry without transport tools', () => {
    const tools = taskLifecycleDomainTools();
    const names = tools.map((tool) => tool.name);

    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('task_lifecycle_finish');
    expect(names).toContain('task_lifecycle_next');
    expect(names).toContain('task_lifecycle_recurring_run_due');
    expect(names).toContain('task_lifecycle_set_routing');
    expect(names).not.toContain('mcp_payload_create');
    expect(names).not.toContain('mcp_output_show');

    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.inputSchema).not.toHaveProperty('anyOf');
      expect(tool.inputSchema).not.toHaveProperty('oneOf');
      expect(tool.inputSchema).not.toHaveProperty('allOf');
      expect(tool.inputSchema).not.toHaveProperty('not');
    }
  });

  it('keeps legacy and readable aliases stable', () => {
    expect(TASK_LIFECYCLE_TOOL_ALIASES.task_mcp_claim).toBe('task_lifecycle_claim');
    expect(TASK_LIFECYCLE_TOOL_ALIASES.task_mcp_un_defer).toBe('task_lifecycle_un_defer');
    expect(TASK_LIFECYCLE_TOOL_ALIASES.task_mcp_undefer).toBe('task_lifecycle_un_defer');
    expect(TASK_LIFECYCLE_TOOL_ALIASES.task_mcp_inbox_target).toBe('task_lifecycle_inbox_target');
    expect(TASK_LIFECYCLE_TOOL_ALIASES.task_lifecycle_closeout).toBe('task_lifecycle_disposition_closeout');
    expect(TASK_LIFECYCLE_TOOL_ALIASES.task_lifecycle_record_observation).toBe('task_lifecycle_submit_observation');
    expect(TASK_LIFECYCLE_TOOL_ALIASES.task_lifecycle_submit_report).toBe('task_lifecycle_finish');
    expect(TASK_LIFECYCLE_TOOL_ALIASES.task_lifecycle_d_af077406ea2f).toBe('task_lifecycle_disposition_closeout');
    expect(TASK_LIFECYCLE_TOOL_ALIASES.task_lifecycle_s_f5e0b1532dcf).toBe('task_lifecycle_submit_observation');
    expect(normalizeTaskLifecycleToolName('task_mcp_claim')).toBe('task_lifecycle_claim');
    expect(normalizeTaskLifecycleToolName('task_lifecycle_finish')).toBe('task_lifecycle_finish');
  });

  it('exposes long-payload recovery and resident directive reporting fields on finish', () => {
    const tools = new Map(taskLifecycleDomainTools().map((tool) => [tool.name, tool]));
    const finish = tools.get('task_lifecycle_finish')?.inputSchema.properties ?? {};
    const submitReport = tools.get('task_lifecycle_submit_report')?.inputSchema.properties ?? {};

    for (const schema of [finish, submitReport]) {
      expect(schema.payload_ref).toBeTruthy();
      expect(schema.directive_id).toBeTruthy();
      expect(schema.reviewer).toBeTruthy();
      expect(schema.changed_files).toBeTruthy();
      expect(schema.no_files_changed).toBeTruthy();
      expect(schema.verdict?.type).toBe('string');
      expect(schema.verdict?.description).toMatch(/Review-state verdict only/);
      expect(schema.verdict?.description).toMatch(/Omit for claimed-state finish/);
      expect(schema.payload_ref?.description).toMatch(/top-level task_number and agent_id win/);
    }
  });

  it('keeps compact next-work fields in the canonical contract', () => {
    const tools = new Map(taskLifecycleDomainTools().map((tool) => [tool.name, tool]));
    const next = tools.get('task_lifecycle_next')?.inputSchema.properties ?? {};

    expect(next.view).toBeTruthy();
    expect(next.concise).toBeTruthy();
  });
});
