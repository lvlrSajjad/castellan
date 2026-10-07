# 002 — Ship a small TypeORM adapter instead of `typeorm-adapter`

**Status:** accepted (deviates from the initial plan of using `typeorm-adapter` as-is)

## Context

`typeorm-adapter@1.10.0` was the planned policy store. Testing found three blockers:

1. **Corrupts JSON conditions on load.** `loadPolicyLine` rebuilds each row as a CSV line by
   wrapping values in `"…"` without escaping embedded quotes, then re-parses it with Casbin's CSV
   parser. `{"status":"closed"}` does not survive the round trip. It also drops empty values with
   `.filter(n => n)`, shifting columns.
2. **Hard `require('mongodb')`** at import time (for `CasbinMongoRule`), while `mongodb` is not a
   declared dependency. Any SQL-only project fails to import it under pnpm.
3. **`varchar(255)` columns** — condition JSON regularly exceeds 255 characters on Postgres/MySQL.

## Decision

`@castellanjs/typeorm` ships `TypeormAdapter` (~120 lines) implementing Casbin's `BatchAdapter`
on an existing `DataSource`:

- Rows are loaded as arrays (`model.addPolicy`), never via CSV.
- Same table layout as `typeorm-adapter` (`ptype`, `v0`…`v6`), so data can move between them;
  table name is configurable via `createPolicyRuleEntity(name)`.
- Value columns are `text`.

We still do not reimplement Casbin's matcher, role manager, effects or watchers.

## Consequences

- One less dependency; works with TypeORM 0.3.x and 1.x.
- A regression test round-trips quoted JSON conditions through SQLite and Postgres.
- If `typeorm-adapter` fixes these issues, switching back is a one-line change because the
  schema is compatible.
