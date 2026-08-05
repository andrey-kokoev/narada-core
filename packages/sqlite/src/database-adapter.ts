type BindArgs = unknown[];

export interface NativeStatement {
  all(...args: BindArgs): unknown[];
  get(...args: BindArgs): unknown;
  iterate(...args: BindArgs): IterableIterator<unknown>;
  run(...args: BindArgs): RunResult;
}

export interface NativeDatabase {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): NativeStatement;
}

export interface DatabaseOptions {
  readOnly?: boolean;
  readonly?: boolean;
  fileMustExist?: boolean;
}

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface Statement {
  all<TRow = Record<string, unknown>>(...args: BindArgs): TRow[];
  get<TRow = Record<string, unknown>>(...args: BindArgs): TRow | undefined;
  iterate<TRow = Record<string, unknown>>(...args: BindArgs): IterableIterator<TRow>;
  run(...args: BindArgs): RunResult;
  pluck(): Statement;
}

export class DatabaseAdapter {
  private closed = false;
  private transactionDepth = 0;
  private savepointSequence = 0;

  constructor(private readonly db: NativeDatabase) {}

  exec(sql: string): void {
    this.assertOpen();
    this.db.exec(sql);
  }

  prepare(sql: string): Statement {
    this.assertOpen();
    return new StatementAdapter(this.db.prepare(sql));
  }

  pragma(source: string): unknown {
    const sql = source.trim().toLowerCase().startsWith("pragma")
      ? source
      : `pragma ${source}`;
    const rows = this.prepare(sql).all();
    if (rows.length !== 1) return rows;
    const row = rows[0];
    if (!row || typeof row !== "object") return row;
    const values = Object.values(row as Record<string, unknown>);
    return values.length === 1 ? values[0] : row;
  }

  transaction<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => TResult,
  ): (...args: TArgs) => TResult {
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
    if (this.closed) {
      throw new Error("database is not open");
    }
  }
}

class StatementAdapter implements Statement {
  private pluckFirstValue = false;

  constructor(private readonly statement: NativeStatement) {}

  all<TRow = Record<string, unknown>>(...args: BindArgs): TRow[] {
    const rows = this.statement.all(...normalizeBindArgs(args));
    return (this.pluckFirstValue ? rows.map(firstColumnValue) : rows) as TRow[];
  }

  get<TRow = Record<string, unknown>>(...args: BindArgs): TRow | undefined {
    const row = this.statement.get(...normalizeBindArgs(args));
    const normalized = row === null ? undefined : row;
    return (this.pluckFirstValue ? firstColumnValue(normalized) : normalized) as TRow | undefined;
  }

  *iterate<TRow = Record<string, unknown>>(...args: BindArgs): IterableIterator<TRow> {
    for (const row of this.statement.iterate(...normalizeBindArgs(args))) {
      yield (this.pluckFirstValue ? firstColumnValue(row) : row) as TRow;
    }
  }

  run(...args: BindArgs): RunResult {
    return this.statement.run(...normalizeBindArgs(args));
  }

  pluck(): Statement {
    this.pluckFirstValue = true;
    return this;
  }
}

function normalizeBindArgs(args: BindArgs): BindArgs {
  return args.map((arg) => (arg === undefined ? null : arg));
}

function firstColumnValue(row: unknown): unknown {
  if (!row || typeof row !== "object") return row;
  return Object.values(row as Record<string, unknown>)[0];
}
