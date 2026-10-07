# Roadmap: external grants and scoped RBAC

**Status:** in progress. Done in `0.1.0-alpha.0`: items 2, 3, 5 and 6, and the prerelease part of 10
(the [minimum adoption path](#minimum-adoption-path)). Open questions are answered in
[decision 006](../decisions/006-external-grants-mode.md); item 5 in [decision 007](../decisions/007-resolved-scopes.md).
Not started: 1, 4, 7, 8, 9, `tenantField` for the store-backed mode, and the stable release.

## Why

castellan today assumes the Casbin policy store is the source of truth: code policies are synced into
it, and runtime grants are written with `grant()` and `assignRole()`. That fits apps that start fresh.

Many multi-tenant apps already have their own access tables (users, memberships, roles, role
assignments) written by their own audited services, and they need:

- **Scoped RBAC over a resource hierarchy** (the Azure RBAC and Google Cloud IAM pattern). A role is
  a set of permissions, an assignment is *(principal, role, scope)*, and an assignment covers
  everything under its scope:

  ```text
  *                        platform staff
  └─ partner:7             a reseller; can include its child partners
     └─ org:812            a tenant
        └─ group:north     a group of sites (a node in the tenant's site tree)
           └─ site:1001    a leaf resource
  ```

- **Built-in roles defined in code** and **custom roles stored in the app's tables**, both being
  bundles of permission keys such as `site.read` or `work_order.update`.
- **Time-bound assignments**, inactive memberships, and delegated assignments limited to a subset of
  a role.
- **Per-request access with versioned caching**. A change made through the app is seen on the next
  request on every instance, without reloading a global policy set.
- **Fail-closed list filters** on MySQL, PostgreSQL or SQLite, built only from indexed columns: a
  tenant column, or a leaf column with an `IN` list of up to a few thousand ids.
- **The same ability on the client**, to hide or disable UI.

Today such an app could only use castellan by copying its access data into `castellan_rule`. That is
a second source of truth to keep in sync, and Casbin role links `(user, role, domain)` cannot hold a
sub-tenant scope, a validity window or a "limited to these permissions" flag.

This roadmap adds an **external grants mode**. The app stays the only owner of access data and
castellan reads it. Casbin stays the engine: the generated model, matchers and role manager, with
the ability-vs-enforcer and ability-vs-SQL parity guarantees extended to scopes. The existing
store-backed mode is unchanged.

## Goals

1. Read grants from the app's own tables. castellan never writes them.
2. Make sub-tenant scopes first class in the in-memory ability, the enforcer and the SQL scoper.
3. Build the ability per principal and per domain, cached by a version the app controls.
4. Make it impossible for a scope filter to silently become "all rows".
5. Run the parity suites on MySQL 8.
6. Fit NestJS apps that put the tenant in the path and answer `404` for anything out of reach.
7. Ship a casbin-free ability for browsers.

## Non-goals

- Writing grants, auditing, or the "you can only grant what you hold" workflow. The app owns writes;
  castellan only provides the check (`covers()`, item 9).
- Knowing the app's tree format. The app turns its tree into a `ScopeTree` (item 3).
- Approvals, just-in-time elevation and notifications.

## Minimum adoption path

Not every app needs all ten items. Many already have:

- an access-context builder (memberships, validity windows, delegation, partner reach, tree expansion);
- a cache with its own invalidation;
- a route guard with its own `401` / `403` / `404` rules;
- a repository base that every query goes through.

Such an app needs castellan only for **the rules, the decision and the list filter, with Casbin as
the engine**. The minimum is:

| Item | What is needed | What can wait |
| --- | --- | --- |
| **2. Read-only grant source** | All of it: grants and custom roles read from the app's tables, held only in memory, with write APIs that throw | — |
| **3. Scope tree and scoped rules** | All of it: `ScopeTree`, `defineSubjects`, scope-aware matching in the ability and the enforcer, and the scoped parity fixture | — |
| **5. Fail-closed scope resolution** | `resolveScope()` returning `none` or `condition`, and `applyScope(qb, resolved)` | `require: 'condition'` and `relations: false` on `scopeQuery`, and `tenantField` for the store-backed mode |
| **10. Packaging** | A prerelease the app can install: `0.1.0-alpha.x` under the `next` dist-tag, or `pnpm pack` tarballs | The stable release and the README rewrite |

**Without item 1**, permission keys are plain principals in `definePolicies`, and a role is a
principal that inherits them:

```ts
export const policies = definePolicies<AppUser>(({ role }) => {
  role('site.read').can('read', Site).can('read', WorkOrder);
  role('work_order.update').can('update', WorkOrder, { status: { $ne: 'closed' } });
  role('org.manager', ({ inherits }) => inherits('site.read', 'work_order.update'));
});

// The grant source returns custom roles the same way: role → the keys it inherits.
// { roles: { 'custom:42': ['site.read'] }, assignments: [{ role: 'custom:42', scope: 'group:north' }], tree }
```

Item 1 later adds a typed key union and the `permission()` / `defineRoles` syntax on top of the same
links, so moving to it does not change stored data.

**Without item 4**, the app calls `abilityFor` with a snapshot built from its own cached context. It
caches the context, not the ability, and building an ability from a small snapshot is cheap.

**In a scoped domain**, every rule carries the tenant or leaf condition from the subject map (item 3).
So `resolveScope()` cannot return "unrestricted" even before the rest of item 5 lands.

**What stays in the app** on this path:

- turning its tree into a `ScopeTree`;
- resolving memberships, windows, delegation and partner reach into the snapshot;
- caching;
- the route guard and its status codes;
- "only grant what you hold" checks;
- the repository base, which calls `resolveScope()`, refuses a missing condition, then calls
  `applyScope()`.

**Done when:**

1. The app's repository base can resolve, check and apply a scope on its own database, MySQL
   included, with castellan installed from a prerelease.
2. A list for a group-scoped principal returns only rows at that group's sites, and a tenant-scoped
   principal sees only its tenant.
3. The scoped ability-vs-enforcer and ability-vs-SQL parity suites pass on SQLite and PostgreSQL.

MySQL in castellan's own CI (item 6) follows before the app goes to production.

## Work items

Each item says which package changes, the proposed API, and what "done" means. **M** items are
needed to adopt castellan in an app like the one above; **S** items should follow soon after.

### 1. Permission catalog (M, core)

Permissions are named bundles of typed rules, defined once in code. Roles, both built-in and stored,
are lists of permission keys. Casbin sees each permission as a role (`perm:<key>`), so
role → permission → rule is ordinary Casbin role inheritance.

```ts
export const catalog = definePermissions<AppUser>()(({ permission, user }) => {
  permission('site.read').can('read', Site).can('read', WorkOrder);
  permission('work_order.update').can('update', WorkOrder, { status: { $ne: 'closed' } });
  permission('work_order.update_own').can('update', WorkOrder, { assigneeId: user.id });
  permission('site.manage').can(['update', 'delete'], Site);
});

export type Permission = PermissionKey<typeof catalog>;   // 'site.read' | 'work_order.update' | …

export const builtInRoles = defineRoles<Permission>({
  'org.viewer':  ['site.read'],
  'org.manager': ['site.read', 'work_order.update', 'site.manage'],
});
```

- Rules inside a permission have no scope of their own. The scope comes from the assignment (item 3).
- `defineRoles` produces role → permission links in domain `*`. Stored custom roles produce the same
  links through the grant source (item 2).
- Unknown permission keys coming from storage are skipped and reported (`onUnknownPermission`), never
  thrown at request time.

**Done when:** the catalog type-checks conditions against entities like `definePolicies` does,
permission keys form a string-literal union, and the existing lint warnings work on catalog rules.

### 2. Read-only grant source (M, core)

The app reads its tables. castellan turns the result into Casbin links held in memory only.

```ts
interface GrantSource<U> {
  /** Grants that reach `domain` for this principal. Called on a cache miss (item 4). */
  load(user: U, domain: string): Promise<GrantSnapshot>;
}

interface GrantSnapshot {
  /** principal → role, at a scope. */
  assignments: Array<{
    role: string;
    scope: string;                       // 'org:812', 'group:north', 'site:1001', 'partner:7', '*'
    validFrom?: Date;
    validUntil?: Date;
    /** Limits the assignment to a subset of the role (delegation). */
    limitTo?: readonly string[];
    /** Free-form, surfaced by explain() and permissions(): 'direct', 'delegation', 'sso', … */
    source?: string;
  }>;
  /** Custom roles used by the assignments: role → permission keys. Built-in roles come from code. */
  roles?: Record<string, readonly string[]>;
  /** The tenant's scope tree (item 3). */
  tree: ScopeTree;
}

const authz = await Authz.create({
  catalog,
  roles: builtInRoles,
  grants: grantSource,              // external grants mode
  domains: true,
});
```

- In external grants mode `grant`, `revoke`, `assignRole`, `syncPolicies` and adapter writes throw
  `ReadOnlyError`. Catalog rules are added to the enforcer with auto-save off.
- An assignment outside its validity window adds nothing. The ability records the earliest
  `validUntil` as `expiresAt`, so the cache (item 4) rebuilds it without a job.
- Membership status, delegation intersection and partner "include children" are resolved by the app
  before it returns the snapshot. `limitTo` is how it expresses an intersection.

**Done when:** an app with no `castellan_rule` table can build abilities and enforce, and every write
API throws in this mode.

### 3. Scope tree and scoped rules (M, core)

```ts
interface ScopeTree {
  /** True when `inner` is `outer` or below it. `*` contains everything. Synchronous. */
  contains(outer: string, inner: string): boolean;
  /** Leaf ids under a scope, e.g. the site ids under a group or an org. */
  leaves(scope: string): readonly (string | number)[];
}

/** How each subject maps onto the tree. One entry per subject that can be scoped. */
export const subjects = defineSubjects({
  Site:      { tenant: 'orgId', leaf: 'id' },
  WorkOrder: { tenant: 'orgId', leaf: 'siteId' },
  Reading:   { leaf: 'siteId' },          // no tenant column: tenant-wide means "all the tenant's leaves"
});

const tree = createScopeTree({ /* parent links + leaves, built by the app from its own data */ });
```

**Semantics.** When an allow rule is reached through an assignment at scope `S`, and the request is
for domain `D`:

| Assignment scope | Effective condition on the subject |
| --- | --- |
| `S` contains `D` (platform, partner, the tenant itself) | rule conditions AND `tenant = D`, or `leaf IN leaves(D)` if the subject has no tenant column |
| `S` is inside `D` (group, site) | rule conditions AND `leaf IN leaves(S)` (AND `tenant = D` when the column exists) |
| neither | the rule does not apply |

- **Type-level checks** (`ability.can('update', WorkOrder)`) answer "is this permission held anywhere
  in `D`?". That is the route-guard question.
- **Instance checks** read the leaf field through the subject map and check it against the scope.
- Using a subject that has no entry in the map with a scoped assignment throws
  `ScopeMappingError`. It never falls back to "unscoped".
- `leaves()` lists larger than `maxScopeLeaves` (default 5 000) throw `ScopeTooLargeError` instead of
  being truncated.

**Casbin model.** Same request shape `(sub, dom, obj, act)`. The domain matching function on `g` uses
`ScopeTree.contains` in both directions for type-level checks, and only "assignment scope contains
the instance's leaf scope" for instance checks. castellan puts the mode and the leaf scope in `r.obj`,
built by castellan as today. `condMatch` adds the scope condition, so conditions keep one evaluator
(decision 004).

**Done when:** the ability-vs-enforcer parity suite has a scoped fixture (platform, partner, tenant,
group and site assignments, expired and `limitTo` assignments) and every combination agrees.

### 4. Per-principal abilities with versioned caching (M, core)

```ts
const authz = await Authz.create({
  catalog, roles: builtInRoles, grants: grantSource,
  /** Cheap read, e.g. two counters from Redis. Changes whenever the principal's access changes. */
  version: (user, domain) => counters.read(user.id, domain),
  cache: { max: 10_000 },      // LRU per instance; abilities also expire at `expiresAt`
});
```

- `abilityFor(user, { domain })` reads the version, returns the cached ability when the version
  matches and `expiresAt` has not passed, and otherwise calls `grants.load` and rebuilds.
- The ability is built from a per-principal index, not by scanning every policy row (today
  `abilityFor` filters `getPolicy()` on every call).
- The enforcer for a snapshot is built lazily, only when `enforce()`, `assert()` or `explain()` is
  used, and is cached with the ability.
- No watcher is required in this mode. The version is the invalidation signal.

**Done when:** a version change is seen by the next `abilityFor` on any instance, and building an
ability for a snapshot with 50 assignments and 500 catalog rules takes under 1 ms (benchmark in CI,
reported, not gating).

### 5. Fail-closed scope resolution (M, core + typeorm)

Split "what is the scope" from "write it into SQL", so apps can test every subject without a
database:

```ts
type ResolvedScope =
  | { kind: 'none' }                                   // nothing allows it: answer 403 or return no rows
  | { kind: 'condition'; node: ResolvedConditionNode } // refs and scopes resolved to literal values

resolveScope(ability, 'read', WorkOrder);
```

- **No `'unrestricted'` result in external grants mode.** Every result carries the tenant predicate
  (or the tenant's leaves) from the subject map, so `manage all` can never produce `1=1`.
- In the store-backed mode, add the roadmap's `tenantField` option to get the same guarantee.
- `scopeQuery` gets `{ require: 'condition' }`, which throws `EmptyScopeError` when the result is
  `none` instead of emitting `1=0`. This is for apps that want a missing grant to be a bug, not an
  empty list.
- `scopeQuery` gets `{ relations: false }`, which rejects dotted paths so a scope never adds a join.
  This is for schemas without foreign keys, where joins can cross tenants.
- `applyScope(qb, resolved)` is exported, so an app's repository base can resolve once, assert and
  apply.

**Done when:** a test makes the resolver return `undefined`, `null` and `{}` through a stub and every
entry point throws, and the ability-vs-SQL parity suite covers scoped fixtures.

### 6. MySQL 8 in the parity suites (M, typeorm, CI)

- Add MySQL 8 (Testcontainers locally, a service container in CI, `mysql2` driver) next to SQLite and
  PostgreSQL.
- Add fixtures with `IN` lists of 1 000 and 5 000 ids, `NULL` and `0` sentinel values, and
  unsigned/signed integer columns.
- Add an `explainScope(qb)` test helper that runs `EXPLAIN` and fails on a full scan of the scoped
  table when an index on the scope column exists.

**Done when:** CI runs both parity suites on MySQL 8, PostgreSQL and SQLite with TypeORM 0.3 and 1.x.

### 7. NestJS fit (M, nestjs)

```ts
AuthzModule.forRootAsync({
  inject: [GrantsReader, AccessVersions],
  useFactory: (grants, versions) => ({
    catalog, roles: builtInRoles, subjects,
    grants, version: versions.read,
    domainFromRequest: (req) => req.params.tenantId,
    /** No assignment reaches the domain at all → 404 (do not reveal that the tenant exists). */
    onNoDomainAccess: 'not-found',
    /** A loaded instance outside the caller's scope → 404 instead of 403. */
    onDeniedInstance: 'not-found',
  }),
});

@Get()
@RequirePermission('site.read', 'site.manage')     // any one of them, held anywhere in the domain
list(@CurrentAbility() ability: Ability) { … }

@Patch(':id')
@CheckAbility('update', WorkOrder, { load: … })    // existing decorator, unchanged
update() { … }
```

- `@RequirePermission(...keys)` passes when **any** key is held anywhere in the domain. Stacked
  decorators still mean "all of".
- `@CheckAbility.any([...])` for the same any-of behaviour with action and subject pairs.
- `AuthzService.scopeFor(request, action, Subject)` returns `ResolvedScope` (item 5).
- The guard reuses an ability already attached to the request. Today it already does, and this is
  documented as the hook for apps that build the ability in their own guard.

**Done when:** the e2e suite covers 401, 404 for an unreachable domain, 403 for a missing permission,
404 for an out-of-scope instance, and any-of.

### 8. Casbin-free ability and client export (S, core)

- A new entry point, `@castellan/core/ability`, exporting `Ability`, `subject`, conditions and
  `resolveScope`, with no `casbin` import. Casbin becomes an optional peer dependency for apps that
  only use the ability on the client.
- `ability.toJSON()` returns the rules with refs and scopes resolved to literal values, plus
  `expiresAt`. `Ability.fromJSON()` rebuilds it in the browser.
- `ability.permissions()` returns `{ key, scopes: string[], sources: string[] }[]`, for a `/me`
  endpoint and an "effective access" screen.

**Done when:** a browser bundle of `@castellan/core/ability` contains no casbin code (size check in CI).

### 9. Grant-time checks (S, core)

`ability.covers(permissionKeys, scope)` is true when every key is held at `scope` or above. Apps use it
to enforce "you can only grant what you hold" when someone creates a custom role, makes an assignment
or delegates. castellan does not decide who may grant. It only answers whether the caller holds the
permissions.

### 10. Packaging (M)

- Release 0.1.0 of all three packages once items 1–7 land, with a changeset per package.
- Document the external grants mode in the README, using the example app with a `GrantSource` over its
  own tables.
- Keep Node ≥ 22, Casbin ^5.27, TypeORM 0.3.20+ or 1.x, and NestJS 10–12.

## Milestones

| Milestone | Items | Unlocks |
| --- | --- | --- |
| 0.1.0-alpha.1 | 2, 3, 5 (`resolveScope`, `applyScope`), 10 (prerelease) | The [minimum adoption path](#minimum-adoption-path): scoped abilities, enforcer and list filters from external grants, parity-tested |
| 0.1.0-alpha.2 | 5 (rest), 6 | Fail-closed options on `scopeQuery`; MySQL 8 in CI |
| 0.1.0-beta.1 | 1, 4, 7 | Typed permission catalog; drop-in for a NestJS + TypeORM app with versioned caching |
| 0.1.0 | 8, 9, 10 (rest) | Client ability, grant-time checks, stable release |

## Open questions

1. **Enforcer per principal or per tenant.** A per-principal enforcer is simple and small. A
   per-tenant enforcer shares the catalog and the tree, but invalidating one principal is harder.
   Start per principal and measure.
2. **Time windows in Casbin or before Casbin.** Filtering expired assignments when the snapshot is
   built is simpler. Casbin's conditional role manager would keep the window inside the enforcer.
   Check what node-casbin supports before choosing.
3. **Scope key format.** Should castellan treat scope keys as opaque strings (current proposal) or
   offer a typed `scope('site', 1001)` helper?
4. **Leaf lists in SQL.** `IN` lists are fine up to a few thousand ids. Is there a case for a
   join-to-temporary-table strategy, and does it belong in castellan?
5. **Deny rules in scoped mode.** Allowed, with the usual "any deny wins"? Or rejected in the catalog
   until there is a use case?
