# 008 — Scope DAGs, set-linked subjects, reach queries and scoped enforcer cost

**Status:** accepted (roadmap items 3, 7, 8 and 9, in part)

## Context

Adopting external grants mode in a real multi-tenant app showed four gaps:

1. Sites can appear in more than one tree of the same tenant (a region tree and an equipment tree,
   say). `createScopeTree` allowed one parent per node and threw on the second.
2. Some tenant tables have neither a tenant column nor a leaf column. Their rows belong to the
   tenant through a set of ids: the tenant's members, its identity-provider groups, its trees.
3. Route guards, "effective access" screens and "you can only grant what you hold" checks need to
   ask which keys a principal holds and where. The ability only answered action × subject questions.
4. A check through the scoped Casbin enforcer took about 3 ms (1 000 sites, 60 keys, 50 assignments).

## Decision

- **DAGs.** `ScopeNode.parent` accepts an array. `contains` follows every parent (breadth-first,
  cycle-safe) and `leaves` lists each leaf once. A key may still appear only once in the input.
  Leaves under a tenant must belong to that tenant; this is documented, not enforced, because
  subjects without a tenant column are scoped by leaf lists alone.
- **Set-linked subjects.** `defineSubjects({ X: { tenant: { field, in: 'listName' } } })` scopes
  `X` by `field IN snapshot.lists[listName]`. Such subjects have no leaf, so assignments inside the
  domain never reach them. A missing list throws `ScopeMappingError`. Lists count against
  `maxScopeLeaves`. The same predicate travels to the Casbin matcher through `RequestScope.tenantIn`.
- **Shorter `IN` lists.** For a subject without a tenant link and an assignment inside the domain,
  the filter is `leaf IN leaves(S)` alone. `leaves(S)` is a subset of `leaves(D)`, so also writing
  `leaf IN leaves(D)` only doubled the parameters.
- **Reach queries.** `ability.holds(keys)` (any key, anywhere in the domain), `ability.permissions()`
  (keys with scopes and sources) and `ability.covers(keys, scope, { excludeSources })` (every key at
  the scope or above). Reach entries now record the `source` labels of the assignments behind them,
  so delegated grants can be excluded from `covers`.
- **NestJS.** `@RequirePermission(...keys)` (any of; stack for all of),
  `onNoDomainAccess: 'not-found'`, `onDeniedInstance: 'not-found'`, `snapshotFromRequest` and
  `AuthzService.scopeFor()`.
- **Enforcer cost.**
  - The generated matcher now tests `actionMatch` and `subjectMatch` before `g()`. Casbin
    short-circuits `&&`, so most rows skip the role lookup. This applies to both modes and does not
    change any result: the matcher functions are pure.
  - Scoped enforcers use `ScopedRoleManager`, a Casbin `RoleManager` that keeps the merged role
    graph per request domain. Casbin's default role manager rebuilds that graph on every `g()` call
    once a domain-matching function is set.

## Consequences

| Check (benchmark fixture) | Before | After |
| --- | --- | --- |
| `enforceWith`, action with 1 matching rule | 3.3 ms | 0.45 ms |
| `enforceWith`, action with 120 matching rules | — | 0.85 ms (1.9 ms with the default role manager) |
| `abilityFor` + `resolveScope` (a list request) | 0.1 ms | 0.1 ms |

- Lists and loops should use the ability; `authz.assert` is for single decisions where Casbin
  should be the decider. The parity suites keep the two in agreement.
- `pnpm --filter @castellanjs/core bench` reproduces the numbers.
