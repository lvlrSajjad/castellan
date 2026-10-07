# castellan + NestJS + TypeORM + SQLite

A small facility-maintenance API (organizations, sites, work orders) that shows:

- policies written once with `definePolicies` (`src/policies.ts`), synced into Casbin tables via `@castellan/typeorm`
- per-organization roles (Casbin domains) assigned at startup with `AuthzService.assignRole` (`src/seed.ts`)
- `AuthzGuard` + `@CheckAbility` with a `load` function, so rule conditions are checked against the real row (`src/work-orders.controller.ts`)
- `scopeQuery` turning the same rules into SQL for list endpoints (`src/work-orders.service.ts`)
- `GET /me/permissions`, returning the user's rules for a frontend ability

Authentication is faked: the `x-user` header carries a user id from `src/users.ts`.
Org `north`: `tina` (technician), `sam` (site manager), `olga` (org admin). Org `south`: `tara`, `sven`.
The database is in memory and re-seeded on every start.

## Run

```sh
# at the repo root: workspace packages resolve to their dist at runtime
pnpm install && pnpm build

pnpm --filter castellan-example-nest-typeorm-sqlite start   # PORT=3000 by default
```

## Try it (fresh start; restart to reset state)

```sh
# 200: tina sees only work orders at her site (ids 1, 2, 3, 5), filtered in SQL
curl -i -H 'x-user: tina' localhost:3000/work-orders

# 200: tina updates her own open work order
curl -i -X PATCH -H 'x-user: tina' -H 'content-type: application/json' \
  -d '{"status":"closed"}' localhost:3000/work-orders/1/status

# 403 "You are not allowed to update WorkOrder": order 2 is assigned to sam, not tina
curl -i -X PATCH -H 'x-user: tina' -H 'content-type: application/json' \
  -d '{"status":"closed"}' localhost:3000/work-orders/2/status

# 403 "Invoiced work orders are immutable": the deny rule beats even the org admin's manage-all
curl -i -X DELETE -H 'x-user: olga' localhost:3000/work-orders/5

# 403: work order 4 is at site 2, which tina does not work at
curl -i -H 'x-user: tina' localhost:3000/work-orders/4

# 404: no such work order (also 404 for another organization's order, e.g. olga on /work-orders/6)
curl -i -H 'x-user: tina' localhost:3000/work-orders/99
```

A missing or unknown `x-user` header gives 401.
