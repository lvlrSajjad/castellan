# @castellan/nestjs

## 0.1.0-alpha.0

### Minor Changes

- External grants mode and scoped RBAC: read-only `GrantSource` / per-call snapshots, `ScopeTree` and `defineSubjects`, scope-aware abilities and Casbin enforcers (scoped parity suite), `resolveScope()` returning a database-agnostic `ResolvedScope`, `applyScope()` with `require: 'condition'` and `relations: false`, and the parity suites on MySQL 8. `role(...).can(...)` handles are chainable.
- a92fd76: Initial release: CASL-style policy DSL compiled to Casbin, in-memory abilities with enforcer parity, TypeORM storage and query scoping, NestJS module/guard/decorators.

### Patch Changes

- Updated dependencies
- Updated dependencies [a92fd76]
  - @castellan/core@0.1.0-alpha.0
