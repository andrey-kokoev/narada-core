import { describe, expect, it, beforeEach, afterEach } from "vitest";
import Database from "../../src/sqlite-database.js";
import {
  SqliteDirectiveRuntimeStore,
  directiveStatusForAgent,
  leaseExpiryIso,
  leaseId,
} from "../../src/directive-runtime-store.js";

describe("SqliteDirectiveRuntimeStore", () => {
  let db: Database;
  let store: SqliteDirectiveRuntimeStore;

  beforeEach(() => {
    db = new Database(":memory:");
    store = new SqliteDirectiveRuntimeStore({ db });
    store.initSchema();
  });

  afterEach(() => {
    db.close();
  });

  it("creates directive runtime tables in the task lifecycle database", () => {
    const tables = db.prepare("select name from sqlite_master where type = 'table'").all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toContain("directive_records");
    expect(tables.map((row) => row.name)).toContain("directive_delivery_attempts");
    expect(tables.map((row) => row.name)).toContain("directive_receipts");
    expect(tables.map((row) => row.name)).toContain("directive_triage_records");
  });

  it("emits one idempotent resident directive for admitted work", () => {
    const first = store.emitResidentDirectiveForAdmittedWork({
      siteId: "narada-sonar",
      authorityLocus: "narada_sonar",
      systemEmitterId: "narada-sonar.system.directive_emitter",
      residentAgentId: "sonar.resident",
      residentRole: "resident",
      taskId: "task-123",
      taskNumber: 123,
      transitionId: "transition-1",
      title: "Investigate support ticket",
      admittedAt: "2026-05-28T00:00:00.000Z",
    });
    const second = store.emitResidentDirectiveForAdmittedWork({
      siteId: "narada-sonar",
      authorityLocus: "narada_sonar",
      systemEmitterId: "narada-sonar.system.directive_emitter",
      residentAgentId: "sonar.resident",
      residentRole: "resident",
      taskId: "task-123",
      taskNumber: 123,
      transitionId: "transition-1",
      title: "Investigate support ticket",
      admittedAt: "2026-05-28T00:00:00.000Z",
    });

    expect(first.isNew).toBe(true);
    expect(second.isNew).toBe(false);
    expect(second.directive.directive_id).toBe(first.directive.directive_id);
    expect(store.listPending({ target: { kind: "agent", id: "sonar.resident" } })).toHaveLength(1);
  });

  it("allows a later work transition to emit a distinct resident directive", () => {
    const base = {
      siteId: "narada-sonar",
      authorityLocus: "narada_sonar",
      systemEmitterId: "narada-sonar.system.directive_emitter",
      residentAgentId: "sonar.resident",
      taskId: "task-123",
      admittedAt: "2026-05-28T00:00:00.000Z",
    };
    const first = store.emitResidentDirectiveForAdmittedWork({ ...base, transitionId: "admitted" });
    const updated = store.emitResidentDirectiveForAdmittedWork({ ...base, transitionId: "reopened" });

    expect(first.directive.directive_id).not.toBe(updated.directive.directive_id);
    expect(store.listPending({ target: { kind: "agent", id: "sonar.resident" } })).toHaveLength(2);
    expect(updated.directive.authority.basis).toBe("task_admission_transition:reopened");
  });

  it("leases delivery, records receipt, and records triage separately", () => {
    const { directive } = store.emitResidentDirectiveForAdmittedWork({
      siteId: "narada-sonar",
      authorityLocus: "narada_sonar",
      systemEmitterId: "narada-sonar.system.directive_emitter",
      residentAgentId: "sonar.resident",
      taskId: "task-123",
    });
    const lease = store.leaseDelivery(directive.directive_id, {
      leaseId: leaseId(directive.directive_id, "carrier-1", "2026-05-28T00:00:00.000Z"),
      leasedUntil: leaseExpiryIso(5),
      transport: "nars_jsonl_stdio",
      carrierSessionId: "carrier-1",
    });
    const receipt = store.recordReceipt(directive.directive_id, {
      received_at: "2026-05-28T00:01:00.000Z",
      carrier_session_id: "carrier-1",
      agent_id: "sonar.resident",
      transport: "nars_jsonl_stdio",
    });
    const triage = store.recordTriage(directive.directive_id, {
      triaged_at: "2026-05-28T00:02:00.000Z",
      agent_id: "sonar.resident",
      status: "accepted",
      selected_work_ref: { kind: "task", id: "task-123", locus: "narada-sonar" },
    });

    expect(lease.status).toBe("leased");
    expect(receipt.receipt_id).toMatch(/^dirrcpt_/);
    expect(triage.status).toBe("accepted");
    expect(store.getDirective(directive.directive_id)?.delivery?.status).toBe("receipt_recorded");
  });

  it("queries pending directives for an agent and its role", () => {
    store.emitResidentDirectiveForAdmittedWork({
      siteId: "narada-sonar",
      authorityLocus: "narada_sonar",
      systemEmitterId: "narada-sonar.system.directive_emitter",
      residentRole: "resident",
      taskId: "task-123",
    });
    const status = directiveStatusForAgent(store, { agentId: "sonar.resident", role: "resident" });
    expect(status.target).toContainEqual({ kind: "role", id: "resident" });
    expect(status.pending).toHaveLength(1);
  });
});
