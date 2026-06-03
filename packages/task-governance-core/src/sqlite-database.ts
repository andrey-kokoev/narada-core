import { createRequire } from "node:module";

type BindArgs = unknown[];

interface NodeSqliteStatement {
  all(...args: BindArgs): unknown[];
  get(...args: BindArgs): unknown;
  run(...args: BindArgs): RunResult;
}

interface NodeSqliteDatabase {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): NodeSqliteStatement;
}

interface NodeSqliteModule {
  DatabaseSync: new (path: string) => NodeSqliteDatabase;
}

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface Statement {
  all(...args: BindArgs): unknown[];
  get(...args: BindArgs): unknown;
  run(...args: BindArgs): RunResult;
  pluck(): Statement;
}

const require = createRequire(import.meta.url);
let nodeSqliteModule: NodeSqliteModule | null = null;

function loadNodeSqlite(): NodeSqliteModule {
  nodeSqliteModule ??= require("node:sqlite") as NodeSqliteModule;
  return nodeSqliteModule;
}

class Database {
  private readonly db: NodeSqliteDatabase;
  private closed = false;
  private transactionDepth = 0;
  private savepointSequence = 0;

  constructor(path: string) {
    const { DatabaseSync } = loadNodeSqlite();
    this.db = new DatabaseSync(path);
  }

  exec(sql: string): void {
    this.assertOpen();
    this.db.exec(sql);
  }

  prepare(sql: string): Statement {
    this.assertOpen();
    return new StatementAdapter(this.db.prepare(sql));
  }

  pragma(source: string): unknown {
    const sql = source.trim().toLowerCase().startsWith("pragma") ? source : `pragma ${source}`;
    const rows = this.prepare(sql).all();
    if (rows.length !== 1) return rows;
    const row = rows[0];
    if (!row || typeof row !== "object") return row;
    const values = Object.values(row as Record<string, unknown>);
    return values.length === 1 ? values[0] : row;
  }

  transaction<TArgs extends unknown[], TResult>(fn: (...args: TArgs) => TResult): (...args: TArgs) => TResult {
    return (...args: TArgs): TResult => {
      if (this.transactionDepth === 0) {
        this.exec("begin immediate");
        this.transactionDepth += 1;
        try {
          const result = fn(...args);
          this.exec("commit");
          return result;
        } catch (error) {
          this.exec("rollback");
          throw error;
        } finally {
          this.transactionDepth -= 1;
        }
      }
      const savepoint = `narada_tx_${++this.savepointSequence}`;
      this.exec(`savepoint ${savepoint}`);
      this.transactionDepth += 1;
      try {
        const result = fn(...args);
        this.exec(`release savepoint ${savepoint}`);
        return result;
      } catch (error) {
        this.exec(`rollback to savepoint ${savepoint}`);
        this.exec(`release savepoint ${savepoint}`);
        throw error;
      } finally {
        this.transactionDepth -= 1;
      }
    };
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("database is not open");
  }
}

class StatementAdapter implements Statement {
  private pluckFirstValue = false;
  constructor(private readonly statement: NodeSqliteStatement) {}
  all(...args: BindArgs): unknown[] {
    const rows = this.statement.all(...args);
    return this.pluckFirstValue ? rows.map(firstColumnValue) : rows;
  }
  get(...args: BindArgs): unknown {
    const row = this.statement.get(...args);
    return this.pluckFirstValue ? firstColumnValue(row) : row;
  }
  run(...args: BindArgs): RunResult {
    return this.statement.run(...args);
  }
  pluck(): Statement {
    this.pluckFirstValue = true;
    return this;
  }
}

function firstColumnValue(row: unknown): unknown {
  if (!row || typeof row !== "object") return row;
  return Object.values(row as Record<string, unknown>)[0];
}

export { Database };
export default Database;

export namespace Database {
  export type Database = import("./sqlite-database.js").default;
  export type Statement = import("./sqlite-database.js").Statement;
  export type RunResult = import("./sqlite-database.js").RunResult;
}
