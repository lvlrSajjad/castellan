// Run with `pnpm --filter @castellanjs/core bench` (builds first). Reports mean time per operation.
import { performance } from 'node:perf_hooks';
import { type Assignment, Authz, type GrantSnapshot, type ScopeNode, createScopeTree, definePolicies, defineSubjects } from '../dist/index.js';

// A large tenant: 1 000 sites in 20 groups, plus a second tree that puts every site in one of 10
// more groups (sites with two parents). 60 permission keys, 6 composite roles, 50 assignments.
class Site {
  id!: number;
  orgId!: number;
}
class Reading {
  id!: number;
  siteId!: number;
  constructor(siteId: number) {
    this.siteId = siteId;
  }
}

const nodes: ScopeNode[] = [{ key: 'partner:1' }, { key: 'org:1', parent: 'partner:1' }];
for (let g = 0; g < 20; g++) nodes.push({ key: `group:a${g}`, parent: 'org:1' });
for (let g = 0; g < 10; g++) nodes.push({ key: `group:b${g}`, parent: 'org:1' });
for (let s = 0; s < 1_000; s++) {
  nodes.push({ key: `site:${s}`, parent: [`group:a${s % 20}`, `group:b${s % 10}`], leaf: s });
}
const tree = createScopeTree(nodes);

const keys = Array.from({ length: 60 }, (_, i) => `key.${i}`);
const policies = definePolicies<{ id: string }>(({ role }) => {
  for (const key of keys) role(key).can('read', Site).can('read', Reading).can(key, Reading);
  for (let r = 0; r < 6; r++) role(`role.${r}`, ({ inherits }) => inherits(...keys.slice(r * 10, r * 10 + 10)));
});
const subjects = defineSubjects({ Site: { tenant: 'orgId', leaf: 'id' }, Reading: { leaf: 'siteId' } });

const assignments: Assignment[] = [
  { role: 'role.0', scope: 'org:1' },
  { role: 'role.1', scope: 'partner:1', source: 'partner' },
  ...Array.from({ length: 20 }, (_, i) => ({ role: `role.${2 + (i % 4)}`, scope: `group:a${i}` })),
  ...Array.from({ length: 28 }, (_, i) => ({ role: keys[i]!, scope: `site:${i * 30}`, validUntil: '2999-01-01T00:00:00Z' })),
];
const snapshot: GrantSnapshot = { tree, assignments, roles: { 'custom:1': keys.slice(0, 5) } };

const authz = await Authz.create<{ id: string }>({ grants: 'snapshot', policies, subjects, logger: false });
const user = { id: 'u1' };
const options = { domain: 'org:1', snapshot };
const ability = await authz.abilityFor(user, options);
const reading = new Reading(517);
ability.resolveScope('key.30', Reading); // warm the leaf caches of this ability

async function bench(name: string, fn: () => unknown, iterations = 2_000): Promise<void> {
  for (let i = 0; i < Math.min(200, iterations); i++) await fn();
  const start = performance.now();
  for (let i = 0; i < iterations; i++) await fn();
  const micros = ((performance.now() - start) * 1_000) / iterations;
  console.log(`${name.padEnd(76)} ${micros.toFixed(1).padStart(8)} µs`);
}

console.log('external grants mode: 1 000 sites (two trees), 60 keys, 50 assignments\n');
await bench('abilityFor (from a snapshot)', () => authz.abilityFor(user, options));
await bench('ability.can (instance, sub-tenant scope)', () => ability.can('key.30', reading), 100_000);
await bench('resolveScope (leaf subject, sub-tenant scope)', () => ability.resolveScope('key.30', Reading));
await bench('abilityFor + resolveScope (a list request, cold)', async () =>
  (await authz.abilityFor(user, options)).resolveScope('key.30', Reading));
await bench('abilityFor + Casbin enforcer build + one enforce (a write request, cold)', async () => {
  const fresh = await authz.abilityFor(user, options);
  await authz.enforceWith(fresh, 'key.30', reading);
}, 500);
await bench('enforceWith on a warm enforcer (rare action: 1 matching rule)', () => authz.enforceWith(ability, 'key.30', reading), 20_000);
await bench('enforceWith on a warm enforcer (common action: 120 matching rules)', () => authz.enforceWith(ability, 'read', reading), 5_000);
