# 007 — Resolve scopes before writing SQL

**Status:** accepted (roadmap item 5)

## Context

`buildScopeSql` used to read rules and write SQL in one step, needed a `QueryBuilder` to do
anything, and wrote `1=1` for a rule without conditions. A repository base that must "resolve the
filter, check it is not empty, then apply it" had nothing to hold in between.

## Decision

- `ability.resolveScope(action, Subject)` (also `resolveScope(ability, …)`) returns a
  database-agnostic `ResolvedScope`: `{ kind: 'none' }` or `{ kind: 'condition', node }`, where
  `node` is a tree of `and` / `or` / `not` / `field` / `const` with every `$ref`, tenant and scope
  predicate already resolved to literal values.
- Constant folding happens during resolution. `none` is returned instead of a constant-false
  condition.
- **Invariant:** in a scoped domain every allowed branch carries the tenant (or domain-leaf)
  predicate, so the result can never be constant true. If it ever were, `resolveScope` throws.
- `assertResolvedScope` validates the shape. `applyScope`, `buildScopeSql`, `scopeQuery` and
  `toFindOptionsWhere` all call it, so a resolver bug that yields `undefined`, `null` or `{}`
  throws instead of producing an unfiltered query.
- `applyScope(qb, resolved, options)` writes the tree with bound parameters and metadata-checked
  columns. `scopeQuery` is `applyScope(qb, ability.resolveScope(...))`.
- `require: 'condition'` throws `EmptyScopeError` instead of writing `1=0`.
  `relations: false` rejects relation paths, so a scope never depends on a join.

## Consequences

- Repository bases can resolve once, decide (e.g. `none` → 404), and apply.
- Scopes can be unit-tested without a database.
- Store-backed mode without a tenant field can still resolve to "all rows" for rules without
  conditions; `tenantField` for that mode is still on the roadmap.
