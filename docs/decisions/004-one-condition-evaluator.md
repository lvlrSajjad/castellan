# 004 — One condition evaluator, SQL-compatible semantics, fail-closed refs

**Status:** accepted

## Decision

- Conditions are stored as JSON in the `cond` column, not as Casbin `eval()` strings.
- `condMatches()` in `@castellanjs/core` is the only implementation of condition + field logic.
  The in-memory `Ability` calls it directly; the enforcer calls it through the registered
  `condMatch(r.obj, p.cond, p.eft)` function. Both parity suites (ability vs enforcer, ability vs
  SQL) guard this.
- `r.obj` is an envelope `{ type, data?, field?, user }` built by castellan. `user` carries the
  attributes used to resolve `$ref`s; `r.sub` stays a plain principal id so `g()` works.
- Operator semantics are chosen so the SQL scoper can match them exactly:
  - `$ne` / `$nin` match `NULL` (`col <> v OR col IS NULL`);
  - comparisons with `NULL` never match;
  - `$exists` means "is not null";
  - `$in: []` matches nothing, `$nin: []` matches everything.
- An unresolved `$ref` (attribute is `undefined`) **fails closed**: allow rules do not match,
  deny rules do. The SQL scoper emits `1=0` / `1=1` accordingly.
- Field names are validated (`identifier` or `relation.identifier`) and checked against TypeORM
  metadata before being used in SQL; all values are bound parameters.

## Known differences from Mongo semantics

- No array-field matching (`{ tags: 'x' }` does not search arrays).
- Strings compare with JavaScript ordering in memory and the DB collation in SQL.
- Values must have matching JS types to compare (`'5' > 4` is false in memory).
