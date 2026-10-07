import 'reflect-metadata';
import { Authz, EmptyScopeError, InvalidScopeError, type ResolvedScope, createScopeTree } from '@castellanjs/core';
import type { DataSource, ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  NOW,
  type User,
  actions,
  domains,
  policies,
  snapshotFor,
  subjects,
  userIds,
} from '../../core/test/scoped-fixtures.js';
import { applyScope, scopeQuery, toFindOptionsWhere } from '../src/index.js';
import { DB, createTestDataSource } from './db.js';
import { explainScope } from './explain.js';
import { Reading, Site, WorkOrder } from './scoped-entities.js';

let ds: DataSource;
let authz: Authz<User>;
const rows: { Site: Site[]; WorkOrder: WorkOrder[]; Reading: Reading[] } = { Site: [], WorkOrder: [], Reading: [] };
const entities = { Site, WorkOrder, Reading };

// Leaf ids used by the fixtures, plus sentinels: 0, NULL, and a site in no tree.
const siteIds = [1001, 1002, 1003, 2001, 0, null, 4242];
const orgIds = [812, 900, 0, null];

beforeAll(async () => {
  ds = createTestDataSource([Site, WorkOrder, Reading]);
  await ds.initialize();
  await ds.getRepository(Site).save(
    [1001, 1002, 1003, 2001, 4242].map((id) => ({ id, orgId: id === 2001 ? 900 : 812 })),
  );
  const orders: Partial<WorkOrder>[] = [];
  let id = 1;
  for (const siteId of siteIds) {
    for (const orgId of orgIds) {
      for (const status of ['open', 'closed', 'invoiced']) {
        for (const assigneeId of ['site', 'group', null]) orders.push({ id: id++, siteId, orgId, status, assigneeId });
      }
    }
  }
  await ds.getRepository(WorkOrder).save(orders, { chunk: 200 });
  await ds.getRepository(Reading).save(siteIds.map((siteId, i) => ({ id: i + 1, siteId })));
  for (const name of ['Site', 'WorkOrder', 'Reading'] as const) {
    rows[name] = (await ds.getRepository(entities[name] as never).find({ order: { id: 'ASC' } })) as never;
  }
  authz = await Authz.create<User>({ grants: 'snapshot', policies, subjects, now: () => NOW, logger: false });
});

afterAll(async () => {
  await ds?.destroy();
});

const ids = (list: ObjectLiteral[]) => list.map((r) => r.id as number);

describe(`scoped parity on ${DB}: scopeQuery rows === rows where ability.can`, () => {
  for (const userId of userIds) {
    it(userId, async () => {
      const mismatches: string[] = [];
      for (const domain of domains) {
        const ability = await authz.abilityFor({ id: userId }, { domain, snapshot: snapshotFor(userId) });
        for (const action of actions) {
          for (const name of ['Site', 'WorkOrder', 'Reading'] as const) {
            const expected = ids(rows[name].filter((row) => ability.can(action, row)));
            const qb = ds.getRepository(entities[name] as never).createQueryBuilder('x') as SelectQueryBuilder<ObjectLiteral>;
            scopeQuery(qb, ability, action, entities[name]);
            const actual = ids(await qb.orderBy('x.id').getMany());
            if (JSON.stringify(actual) !== JSON.stringify(expected)) {
              mismatches.push(`${domain} ${action} ${name}: sql=${JSON.stringify(actual)} ability=${JSON.stringify(expected)}`);
            }
          }
        }
      }
      expect(mismatches).toEqual([]);
    });
  }
});

describe('applyScope', () => {
  it('rejects malformed scopes instead of returning every row', () => {
    for (const bad of [undefined, null, {}, { kind: 'condition' }]) {
      const qb = ds.getRepository(WorkOrder).createQueryBuilder('wo');
      expect(() => applyScope(qb, bad as never)).toThrow(InvalidScopeError);
      expect(() => scopeQuery(qb, { resolveScope: () => bad as never }, 'read', WorkOrder)).toThrow(InvalidScopeError);
      expect(() => toFindOptionsWhere({ resolveScope: () => bad as never }, 'read', WorkOrder)).toThrow(InvalidScopeError);
    }
  });

  it("require: 'condition' throws instead of matching nothing", async () => {
    const ability = await authz.abilityFor({ id: 'nobody' }, { domain: 'org:812', snapshot: snapshotFor('nobody') });
    const qb = ds.getRepository(WorkOrder).createQueryBuilder('wo');
    expect(() => scopeQuery(qb, ability, 'read', WorkOrder, { require: 'condition' })).toThrow(EmptyScopeError);
    expect(await scopeQuery(ds.getRepository(WorkOrder).createQueryBuilder('wo'), ability, 'read', WorkOrder).getCount()).toBe(0);
  });

  it('relations: false rejects relation paths', () => {
    const resolved: ResolvedScope = { kind: 'condition', node: { kind: 'field', field: 'site.region', op: '$eq', value: 'x' } };
    const qb = ds.getRepository(WorkOrder).createQueryBuilder('wo');
    expect(() => applyScope(qb, resolved, { relations: false })).toThrow(/relations are disabled/);
  });

  it('lets a repository base resolve once, check, then apply', async () => {
    const ability = await authz.abilityFor({ id: 'group' }, { domain: 'org:812', snapshot: snapshotFor('group') });
    const resolved = ability.resolveScope('read', WorkOrder);
    expect(resolved.kind).toBe('condition');
    const list = await applyScope(ds.getRepository(WorkOrder).createQueryBuilder('wo'), resolved).getMany();
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((wo) => wo.orgId === 812 && [1001, 1002].includes(wo.siteId!))).toBe(true);
  });

  it('uses the scope column indexes', async () => {
    const ability = await authz.abilityFor({ id: 'group' }, { domain: 'org:812', snapshot: snapshotFor('group') });
    await explainScope(ds, scopeQuery(ds.getRepository(Reading).createQueryBuilder('r'), ability, 'read', Reading));
    await explainScope(ds, scopeQuery(ds.getRepository(WorkOrder).createQueryBuilder('wo'), ability, 'read', WorkOrder));
  });
});

describe('large leaf lists', () => {
  // org:77 with 5 000 sites; group:g1 holds the first 1 000.
  const big = createScopeTree([
    { key: 'org:77' },
    { key: 'group:g1', parent: 'org:77' },
    { key: 'group:g2', parent: 'org:77' },
    ...Array.from({ length: 5_000 }, (_, i) => ({ key: `site:${100_000 + i}`, parent: i < 1_000 ? 'group:g1' : 'group:g2', leaf: 100_000 + i })),
  ]);

  beforeAll(async () => {
    const extra = Array.from({ length: 6_000 }, (_, i) => ({ id: 1_000 + i, siteId: 99_500 + i }));
    await ds.getRepository(Reading).save(extra, { chunk: 500 });
  });

  for (const [scope, count] of [['group:g1', 1_000], ['org:77', 5_000]] as const) {
    it(`IN list of ${count} ids`, async () => {
      const ability = await authz.abilityFor(
        { id: 'big' },
        { domain: 'org:77', snapshot: { tree: big, assignments: [{ role: 'site.read', scope }] } },
      );
      const qb = scopeQuery(ds.getRepository(Reading).createQueryBuilder('r'), ability, 'read', Reading);
      const found = await qb.orderBy('r.id').getMany();
      expect(found).toHaveLength(count);
      expect(found.every((r) => ability.can('read', r))).toBe(true);
      if (count === 1_000) await explainScope(ds, qb);
    });
  }
});
