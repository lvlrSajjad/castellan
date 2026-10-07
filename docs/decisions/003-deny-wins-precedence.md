# 003 — Precedence: any matching deny wins

**Status:** accepted

## Context

CASL evaluates rules in order: the last matching rule wins, so a later `can` can override an
earlier `cannot`. Casbin's `allow-and-deny` effect is order-independent: any matching deny wins.

## Decision

Use Casbin semantics everywhere (in-memory ability, enforcer, SQL):

```ini
e = some(where (p.eft == allow)) && !some(where (p.eft == deny))
```

Policies live in a database where row order is not meaningful, and the in-memory layer must
agree with the enforcer.

## Consequences

- `cannot('delete', Doc)` followed by `can('delete', Doc, { ownerId })` always denies.
  `definePolicies` emits a lint warning for this (`PolicySet.warnings`, logged at sync).
- Write exceptions as narrower denies (`cannot('delete', Doc, { ownerId: { $ne: user.id } })`)
  instead of broad denies followed by allows.
- Priority-based effects (`p.priority`) can be added later as an opt-in.

Type-level checks follow CASL: `can('read', WorkOrder)` is true if some allow rule could match;
conditional denies are ignored, unconditional ones are not. Field rules follow CASL: a deny
with `fields` does not block whole-object checks.
