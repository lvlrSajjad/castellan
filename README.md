# castellan

**Casbin is the engine. CASL is the API.**

castellan lets you write authorization rules with a typed, CASL-style DSL and enforces them with
[Apache Casbin (incubating)](https://casbin.apache.org). You get RBAC with domains (multi-tenancy),
ABAC conditions, DB-stored policies, and TypeORM query scoping, all from one set of rules.

```ts
everyone.can('read', WorkOrder, { siteId: { $in: user.siteIds } });
role('technician').can('update', WorkOrder, { assigneeId: user.id, status: { $ne: 'closed' } });
everyone.cannot('delete', WorkOrder, { status: 'invoiced' }).because('Invoiced work orders are immutable');
```

| Package | What it does |
| --- | --- |
| [`@castellan/core`](packages/core) | DSL, condition engine, in-memory `Ability`, Casbin model + enforcer runtime, policy sync. No framework dependencies. |
| [`@castellan/typeorm`](packages/typeorm) | Policy storage on your existing `DataSource`, `scopeQuery` (TypeORM `accessibleBy`), `toFindOptionsWhere`. |
| [`@castellan/nestjs`](packages/nestjs) | `AuthzModule`, `AuthzGuard`, `@CheckAbility`, `@CurrentAbility`, `AuthzService`. |

> **Status:** pre-release (0.x). Not on npm yet: install a tagged prerelease, see [docs/INSTALL.md](docs/INSTALL.md).

## Why

| | CASL | Casbin | castellan |
| --- | --- | --- | --- |
| Typed rules, conditions checked against your entities | ✅ | ❌ string tuples | ✅ |
| Policies stored in the DB, editable at runtime | ❌ | ✅ | ✅ |
| RBAC with role inheritance and domains | manual | ✅ | ✅ |
| ABAC conditions | ✅ Mongo-style | `eval()` strings | ✅ Mongo-style, stored as JSON |
| Scope DB queries by permissions (TypeORM) | ❌ (Prisma/Mongoose only) | ❌ (not in node-casbin) | ✅ |
| Proven agreement between fast path and enforcer | n/a | n/a | ✅ parity test suites |

## Requirements

Node.js ≥ 22, `casbin` ^5.27. TypeORM 0.3.20+ or 1.x. NestJS 10, 11 or 12.

```bash
pnpm add @castellan/core @castellan/typeorm @castellan/nestjs casbin
```

## Quick start (NestJS + TypeORM)

### 1. Define policies

```ts
// authz/policies.ts
import { definePolicies } from '@castellan/core';
import { Site, WorkOrder } from '../entities';

export interface AppUser { id: string; orgId: string; siteIds: number[] }
export type AppAction = 'read' | 'create' | 'update' | 'delete';

export const policies = definePolicies<AppUser, AppAction>(({ everyone, role, user }) => {
  everyone.can('read', WorkOrder, { siteId: { $in: user.siteIds } });
  everyone.cannot('delete', WorkOrder, { status: 'invoiced' }).because('Invoiced work orders are immutable');

  role('technician').can('update', WorkOrder, { assigneeId: user.id, status: { $ne: 'closed' } });

  role('site-manager', ({ can, inherits }) => {
    inherits('technician');
    can(['update', 'delete'], WorkOrder, { siteId: { $in: user.siteIds } });
    can('manage', Site, { id: { $in: user.siteIds } });
  });

  role('org-admin').can('manage', 'all');
});
```

`user` is a typed proxy: `user.id` compiles to `{ "$ref": "user.id" }`, resolved for the current
user at check time. Policies are static, so they can be stored in Casbin and turned into SQL.
Use `role(...)` where CASL code would use `if (user.roles.includes(...))`
([why](docs/decisions/001-static-policies-with-user-refs.md)).

Conditions are type-checked against the entity: `{ assigneId: user.id }` is a compile error.

### 2. Register the module

```ts
import { CastellanRule, createTypeormAdapter } from '@castellan/typeorm';
import { AuthzModule } from '@castellan/nestjs';

@Module({
  imports: [
    TypeOrmModule.forRoot({ /* … */ entities: [WorkOrder, Site, CastellanRule] }),
    AuthzModule.forRootAsync({
      inject: [DataSource],
      useFactory: (ds: DataSource) => ({
        adapter: createTypeormAdapter(ds),     // policies live in the `castellan_rule` table
        policies,                              // synced at startup (see "Policy sync")
        domainFromRequest: (req) => req.user.orgId,
        // userFromRequest: (req) => req.user  (default)
        // principalId: (user) => String(user.id)  (default)
      }),
    }),
  ],
})
export class AppModule {}
```

### 3. Protect routes

```ts
@Controller('work-orders')
@UseGuards(JwtAuthGuard, AuthzGuard)
export class WorkOrdersController {
  constructor(private readonly workOrders: WorkOrdersService) {}

  @Get()
  @CheckAbility('read', WorkOrder)
  list(@CurrentAbility() ability: Ability) {
    return this.workOrders.findAccessible(ability);
  }

  @Patch(':id')
  @CheckAbility('update', WorkOrder, {
    load: (req, refs) => refs.get(WorkOrdersService, { strict: false }).findOne(req.params.id),
  })
  update(@Param('id') id: string, @Body() dto: UpdateWorkOrderDto) { /* … */ }
}
```

- No user → `401`. `load` returns nothing → `404`. Denied → `403` with the rule's reason:
  `{ "statusCode": 403, "message": "Invoiced work orders are immutable", "action": "delete", "subject": "WorkOrder" }`.
- Without `load`, the check is type-level ("can this user update *some* work order?").
- Stack several `@CheckAbility` decorators to require all of them.

### 4. Scope queries

```ts
findAccessible(ability: Ability) {
  const qb = this.repo.createQueryBuilder('wo').leftJoin('wo.site', 'site');
  return scopeQuery(qb, ability, 'read', WorkOrder).getMany();
}
```

`scopeQuery` adds `(allow1 OR allow2 …) AND NOT (deny1 OR deny2 …)` with bound parameters.
Relations used in conditions (`'site.region'`) must be joined; joins on the main alias are
detected automatically, or pass `{ relations: { site: 'siteAlias' } }`.

Call `scopeQuery` **after** your own `where`/`orWhere`: it brackets existing conditions, but a
later `.where()` would replace the scope and a later `.orWhere()` would widen it.

For the repository API, `toFindOptionsWhere(ability, 'read', WorkOrder)` returns a
`FindOptionsWhere[]` (or `null` when nothing is accessible). It throws when conditional deny
rules apply, because `FindOptionsWhere` cannot express `NOT (…)`; use `scopeQuery` then.

### 5. Check in services

```ts
const ability = await this.authz.abilityFor(user, { domain: user.orgId });
ability.can('update', workOrder);                           // in-memory, fast
ability.relevantRuleFor('delete', workOrder)?.reason;       // "Invoiced work orders are immutable"
ability.permittedFieldsOf('read', invoice, { allFields });  // field-level permissions

await this.authz.assert(user, 'delete', workOrder, { domain: user.orgId }); // enforcer; throws 403
await this.authz.explain(user, 'delete', workOrder, { domain: user.orgId }); // both layers + matched rules
```

Plain objects (DTOs, raw rows) need a type tag: `ability.can('update', subject(WorkOrder, dto))`.
castellan never silently treats an untagged object as `Object`.

## Without NestJS

`@castellan/core` works anywhere:

```ts
import { Authz } from '@castellan/core';

const authz = await Authz.create({ adapter, policies });
await authz.assignRole('u-42', 'site-manager', 'org-1');
const ability = await authz.abilityFor(user, { domain: 'org-1' });
```

## External grants mode (scoped RBAC)

For apps that already own their access data (memberships, roles, assignments, a site tree) and
want castellan only for **the rules, the decision and the list filter**, with Casbin as the
engine. castellan reads the grants and never writes them.

```ts
import { Authz, createScopeTree, definePolicies, defineSubjects } from '@castellan/core';

// Rules: a role is a key; composite roles inherit keys.
export const policies = definePolicies<AppUser>(({ role, everyone }) => {
  role('site.read').can('read', Site).can('read', WorkOrder);
  role('work_order.update').can('update', WorkOrder, { status: { $ne: 'closed' } });
  role('org.manager', ({ inherits }) => inherits('site.read', 'work_order.update'));
  everyone.cannot('delete', WorkOrder, { status: 'invoiced' }); // global guardrail
});

// How each subject sits on the tree. Root columns only, so a scope never adds a join.
export const subjects = defineSubjects({
  Site: { tenant: 'orgId', leaf: 'id' },
  WorkOrder: { tenant: 'orgId', leaf: 'siteId' },
  Reading: { leaf: 'siteId' }, // no tenant column: tenant-wide means "all the tenant's leaves"
});

const authz = await Authz.create({ grants: 'snapshot', policies, subjects });

// Per request, from the app's own (cached) access context:
const ability = await authz.abilityFor(user, {
  domain: 'org:812',
  snapshot: {
    tree: createScopeTree(nodes), // or any { contains(outer, inner), leaves(scope) }
    roles: { 'custom:42': ['site.read'] }, // custom roles → keys
    assignments: [
      { role: 'org.manager', scope: 'group:north' },
      { role: 'custom:42', scope: 'site:1001', validUntil: '2026-12-31T00:00:00Z' },
      { role: 'org.manager', scope: 'org:812', limitTo: ['site.read'], source: 'delegation' },
    ],
  },
});
```

Pass `grants: { load(user, domain) { … } }` instead of `'snapshot'` to have castellan load the
snapshot itself.

| Assignment scope `S` vs domain `D` | Allow rules are limited to |
| --- | --- |
| `S` contains `D` (`*`, partner, the tenant) | `tenant = D` (or `leaf IN leaves(D)` without a tenant column) |
| `S` is inside `D` (group, site) | the above **and** `leaf IN leaves(S)` |
| neither | nothing (the assignment is ignored) |

- Type-level checks (`ability.can('update', WorkOrder)`) answer "is this held anywhere in `D`?".
- Assignments outside `[validFrom, validUntil)` are ignored; `ability.expiresAt` is the next
  instant the answer could change. `limitTo` intersects the role with a subset (delegation).
- Unknown roles and keys are skipped and reported through `onGrantIssue`, never thrown.
- Subjects missing from `defineSubjects` throw `ScopeMappingError`; leaf lists above
  `maxScopeLeaves` (default 5 000) throw `ScopeTooLargeError`.
- `grant`, `revoke`, `assignRole`, `syncPolicies` … throw `ReadOnlyError`.
- `authz.enforce` / `assert` / `explain` run through an in-memory Casbin enforcer built for the
  ability's grants; a scoped parity suite proves it agrees with `ability.can`.

### List filters: resolve, check, apply

```ts
import { applyScope } from '@castellan/typeorm';

const resolved = ability.resolveScope('read', WorkOrder);
// { kind: 'none' } or { kind: 'condition', node } with every ref and scope resolved to literals:
// { kind: 'and', nodes: [ { field: 'orgId', op: '$eq', value: 812 }, { field: 'siteId', op: '$in', value: [1001, 1002] } ] }
if (resolved.kind === 'none') throw new NotFoundException();
const rows = await applyScope(repo.createQueryBuilder('wo'), resolved).getMany();
```

In a scoped domain a resolved scope always carries the tenant (or leaf) predicate: it can never
mean "all rows". Every consumer validates the scope first, so `undefined`, `null` or `{}` throw
`InvalidScopeError` instead of becoming an unfiltered query. `applyScope` / `scopeQuery` options:
`require: 'condition'` (throw `EmptyScopeError` instead of matching nothing) and
`relations: false` (reject relation paths). See [decision 006](docs/decisions/006-external-grants-mode.md)
and [007](docs/decisions/007-resolved-scopes.md).

## Concepts

### Roles, domains and principals

- **principal**: who a rule applies to, a role name, a user id, or `*` (`everyone`).
- **domain**: the tenant. Rules and role assignments in domain `*` apply to every domain.
  `role('finance', { domain: 'org-1' })` scopes rules to one tenant.
- **role links**: `inherits('technician')` in code, or `authz.assignRole(userId, role, domain)` at runtime.
- **Domains select which rules and roles apply; they do not filter rows.** A rule like
  `role('org-admin').can('manage', 'all')` held in `org-1` allows *any* `WorkOrder` instance you
  pass it, including one from `org-2`. Keep tenant isolation in the data: add
  `{ orgId: user.orgId }` to rules, or filter by tenant before `scopeQuery` / in `load` (the
  example app does both).
- `domains: false` switches to Casbin's 3-field model (`sub, obj, act`) for single-tenant apps.

### Actions and subjects

`manage` matches every action, `all` matches every subject type. Subject types are class names
(override with a static `modelName` if your build minifies classes) or strings.

### Conditions

| Operator | Example | Notes |
| --- | --- | --- |
| implicit `$eq` | `{ status: 'open' }` | `null` matches null/undefined |
| `$ne` | `{ status: { $ne: 'closed' } }` | matches NULL (`<> v OR IS NULL`) |
| `$in` / `$nin` | `{ siteId: { $in: user.siteIds } }` | literal array or `$ref` to an array; `$nin` matches NULL |
| `$gt` `$gte` `$lt` `$lte` | `{ priority: { $gte: 5 } }` | never match NULL; Dates supported |
| `$exists` | `{ dueAt: { $exists: false } }` | means "is (not) null" |
| `$and` / `$or` | `{ $or: [{ a: 1 }, { b: 2 }] }` | |
| dotted path | `{ 'site.region': 'west' }` | one relation level |

Anything else (`$regex`, `$elemMatch`, deep paths, `__`-prefixed keys) is rejected when the rule
is defined. If a `$ref` resolves to `undefined`, the rule **fails closed**: allows don't match,
denies do. Details: [decision 004](docs/decisions/004-one-condition-evaluator.md).

### Field-level permissions

```ts
role('finance').can('update', Invoice, ['amount', 'dueDate']);
role('finance').cannot('read', Invoice, ['internalNotes']);
ability.can('read', invoice, 'internalNotes'); // false
```

Fields are stored in the policy row and enforced by both the ability and the enforcer
(`authz.enforce(user, 'read', invoice, { field: 'internalNotes' })`).

### Precedence

**Any matching deny wins, regardless of order** (Casbin semantics). A blanket `cannot` followed by
a narrower `can` will never allow; `definePolicies` warns when it detects this.
See [decision 003](docs/decisions/003-deny-wins-precedence.md).

### Policy sync

Code-defined policies are reconciled with the store when the module starts:

| `sync` | Behaviour |
| --- | --- |
| `'replace'` (default) | Add new code rules, remove code rules you deleted. Runtime grants are untouched. |
| `'merge'` | Only add. |
| `'dry-run'` | Log the diff, write nothing. |
| `'off'` | Do nothing. |

Rows are tagged with `__origin: "code"` or `"runtime"`, so `replace` only ever deletes rows it
owns. Role links from code are add-only.

### Runtime policy management

Admin UIs use the same typed DSL:

```ts
await authz.grant(definePolicies(({ role }) => role('contractor').can('read', WorkOrder, { siteId: 7 })));
await authz.revoke(/* same policy set */);
await authz.assignRole('u-42', 'contractor', 'org-1');
```

### Multiple instances

Pass a Casbin watcher (e.g. a Redis watcher) as `watcher` so other instances reload when policies change.

## Coming from CASL

- `defineAbility((can) => …)` → `definePolicies(({ everyone, role, user }) => …)`. Rules run once
  at boot; reference user attributes through `user` instead of closing over a real user.
- Replace `if (user.isAdmin)` with `role('admin').can(...)` and assign roles with `assignRole`.
- `accessibleBy(ability).WorkOrder` → `scopeQuery(qb, ability, 'read', WorkOrder)`.
- Order no longer matters: any matching `cannot` wins.
- `subject('WorkOrder', obj)`, `relevantRuleFor`, `permittedFieldsOf`, `.because()`, `manage`, `all` work as you know them.

## Coming from Casbin

- You never write `model.conf`. castellan generates it (`buildModelText()` to inspect):

  ```ini
  [request_definition]
  r = sub, dom, obj, act
  [policy_definition]
  p = sub, dom, obj, act, cond, eft
  [role_definition]
  g = _, _, _
  [policy_effect]
  e = some(where (p.eft == allow)) && !some(where (p.eft == deny))
  [matchers]
  m = (p.sub == "*" || g(r.sub, p.sub, r.dom)) && (p.dom == "*" || r.dom == p.dom) && subjectMatch(r.obj, p.obj) && actionMatch(r.act, p.act) && condMatch(r.obj, p.cond, p.eft)
  ```

- `p.cond` is JSON, evaluated by the registered `condMatch` function instead of `eval()`.
- `authz.enforcer` is a regular node-casbin `Enforcer`; RBAC APIs work as usual.
- `authz.exportPolicies()` emits CSV for the Casbin online editor. Other Casbin
  implementations (Go, Java) don't have `condMatch`; an `eval()` export is on the roadmap.

## Guarantees

Two parity suites run in CI:

1. **ability vs enforcer**: every combination of users × domains × actions × subjects × fields
   from an RBAC/ABAC/deny/domain/field fixture must give the same answer in `ability.can()` and
   `enforcer.enforce()`.
2. **ability vs SQL**: for every user × action, `scopeQuery` must return exactly the rows for
   which `ability.can()` is true, on SQLite, PostgreSQL and MySQL 8, with TypeORM 0.3 and 1.x.

Both suites also run on a scoped fixture (platform, partner, tenant, group and site assignments,
custom roles, validity windows, `limitTo`), including `IN` lists of 1 000 and 5 000 ids and an
EXPLAIN check that scope columns use their indexes.

## Roadmap

- `exportPolicies({ format: 'eval' })` for cross-language Casbin consumers
- LRU cache for `abilityFor`, keyed on (principal, domain, policy version) and invalidated by the watcher
- Optional `tenantField` so every rule implicitly requires `row[tenantField] === domain`
- Priority-based effects as an opt-in
- Query scoping for Prisma / Drizzle

## Development

```bash
pnpm install
pnpm test          # all packages
pnpm lint && pnpm typecheck
pnpm build
docker compose -f docker-compose.test.yml up -d
CASTELLAN_PG_URL=postgres://postgres:castellan@localhost:55432/castellan pnpm --filter @castellan/typeorm test
CASTELLAN_MYSQL_URL=mysql://root:castellan@localhost:53306/castellan pnpm --filter @castellan/typeorm test
```

Design decisions are in [`docs/decisions`](docs/decisions).

## License

MIT. castellan builds on Apache Casbin (incubating); it is not affiliated with the Apache Software
Foundation or the CASL project.
