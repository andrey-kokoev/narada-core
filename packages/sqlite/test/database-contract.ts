import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface ContractStatement {
  all(...args: unknown[]): unknown[];
  get(...args: unknown[]): unknown;
  iterate(...args: unknown[]): IterableIterator<unknown>;
  run(...args: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  pluck(): ContractStatement;
}

interface ContractDatabase {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): ContractStatement;
  pragma(source: string): unknown;
  transaction<TArgs extends unknown[], TResult>(fn: (...args: TArgs) => TResult): (...args: TArgs) => TResult;
}

export type DatabaseConstructor = new (
  path: string,
  options?: { fileMustExist?: boolean; readOnly?: boolean; readonly?: boolean },
) => ContractDatabase;

export function runDatabaseContract(DatabaseSync: DatabaseConstructor): void {
  const root = mkdtempSync(join(tmpdir(), "narada-sqlite-contract-"));
  const path = join(root, "contract.db");

  try {
    const db = new DatabaseSync(path);
    db.exec("create table items (id integer primary key, label text not null, quantity integer not null)");

    const inserted = db.prepare("insert into items(label, quantity) values (?, ?)").run("alpha", 2);
    assert.equal(inserted.changes, 1);
    assert.equal(typeof inserted.lastInsertRowid === "number" || typeof inserted.lastInsertRowid === "bigint", true);

    const alpha = db.prepare("select label, quantity from items where label = ?").get("alpha") as Record<string, unknown>;
    assert.equal(alpha.label, "alpha");
    assert.equal(alpha.quantity, 2);
    assert.equal(db.prepare("select label from items where label = ?").get("missing"), undefined);

    db.prepare("insert into items(label, quantity) values ($label, $quantity)").run({ $label: "beta", $quantity: 3 });
    const labels = db
      .prepare("select label from items where quantity >= $minimum order by label")
      .all({ $minimum: 2 })
      .map((row) => (row as Record<string, unknown>).label);
    assert.deepEqual(labels, ["alpha", "beta"]);

    assert.deepEqual(db.prepare("select label from items order by label").pluck().all(), ["alpha", "beta"]);
    assert.deepEqual(
      [...db.prepare("select label from items order by label").iterate()]
        .map((row) => (row as Record<string, unknown>).label),
      ["alpha", "beta"],
    );
    assert.deepEqual(
      [...db.prepare("select label from items order by label").pluck().iterate()],
      ["alpha", "beta"],
    );
    db.exec("pragma user_version = 7");
    assert.equal(db.pragma("user_version"), 7);

    const insertPair = db.transaction((first: string, second: string) => {
      db.prepare("insert into items(label, quantity) values (?, 1)").run(first);
      db.transaction((label: string) => db.prepare("insert into items(label, quantity) values (?, 1)").run(label))(second);
    });
    insertPair("gamma", "delta");
    assert.equal(db.prepare("select count(*) as count from items").pluck().get(), 4);

    assert.throws(
      () => db.transaction(() => {
        db.prepare("insert into items(label, quantity) values (?, 1)").run("rolled-back");
        throw new Error("rollback-marker");
      })(),
      /rollback-marker/,
    );
    assert.equal(db.prepare("select count(*) as count from items where label = ?").pluck().get("rolled-back"), 0);
    db.close();
    db.close();

    const bareNamedDb = new DatabaseSync(":memory:");
    try {
      bareNamedDb.exec("create table roster_events (event_id text not null, event_type text not null, reason text)");
      bareNamedDb.prepare(`
        insert into roster_events(event_id, event_type, reason)
        values (@event_id, @event_type, @reason)
      `).run({
        event_id: "roster-1",
        event_type: "admit_agent",
        reason: null,
      });
      const rosterEvent = bareNamedDb
        .prepare("select event_id, event_type, reason from roster_events")
        .get() as Record<string, unknown>;
      assert.equal(rosterEvent.event_id, "roster-1");
      assert.equal(rosterEvent.event_type, "admit_agent");
      assert.equal(rosterEvent.reason, null);
    } finally {
      bareNamedDb.close();
    }

    const readOnly = new DatabaseSync(path, { readOnly: true });
    assert.equal(readOnly.prepare("select count(*) as count from items").pluck().get(), 4);
    assert.throws(() => readOnly.prepare("insert into items(label, quantity) values ('forbidden', 1)").run());
    readOnly.close();

    assert.throws(() => new DatabaseSync(join(root, "missing.db"), { fileMustExist: true }), /sqlite_database_not_found/);
  } finally {
    rmSync(root, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 });
  }
}
