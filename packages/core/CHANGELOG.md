# @castellanjs/core

## 0.1.0-alpha.2

### Minor Changes

- Scope trees with several parents per node, subjects linked to the tenant through a set of ids (`tenant: { field, in }` with `snapshot.lists`), and shorter `IN` lists for sub-tenant scopes. New `ability.holds()`, `ability.permissions()` and `ability.covers()`. NestJS: `@RequirePermission`, `onNoDomainAccess` / `onDeniedInstance: 'not-found'`, `snapshotFromRequest` and `AuthzService.scopeFor()`. The generated matcher tests action and subject before role links, and scoped enforcers use a caching `ScopedRoleManager` (a Casbin check went from about 3.3 ms to 0.5 ms on the benchmark fixture). MySQL 8.0 joins the CI matrix.

## 0.1.0-alpha.1

### Patch Changes

- Packages are published as `@castellanjs/*` (the `@castellan` npm scope is not available).

## 0.1.0-alpha.0

### Minor Changes

- External grants mode and scoped RBAC: read-only `GrantSource` / per-call snapshots, `ScopeTree` and `defineSubjects`, scope-aware abilities and Casbin enforcers (scoped parity suite), `resolveScope()` returning a database-agnostic `ResolvedScope`, `applyScope()` with `require: 'condition'` and `relations: false`, and the parity suites on MySQL 8. `role(...).can(...)` handles are chainable.
- a92fd76: Initial release: CASL-style policy DSL compiled to Casbin, in-memory abilities with enforcer parity, TypeORM storage and query scoping, NestJS module/guard/decorators.
