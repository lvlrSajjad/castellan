# 001 — Static policies with `user` references, not per-request closures

**Status:** accepted

## Context

The original design sketch had CASL-style per-request builders:

```ts
defineAbilities((user, { can }) => {
  can('read', WorkOrder, { siteId: { $in: user.siteIds } });
  if (user.roles.includes('site-manager')) can('manage', Site);
});
```

It also wanted those code-defined rules synced into Casbin's policy store at boot. The two goals
conflict: a closure over a concrete `user` produces different rules for every user, so there is
nothing stable to sync, and the Casbin enforcer could never see the rules (breaking
`ability.can === enforcer.enforce`).

## Decision

`definePolicies` runs **once**, at boot, with a symbolic `user` proxy. Property access compiles
to `$ref` tokens resolved at check time:

```ts
definePolicies<User>(({ everyone, role, user }) => {
  everyone.can('read', WorkOrder, { siteId: { $in: user.siteIds } }); // → { $in: { $ref: 'user.siteIds' } }
  role('site-manager').can('manage', Site);                           // replaces the `if`
});
```

- Rules are static → they sync to the store, show up in the DB, and the enforcer evaluates them.
- Branching on user data moves into roles (`role(...)`), which is what Casbin's RBAC is for.
- The proxy throws a helpful error if someone calls a method on it (`user.roles.includes`) or
  interpolates it into a string.
- `$ref` paths are restricted to `user.<attr>[.<attr>…]`.

## Consequences

- Reads almost exactly like CASL; the only change is `role()` instead of `if`.
- Policies stored in the DB by admins use the same `{ "$ref": "user.id" }` form.
- Truly dynamic per-request logic (rare) belongs in the service layer, not in policies.
