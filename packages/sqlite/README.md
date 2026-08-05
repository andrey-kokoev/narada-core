# @narada-core/sqlite

A thin adapter over Node.js's built-in `node:sqlite` and Bun's built-in
`bun:sqlite` modules that exposes one `better-sqlite3`-compatible API surface.

The runtime selects its backend through package export conditions. Consumers
use one import and contain no runtime checks.

## Requirements

- Node.js >= 22.0.0, or Bun >= 1.3.0.

## API

```ts
import Database from "@narada-core/sqlite";

const db = new Database(":memory:");
db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
const stmt = db.prepare("INSERT INTO t (name) VALUES (?)");
stmt.run("alice");
const row = db.prepare("SELECT * FROM t WHERE id = ?").get(1);
db.close();
```

Supported `better-sqlite3`-style methods:

- `new Database(path)`
- `db.exec(sql)`
- `db.prepare(sql)` → `Statement`
- `statement.all(...args)`, `statement.get(...args)`, `statement.run(...args)`
- `statement.pluck()`
- `db.pragma(source)`
- `db.transaction(fn)`
- `db.close()`
