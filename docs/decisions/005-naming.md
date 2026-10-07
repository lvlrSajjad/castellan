# 005 — Naming

**Status:** accepted

- **Package names:** `@castellanjs/core`, `@castellanjs/typeorm`, `@castellanjs/nestjs`. The `@castellan`
  npm scope belongs to an existing user account, so the scope is `@castellanjs` (an npm org). Casbin is an
  Apache Software Foundation (incubating) trademark, so no `casbin-*` names; docs say
  "built on Apache Casbin (incubating)".
- **principal vs subject:** Casbin's `sub` is *who*; CASL's `subject` is *what*. castellan uses
  `principal` (user id, role, or `*`) and `subject` (resource type such as `WorkOrder`, or `all`).
- **`@CurrentAbility()`** instead of `@Authz()` for the param decorator, to avoid colliding with
  the core `Authz` class.
- **`definePolicies`** instead of `defineAbilities`: it defines static policies (see 001); an
  `Ability` is the per-user, per-request object built from them.
