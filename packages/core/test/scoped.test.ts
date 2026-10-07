import { describe, expect, it } from 'vitest';
import {
  Authz,
  type GrantIssue,
  ReadOnlyError,
  ScopeMappingError,
  ScopeTooLargeError,
  createAbility,
  createScopeTree,
  definePolicies,
  defineSubjects,
  resolveScope,
} from '../src/index.js';
import {
  Member,
  NOW,
  Reading,
  Site,
  Unmapped,
  type User,
  WorkOrder,
  actions,
  domains,
  instances,
  policies,
  snapshotFor,
  subjects,
  types,
  userIds,
} from './scoped-fixtures.js';

const issues: GrantIssue[] = [];
const authz = await Authz.create<User>({
  grants: 'snapshot',
  policies,
  subjects,
  now: () => NOW,
  onGrantIssue: (issue) => issues.push(issue),
});

const abilityFor = (id: string, domain = 'org:812') =>
  authz.abilityFor({ id }, { domain, snapshot: snapshotFor(id, domain) });
const wo = (init: Partial<WorkOrder>) =>
  new WorkOrder({ id: 99, orgId: 812, siteId: 1001, status: 'open', assigneeId: null, ...init });

describe('scoped parity: ability.can === scoped enforcer', () => {
  it('agrees on every (user, domain, action, subject) combination', async () => {
    const mismatches: string[] = [];
    let checked = 0;
    let allowed = 0;
    for (const id of userIds) {
      for (const domain of domains) {
        const ability = await abilityFor(id, domain);
        for (const action of actions) {
          for (const subject of [...types, ...instances]) {
            const inMemory = ability.can(action, subject);
            const enforced = await authz.enforceWith(ability, action, subject);
            checked++;
            if (inMemory) allowed++;
            if (inMemory !== enforced) {
              mismatches.push(`${id}@${domain} ${action} ${JSON.stringify(subject)}: ability=${inMemory} enforcer=${enforced}`);
            }
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
    expect(checked).toBe(userIds.length * domains.length * actions.length * (types.length + instances.length));
    expect(allowed).toBeGreaterThan(checked * 0.05);
    expect(allowed).toBeLessThan(checked * 0.95);
  });
});

describe('scope semantics', () => {
  it('assignments above the tenant cover it, but only its own rows', async () => {
    for (const id of ['platform', 'partner', 'tenant']) {
      const ability = await abilityFor(id);
      expect(ability.can('read', wo({ siteId: 1003 })), id).toBe(true);
      expect(ability.can('read', wo({ orgId: 900, siteId: 2001 })), id).toBe(false);
      expect(ability.can('read', new Reading({ id: 1, siteId: 1003 })), id).toBe(true);
      expect(ability.can('read', new Reading({ id: 1, siteId: 2001 })), id).toBe(false);
    }
  });

  it('group and site assignments reach only their leaves', async () => {
    const group = await abilityFor('group');
    expect(group.can('update', wo({ siteId: 1002 }))).toBe(true);
    expect(group.can('update', wo({ siteId: 1003 }))).toBe(false);
    expect(group.can('update', WorkOrder)).toBe(true); // held somewhere in the domain
    const site = await abilityFor('site');
    expect(site.can('read', new Reading({ id: 1, siteId: 1003 }))).toBe(true);
    expect(site.can('read', new Reading({ id: 1, siteId: 1001 }))).toBe(false);
    expect(site.can('update', wo({ siteId: 1001, assigneeId: 'site' }))).toBe(true);
    expect(site.can('update', wo({ siteId: 1003, assigneeId: 'site' }))).toBe(false);
  });

  it('checks the tenant column even when the leaf is in scope', async () => {
    const group = await abilityFor('group');
    expect(group.can('read', wo({ orgId: 900, siteId: 1001 }))).toBe(false);
    expect(group.can('read', wo({ orgId: null, siteId: 1001 }))).toBe(false);
    expect(group.can('read', wo({ siteId: null }))).toBe(false);
  });

  it('expands custom roles, respects validity windows and limitTo', async () => {
    expect((await abilityFor('custom')).can('update', wo({ siteId: 1003 }))).toBe(true);
    expect((await abilityFor('custom')).can('update', wo({ siteId: 1001 }))).toBe(false);
    expect((await abilityFor('expired')).can('read', WorkOrder)).toBe(false);
    expect((await abilityFor('future')).can('read', WorkOrder)).toBe(false);
    const windowed = await abilityFor('windowed');
    expect(windowed.can('read', WorkOrder)).toBe(true);
    expect(windowed.expiresAt).toBe(NOW + 24 * 3600 * 1000);
    expect((await abilityFor('future')).expiresAt).toBe(NOW + 24 * 3600 * 1000);
    const limited = await abilityFor('limited');
    expect(limited.can('read', WorkOrder)).toBe(true);
    expect(limited.can('update', WorkOrder)).toBe(false);
    expect(limited.can('delete', Site)).toBe(false);
    // limitTo outside the role grants nothing
    expect((await abilityFor('mixed')).can('update', wo({}))).toBe(false);
  });

  it('applies global denies and their reasons', async () => {
    const ability = await abilityFor('platform');
    const invoiced = wo({ status: 'invoiced' });
    expect(ability.can('delete', invoiced)).toBe(false);
    expect(ability.relevantRuleFor('delete', invoiced)?.reason).toBe('Invoiced work orders are immutable');
    await expect(authz.assert({ id: 'platform' }, 'delete', invoiced, { domain: 'org:812', snapshot: snapshotFor('platform') }))
      .rejects.toMatchObject({ name: 'ForbiddenError', details: { reason: 'Invoiced work orders are immutable' } });
  });

  it('does not reach other tenants', async () => {
    const ability = await abilityFor('otherTenant');
    expect(ability.can('read', WorkOrder)).toBe(false);
    expect(ability.resolveScope('read', WorkOrder)).toEqual({ kind: 'none' });
  });

  it('reports unknown roles instead of throwing', async () => {
    issues.length = 0;
    expect((await abilityFor('unknown')).can('read', WorkOrder)).toBe(false);
    expect(issues).toEqual([{ kind: 'unknown-role', role: 'nope', source: undefined }]);
  });

  it('refuses subjects without a scope mapping', async () => {
    const ability = await abilityFor('platform');
    expect(() => ability.can('read', Unmapped)).toThrow(ScopeMappingError);
    expect(() => ability.resolveScope('read', Unmapped)).toThrow(ScopeMappingError);
  });

  it('refuses leaf lists over maxScopeLeaves', async () => {
    const big = createScopeTree([
      { key: 'org:1' },
      ...Array.from({ length: 6 }, (_, i) => ({ key: `site:${i}`, parent: 'org:1', leaf: i })),
    ]);
    const small = await Authz.create<User>({ grants: 'snapshot', policies, subjects, maxScopeLeaves: 5, logger: false });
    const ability = await small.abilityFor(
      { id: 'u' },
      { domain: 'org:1', snapshot: { tree: big, assignments: [{ role: 'site.read', scope: 'org:1' }] } },
    );
    expect(() => ability.can('read', new Reading({ id: 1, siteId: 1 }))).toThrow(ScopeTooLargeError);
    expect(ability.can('read', new WorkOrder({ orgId: 1, siteId: 1 }))).toBe(true); // tenant column: no leaf list needed
  });
});

describe('resolveScope', () => {
  it('returns none when nothing allows it', async () => {
    expect(resolveScope(await abilityFor('nobody'), 'read', WorkOrder)).toEqual({ kind: 'none' });
  });

  it('always carries the tenant predicate, even for manage all', async () => {
    expect(resolveScope(await abilityFor('platform'), 'update', WorkOrder)).toEqual({
      kind: 'condition',
      node: { kind: 'field', field: 'orgId', op: '$eq', value: 812 },
    });
    expect(resolveScope(await abilityFor('platform'), 'read', Reading)).toEqual({
      kind: 'condition',
      node: { kind: 'field', field: 'siteId', op: '$in', value: [1001, 1002, 1003] },
    });
  });

  it('adds leaf predicates for sub-tenant scopes and resolves refs', async () => {
    expect(resolveScope(await abilityFor('group'), 'read', WorkOrder)).toEqual({
      kind: 'condition',
      node: {
        kind: 'and',
        nodes: [
          { kind: 'field', field: 'orgId', op: '$eq', value: 812 },
          { kind: 'field', field: 'siteId', op: '$in', value: [1001, 1002] },
        ],
      },
    });
    const site = resolveScope(await abilityFor('site'), 'update', WorkOrder);
    expect(site).toEqual({
      kind: 'condition',
      node: {
        kind: 'and',
        nodes: [
          { kind: 'field', field: 'orgId', op: '$eq', value: 812 },
          { kind: 'field', field: 'siteId', op: '$in', value: [1001] },
          { kind: 'field', field: 'assigneeId', op: '$eq', value: 'site' },
        ],
      },
    });
  });

  it('includes global denies as NOT', async () => {
    const scope = resolveScope(await abilityFor('tenant'), 'delete', WorkOrder);
    expect(scope).toEqual({ kind: 'none' }); // org.manager cannot delete work orders at all
    const del = resolveScope(await abilityFor('platform'), 'delete', WorkOrder);
    expect(del).toEqual({
      kind: 'condition',
      node: {
        kind: 'and',
        nodes: [
          { kind: 'field', field: 'orgId', op: '$eq', value: 812 },
          { kind: 'not', node: { kind: 'field', field: 'status', op: '$eq', value: 'invoiced' } },
        ],
      },
    });
  });

  it('rejects malformed scopes from a buggy resolver', () => {
    for (const bad of [undefined, null, {}, { kind: 'condition' }, { kind: 'condition', node: { kind: 'const', value: false } }]) {
      expect(() => resolveScope({ resolveScope: () => bad as never }, 'read', WorkOrder)).toThrow(/scope/i);
    }
  });
});

describe('external grants mode is read-only', () => {
  it('throws on every write API', async () => {
    const set = definePolicies(({ role }) => role('x').can('read', 'Doc'));
    await expect(authz.grant(set)).rejects.toBeInstanceOf(ReadOnlyError);
    await expect(authz.revoke(set)).rejects.toBeInstanceOf(ReadOnlyError);
    await expect(authz.assignRole('u', 'x', 'org:812')).rejects.toBeInstanceOf(ReadOnlyError);
    await expect(authz.unassignRole('u', 'x')).rejects.toBeInstanceOf(ReadOnlyError);
    await expect(authz.syncPolicies(set)).rejects.toBeInstanceOf(ReadOnlyError);
    await expect(authz.listRules()).rejects.toBeInstanceOf(ReadOnlyError);
    await expect(authz.reload()).rejects.toBeInstanceOf(ReadOnlyError);
    expect(() => authz.enforcer).toThrow(/no global enforcer/);
  });

  it('rejects policies that would be unscoped', async () => {
    const unscoped = definePolicies(({ everyone }) => everyone.can('read', Site));
    await expect(Authz.create({ grants: 'snapshot', subjects, policies: unscoped })).rejects.toThrow(/unscoped/);
    const roleDeny = definePolicies(({ role }) => role('x').cannot('read', Site));
    await expect(Authz.create({ grants: 'snapshot', subjects, policies: roleDeny })).rejects.toThrow(/cannot/);
    await expect(Authz.create({ grants: 'snapshot', policies })).rejects.toThrow(/subject map/);
  });

  it('loads grants from a GrantSource', async () => {
    const calls: string[] = [];
    const sourced = await Authz.create<User>({
      policies,
      subjects,
      now: () => NOW,
      grants: { load: (user, domain) => (calls.push(`${user.id}@${domain}`), snapshotFor(user.id)) },
    });
    expect(await sourced.enforce({ id: 'group' }, 'read', wo({ siteId: 1002 }), { domain: 'org:812' })).toBe(true);
    expect(calls).toEqual(['group@org:812']);
  });
});

describe('scope trees with several parents', () => {
  it('reaches a site through any of its parents, and lists each leaf once', async () => {
    const fridges = await abilityFor('fridges');
    expect(fridges.can('read', wo({ siteId: 1001 }))).toBe(true);
    expect(fridges.can('read', wo({ siteId: 1003 }))).toBe(true);
    expect(fridges.can('read', wo({ siteId: 1002 }))).toBe(false);
    expect(resolveScope(fridges, 'read', Reading)).toEqual({
      kind: 'condition',
      node: { kind: 'field', field: 'siteId', op: '$in', value: [1001, 1003] },
    });
    expect(resolveScope(await abilityFor('platform'), 'read', Reading)).toEqual({
      kind: 'condition',
      node: { kind: 'field', field: 'siteId', op: '$in', value: [1001, 1002, 1003] },
    });
  });

  it('validates parents', () => {
    expect(() => createScopeTree([{ key: 'a' }, { key: 'a', parent: 'b' }])).toThrow(/Duplicate scope key/);
    expect(() => createScopeTree([{ key: 'a', parent: 'a' }])).toThrow(/Invalid parent/);
    const cyclic = createScopeTree([{ key: 'a', parent: 'b' }, { key: 'b', parent: 'a' }]);
    expect(cyclic.contains('x', 'a')).toBe(false);
  });
});

describe('subjects linked to the tenant through a set', () => {
  it('limits tenant-wide grants to the domain list', async () => {
    const tenant = await abilityFor('tenant');
    expect(tenant.can('read', new Member({ id: 1, userId: 'alice' }))).toBe(true);
    expect(tenant.can('read', new Member({ id: 2, userId: 'carol' }))).toBe(false);
    expect(tenant.can('read', new Member({ id: 3, userId: null }))).toBe(false);
    expect(resolveScope(tenant, 'read', Member)).toEqual({
      kind: 'condition',
      node: { kind: 'field', field: 'userId', op: '$in', value: ['alice', 'bob'] },
    });
    const other = await abilityFor('platform', 'org:900');
    expect(other.can('read', new Member({ id: 2, userId: 'carol' }))).toBe(true);
  });

  it('gives sub-tenant grants nothing, because the subject has no leaf', async () => {
    const group = await abilityFor('group');
    expect(group.can('read', Member)).toBe(true); // site.read is held in the domain
    expect(group.can('read', new Member({ id: 1, userId: 'alice' }))).toBe(false);
    expect(resolveScope(group, 'read', Member)).toEqual({ kind: 'none' });
  });

  it('throws when the snapshot lacks the list', async () => {
    const ability = await authz.abilityFor({ id: 'tenant' }, { domain: 'org:812', snapshot: { ...snapshotFor('tenant'), lists: {} } });
    expect(() => ability.resolveScope('read', Member)).toThrow(ScopeMappingError);
    expect(() => ability.can('read', new Member({ id: 1, userId: 'alice' }))).toThrow(ScopeMappingError);
  });

  it('rejects a malformed tenant set', () => {
    expect(() => defineSubjects({ X: { tenant: { field: 'userId', in: '' } } })).toThrow(/tenant.in/);
    expect(() => defineSubjects({ X: { tenant: { field: 'a.b', in: 'x' } } })).toThrow(/root fields only/);
  });
});

describe('holds, permissions and covers', () => {
  it('holds: any of the keys, anywhere in the domain', async () => {
    const group = await abilityFor('group');
    expect(group.holds('work_order.update')).toBe(true);
    expect(group.holds('org.manager')).toBe(true);
    expect(group.holds(['platform.admin', 'site.read'])).toBe(true);
    expect(group.holds('platform.admin')).toBe(false);
    expect((await abilityFor('otherTenant')).holds('site.read')).toBe(false);
    expect((await abilityFor('limited')).holds('work_order.update')).toBe(false);
  });

  it('permissions: keys with scopes and sources', async () => {
    const mixed = await abilityFor('mixed');
    expect(mixed.permissions()).toEqual([
      { key: 'site.manage', tenantWide: false, scopes: ['site:1003'], sources: ['direct'] },
      { key: 'site.read', tenantWide: false, scopes: ['group:north'], sources: ['direct'] },
    ]);
    const partner = await abilityFor('partner');
    expect(partner.permissions().find((p) => p.key === 'site.read')).toEqual({
      key: 'site.read',
      tenantWide: true,
      scopes: ['partner:7'],
      sources: ['partner'],
    });
  });

  it('covers: every key at the scope or above', async () => {
    const group = await abilityFor('group');
    expect(group.covers(['site.read', 'work_order.update'], 'group:north')).toBe(true);
    expect(group.covers(['site.read'], 'site:1002')).toBe(true);
    expect(group.covers(['site.read'], 'site:1003')).toBe(false);
    expect(group.covers(['site.read'], 'org:812')).toBe(false);
    expect(group.covers(['site.read', 'platform.admin'], 'group:north')).toBe(false);
    expect(group.covers(['site.read'], 'org:900')).toBe(false); // outside the domain
    const tenant = await abilityFor('tenant');
    expect(tenant.covers(['site.manage'], 'org:812')).toBe(true);
    expect(tenant.covers(['site.manage'], 'site:1001')).toBe(true);
  });

  it('covers can ignore delegated grants, so delegations are not passed on', async () => {
    const limited = await abilityFor('limited');
    expect(limited.covers(['site.read'], 'org:812')).toBe(true);
    expect(limited.covers(['site.read'], 'org:812', { excludeSources: ['delegation'] })).toBe(false);
  });

  it('needs external grants mode', () => {
    const plain = createAbility([]);
    expect(() => plain.holds('x')).toThrow(/external grants mode/);
    expect(() => plain.permissions()).toThrow(/external grants mode/);
  });
});
