---
'@castellanjs/core': minor
'@castellanjs/typeorm': minor
'@castellanjs/nestjs': minor
---

Scope trees with several parents per node, subjects linked to the tenant through a set of ids (`tenant: { field, in }` with `snapshot.lists`), and shorter `IN` lists for sub-tenant scopes. New `ability.holds()`, `ability.permissions()` and `ability.covers()`. NestJS: `@RequirePermission`, `onNoDomainAccess` / `onDeniedInstance: 'not-found'`, `snapshotFromRequest` and `AuthzService.scopeFor()`. The generated matcher tests action and subject before role links, and scoped enforcers use a caching `ScopedRoleManager` (a Casbin check went from about 3.3 ms to 0.5 ms on the benchmark fixture). MySQL 8.0 joins the CI matrix.
