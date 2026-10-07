---
'@castellanjs/core': minor
'@castellanjs/typeorm': minor
'@castellanjs/nestjs': minor
---

External grants mode and scoped RBAC: read-only `GrantSource` / per-call snapshots, `ScopeTree` and `defineSubjects`, scope-aware abilities and Casbin enforcers (scoped parity suite), `resolveScope()` returning a database-agnostic `ResolvedScope`, `applyScope()` with `require: 'condition'` and `relations: false`, and the parity suites on MySQL 8. `role(...).can(...)` handles are chainable.
