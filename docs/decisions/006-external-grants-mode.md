# 006 — External grants mode

**Status:** accepted (roadmap items 2 and 3)

## Context

Many multi-tenant apps already own their access data (memberships, roles, assignments, a site
tree) and write it through their own audited services. Copying it into `castellan_rule` would
create a second source of truth, and Casbin role links `(user, role, domain)` cannot express a
sub-tenant scope, a validity window or a delegation subset.

## Decision

`Authz.create({ grants, subjects, policies })` switches to **external grants mode**:

- The app hands castellan a `GrantSnapshot` per call (`{ assignments, roles?, tree }`), either through a
  `GrantSource` or directly as `abilityFor(user, { domain, snapshot })`. castellan never writes it.
  `grant`, `revoke`, `assignRole`, `unassignRole`, `syncPolicies`, `listRules` and `reload` throw
  `ReadOnlyError`; `adapter` and `watcher` are rejected at startup.
- Code-defined policies (`definePolicies`) supply the rules. A role is a key such as
  `role('site.read')`; composite roles use `inherits(...)`; custom roles from storage map to keys.
- The domain is a scope key (`'org:812'`). An assignment at scope `S` applies when `S` contains the
  domain (platform, partner, the tenant) or sits inside it (group, site). Inside assignments limit
  rules to `leaves(S)`. Every allow rule is also limited to the tenant: `tenant = D`, or
  `leaf IN leaves(D)` for subjects without a tenant column (`defineSubjects`).
- **Casbin stays the engine.** Each ability gets an in-memory enforcer (built lazily, only for
  `enforce` / `assert` / `explain`) with the same generated model. Assignments become `g` links at
  their scope; code inheritance and custom roles become `g` links in `*`; `limitTo` becomes a
  per-assignment delegated role linked to the intersected keys. A domain-matching function on `g`
  implements scope containment: type-level requests pass the plain domain, instance requests pass
  `{"d": domain, "l": leaf}` so the matcher can check the leaf. The tenant predicate travels in
  `r.obj` and is applied by the shared `condMatch`.
- A scoped parity suite (platform, partner, tenant, group, site, custom role, expired, future,
  windowed, `limitTo`, unknown role, other tenant) proves `ability.can === enforcer.enforce`.

## Answers to the roadmap's open questions

1. **Enforcer per principal.** One per ability (principal × domain × snapshot), built lazily and
   kept with the ability. Apps cache the context; building an ability from it is cheap.
2. **Time windows before Casbin.** Assignments outside `[validFrom, validUntil)` are dropped when
   the snapshot is applied. `ability.expiresAt` is the earliest upcoming start *or* end, so a cache
   can rebuild exactly when the answer would change. Unparseable dates skip the assignment and are
   reported (fail closed).
3. **Scope keys are opaque strings.** castellan never parses them; `scopeKey('site', 1001)` is an
   optional helper. Tenant columns get their value from `defineSubjects(…, { tenantValue })`
   (default: the part after the last `:`, numeric when all digits).
4. **`IN` lists only.** No temporary tables. A scope with more than `maxScopeLeaves` (default
   5 000) leaves throws `ScopeTooLargeError` rather than being truncated. Leaf lists are only
   needed for sub-tenant assignments and for subjects without a tenant column.
5. **Deny rules.** Role-level `cannot` is rejected in external mode: a deny reached through a
   sub-tenant assignment would make type-level checks ("is this held anywhere?") wrong.
   `everyone.cannot(...)` stays available for global guardrails (e.g. "invoiced work orders are
   immutable") and applies everywhere. `everyone.can(...)` is rejected because it would be unscoped.

## Consequences

- Unknown roles and keys from storage are skipped and reported through `onGrantIssue`, never thrown
  at request time.
- Using a subject that is not in the subject map throws `ScopeMappingError`, for type-level and
  instance checks alike. There is no unscoped fallback.
- Tenant and leaf values are compared as strings in memory (`812` equals `'812'`); SQL binds the
  values as given.
