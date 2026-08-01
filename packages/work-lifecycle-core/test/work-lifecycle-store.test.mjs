import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareTaskLifecycleStore } from '@narada-core/task-governance-core/task-lifecycle-store';
import {
  migrateLegacyTaskLifecycleToWorkLifecycle,
  openPreparedWorkLifecycleStore,
  prepareWorkLifecycleStore,
} from '../dist/index.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'narada-work-lifecycle-'));
  const inspection = prepareWorkLifecycleStore(root);
  assert.equal(inspection.status, 'prepared');
  const store = openPreparedWorkLifecycleStore(root, {
    writerId: 'test-writer',
    writerLeaseMs: 60_000,
  });
  return {
    root,
    store,
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function source(overrides = {}) {
  const immutable = overrides.immutable_source_id ?? 'message-1';
  return {
    source_kind: 'mailbox_message',
    source_scope: 'help@global-maxima.com',
    immutable_source_id: immutable,
    idempotency_key: `admit:${immutable}`,
    causation_id: `sync:${immutable}`,
    policy_version: 'admission-v1',
    summary: `Message ${immutable}`,
    source_ref: { mailbox_id: 'help@global-maxima.com', message_id: immutable },
    correlation_keys: [{
      kind: 'conversation_id',
      scope: 'help@global-maxima.com',
      value: overrides.conversation ?? 'conversation-1',
    }],
    ...overrides,
  };
}

test('source admission is canonical, idempotent, and fenced to one writer', () => {
  const f = fixture();
  try {
    const first = f.store.admitSource(source());
    assert.equal(first.status, 'created');
    const replay = f.store.admitSource(source());
    assert.equal(replay.status, 'created');
    assert.equal(replay.ticket_id, first.ticket_id);
    assert.equal(f.store.listTickets().length, 1);
    assert.equal(f.store.listTicketSources(first.ticket_id).length, 1);

    assert.throws(
      () => openPreparedWorkLifecycleStore(f.root, {
        writerId: 'second-writer',
        writerLeaseMs: 60_000,
      }),
      /work_lifecycle_writer_authority_held:test-writer/,
    );
  } finally {
    f.close();
  }
});

test('hard cutover migrates task evidence and active tickets while omitting Site Loop tables', () => {
  const root = mkdtempSync(join(tmpdir(), 'narada-work-cutover-'));
  const sourcePath = join(root, '.ai', 'task-lifecycle.db');
  const targetPath = join(root, '.ai', 'work-lifecycle.db');
  const legacy = prepareTaskLifecycleStore(root, { databasePath: sourcePath });
  try {
    legacy.upsertLifecycle({
      task_id: 'legacy-task-1',
      task_number: 41,
      status: 'opened',
      governed_by: null,
      closed_at: null,
      closed_by: null,
      closure_mode: null,
      reopened_at: null,
      reopened_by: null,
      continuation_packet_json: null,
      updated_at: '2026-01-01T00:00:00.000Z',
    });
    legacy.upsertTaskSpec({
      task_id: 'legacy-task-1',
      task_number: 41,
      title: 'Migrated task',
      chapter_markdown: null,
      goal_markdown: 'Preserve this task.',
      context_markdown: null,
      required_work_markdown: 'Verify migration.',
      non_goals_markdown: null,
      acceptance_criteria_json: '["Task is present."]',
      dependencies_json: '[]',
      tags_json: '["migration"]',
      updated_at: '2026-01-01T00:00:00.000Z',
    });
    legacy.db.exec(`
      create table directive_extension_records (
        record_id text primary key,
        task_id text not null,
        payload_ref text not null
      );
      insert into directive_extension_records values ('directive-1', 'legacy-task-1', 'artifact:1');
      create table site_loop_runs (run_id text primary key, transcript text not null);
      insert into site_loop_runs values ('legacy-loop-run', 'large legacy payload');
    `);
  } finally {
    legacy.db.close();
  }

  try {
    const report = migrateLegacyTaskLifecycleToWorkLifecycle(root, {
      sourceDatabasePath: sourcePath,
      targetDatabasePath: targetPath,
      now: () => new Date('2026-01-02T00:00:00.000Z'),
      ticketSeeds: [
        {
          legacy_ticket_id: 'legacy-mail-1',
          target_status: 'blocked',
          blocker_code: 'operator_disposition_required',
          blocker_summary: 'Legacy parked ticket requires operator disposition.',
          source: source({
            immutable_source_id: 'legacy-message-1',
            idempotency_key: 'hard-cutover:legacy-mail-1',
            causation_id: 'hard-cutover:legacy-mail-1',
            conversation: 'legacy-conversation-1',
          }),
        },
        {
          legacy_ticket_id: 'legacy-intake-1',
          target_status: 'actionable',
          source: source({
            source_kind: 'operator_intake',
            source_scope: 'sonar',
            immutable_source_id: 'legacy-intake-1',
            idempotency_key: 'hard-cutover:legacy-intake-1',
            causation_id: 'hard-cutover:legacy-intake-1',
            conversation: 'legacy-intake-1',
          }),
        },
      ],
    });
    assert.equal(report.status, 'migrated');
    assert.equal(report.task_rows, 1);
    assert.equal(report.task_events_seeded, 1);
    assert.equal(report.foreign_key_violations, 0);
    assert.equal(report.source_integrity, 'ok');
    assert.equal(report.source_integrity_scope, 'copied_tables_only');
    assert.equal(report.source_integrity_tables.includes('task_lifecycle'), true);
    assert.equal(report.source_integrity_tables.includes('site_loop_runs'), false);
    assert.deepEqual(report.excluded_legacy_tables, [{
      table: 'site_loop_runs',
      disposition: 'discarded_without_scan',
    }]);
    assert.equal(report.ticket_mappings.length, 2);
    assert.equal(existsSync(sourcePath), true, 'source is retained until the caller verifies and deletes it');
    assert.equal(existsSync(`${targetPath}-wal`), false, 'migration leaves a self-contained promotable database');
    assert.equal(existsSync(`${targetPath}-shm`), false, 'migration leaves no shared-memory sidecar');

    const migrated = openPreparedWorkLifecycleStore(root, {
      databasePath: targetPath,
      writerId: 'migration-verifier',
    });
    try {
      assert.equal(migrated.taskStore.getLifecycle('legacy-task-1').task_number, 41);
      assert.equal(migrated.db.prepare('select count(*) as count from task_specs').get().count, 1);
      assert.equal(migrated.db.prepare('select count(*) as count from directive_extension_records').get().count, 1);
      assert.equal(migrated.db.prepare("select count(*) as count from sqlite_master where type = 'table' and name = 'site_loop_runs'").get().count, 0);
      assert.deepEqual(migrated.listTickets().map((ticket) => ticket.status).sort(), ['actionable', 'blocked']);
      assert.equal(migrated.listOutbox('scheduler', { topics: ['work.ticket-work-due.v1'] }).length, 1);
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('trusted correlation attaches and ambiguity blocks without association', () => {
  const f = fixture();
  try {
    const first = f.store.admitSource(source());
    const attached = f.store.admitSource(source({
      immutable_source_id: 'message-2',
      idempotency_key: 'admit:message-2',
    }));
    assert.equal(attached.status, 'attached');
    assert.equal(attached.ticket_id, first.ticket_id);

    const second = f.store.admitSource(source({
      immutable_source_id: 'message-3',
      idempotency_key: 'admit:message-3',
      conversation: 'conversation-2',
    }));
    assert.equal(second.status, 'created');

    const ambiguous = f.store.admitSource(source({
      immutable_source_id: 'message-4',
      idempotency_key: 'admit:message-4',
      correlation_keys: [
        { kind: 'conversation_id', scope: 'help@global-maxima.com', value: 'conversation-1' },
        { kind: 'conversation_id', scope: 'help@global-maxima.com', value: 'conversation-2' },
      ],
    }));
    assert.equal(ambiguous.status, 'blocked');
    assert.deepEqual(ambiguous.candidate_ticket_ids, [first.ticket_id, second.ticket_id].sort());
    assert.equal(f.store.listTicketSources(first.ticket_id).length, 2);
    assert.equal(f.store.listTicketSources(second.ticket_id).length, 1);
  } finally {
    f.close();
  }
});

test('ticket processing context is bounded, event-bound, and frozen by its operation key', () => {
  const f = fixture();
  try {
    const first = f.store.admitSource(source());
    const input = {
      ticket_id: first.ticket_id,
      triggering_event_id: first.event_id,
      idempotency_key: 'processing-context:event-1',
    };
    const loaded = f.store.loadTicketProcessingContext(input);
    assert.equal(loaded.ticket.revision, first.ticket_revision);
    assert.equal(loaded.triggering_event.event_id, first.event_id);
    assert.equal(loaded.triggering_event.topic, 'work.ticket-work-due.v1');
    assert.equal(loaded.sources.length, 1);
    assert.deepEqual(loaded.truncated, {
      sources: false,
      task_links: false,
      draft_refs: false,
    });

    f.store.admitSource(source({
      immutable_source_id: 'message-after-load',
      idempotency_key: 'admit:message-after-load',
    }));
    const replayed = f.store.loadTicketProcessingContext(input);
    assert.deepEqual(replayed, loaded);
    assert.throws(() => f.store.loadTicketProcessingContext({
      ...input,
      triggering_event_id: 'not-the-same-event',
    }), /work_operation_idempotency_conflict/);
  } finally {
    f.close();
  }
});

test('follow-up task creation and terminal reactivation are one-database events', () => {
  const f = fixture();
  try {
    const admitted = f.store.admitSource(source());
    const proposal = f.store.admitProposal({
      ticket_id: admitted.ticket_id,
      expected_revision: admitted.ticket_revision,
      route: 'followup_task',
      idempotency_key: 'proposal:task:1',
      causation_id: admitted.event_id,
      actor_id: 'agent-test',
      summary: 'Investigate the customer report.',
      task: {
        title: 'Investigate ticket',
        goal: 'Determine the root cause.',
        required_work: 'Inspect bounded evidence and report an outcome.',
        acceptance_criteria: ['A verified outcome is recorded.'],
      },
    });
    assert.equal(proposal.route, 'followup_task');
    assert.equal(f.store.getTicket(admitted.ticket_id).status, 'waiting_on_task');
    const taskBefore = f.store.taskStore.getLifecycle(proposal.task_id);
    assert.equal(taskBefore.status, 'opened');
    assert.ok(Number.isInteger(taskBefore.revision));

    f.store.taskStore.updateStatus(proposal.task_id, 'closed', 'test', {
      closed_at: new Date().toISOString(),
      closed_by: 'test',
    });
    const taskAfter = f.store.taskStore.getLifecycle(proposal.task_id);
    assert.equal(taskAfter.revision, taskBefore.revision + 1);
    const ticketAfter = f.store.getTicket(admitted.ticket_id);
    assert.equal(ticketAfter.status, 'actionable');
    assert.equal(ticketAfter.revision, proposal.ticket_revision + 1);
    const due = f.store.listOutbox('scheduler-test', {
      topics: ['work.ticket-work-due.v1'],
    });
    assert.equal(due.filter((event) => event.aggregate_id === admitted.ticket_id).length, 2);
  } finally {
    f.close();
  }
});

test('stale proposals fail closed and newer evidence supersedes draft claims', () => {
  const f = fixture();
  try {
    const admitted = f.store.admitSource(source());
    assert.throws(() => f.store.admitProposal({
      ticket_id: admitted.ticket_id,
      expected_revision: admitted.ticket_revision + 1,
      route: 'resolved',
      idempotency_key: 'proposal:stale',
      causation_id: admitted.event_id,
      actor_id: 'agent-test',
      summary: 'Stale resolution.',
      resolution_code: 'answered',
    }), /ticket_revision_conflict/);

    const claim = f.store.admitProposal({
      ticket_id: admitted.ticket_id,
      expected_revision: admitted.ticket_revision,
      route: 'response_draft',
      idempotency_key: 'proposal:draft:1',
      causation_id: admitted.event_id,
      actor_id: 'agent-test',
      summary: 'Prepare a reply.',
      draft: {
        source_id: admitted.source_id,
        reply_mode: 'reply_all',
        body_text: 'Thank you. We are investigating this request.',
      },
    });
    assert.match(claim.draft_operation_key, /^draft_operation_/);
    const newer = f.store.admitSource(source({
      immutable_source_id: 'message-newer',
      idempotency_key: 'admit:message-newer',
    }));
    assert.equal(newer.status, 'attached');
    const receipt = f.store.recordDraftReceipt({
      ticket_id: admitted.ticket_id,
      effect_claim_id: claim.effect_claim_id,
      draft_operation_key: claim.draft_operation_key,
      draft_request_digest: claim.draft_request_digest,
      receipt_id: 'graph-receipt-1',
      draft_id: 'draft-1',
      draft_ref: { message_id: 'draft-1' },
      idempotency_key: 'record-draft-receipt:1',
      causation_id: 'graph-receipt-1',
    });
    assert.equal(receipt.status, 'superseded');
    assert.equal(receipt.ticket.revision, newer.ticket_revision);
  } finally {
    f.close();
  }
});

test('bounded refs reject bodies and acknowledged outbox payloads compact', () => {
  const f = fixture();
  try {
    assert.throws(
      () => f.store.admitSource(source({
        immutable_source_id: 'message-body',
        idempotency_key: 'admit:message-body',
        source_ref: { message_id: 'message-body', body: 'not allowed' },
      })),
      /source_ref_contains_unbounded_payload/,
    );
    const admitted = f.store.admitSource(source());
    f.store.registerOutboxConsumer('work.ticket-work-due.v1', 'scheduler');
    const [event] = f.store.listOutbox('scheduler', {
      topics: ['work.ticket-work-due.v1'],
    });
    assert.equal(event.event_id, admitted.event_id);
    f.store.acknowledgeOutbox(event.event_id, 'scheduler', { activation_id: 'activation-1' });
    const compacted = f.store.compactAcknowledgedOutbox('2999-01-01T00:00:00.000Z');
    assert.equal(compacted.compacted, 1);
    assert.equal(f.store.inspectStorageBounds().status, 'ok');
  } finally {
    f.close();
  }
});
