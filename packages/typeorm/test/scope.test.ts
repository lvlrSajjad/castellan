import 'reflect-metadata';
import { Authz, definePolicies } from '@castellan/core';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CastellanRule, createTypeormAdapter, scopeQuery, toFindOptionsWhere } from '../src/index.js';
import { createTestDataSource } from './db.js';
import { Site, WorkOrder } from './entities.js';

interface User {
  id: string;
  siteIds: number[];
  maxPriority?: number;
}

const policies = definePolicies<User>(({ role, everyone, user }) => {
  everyone.can('read', WorkOrder, { siteId: { $in: user.siteIds } });
  everyone.cannot('read', WorkOrder, { status: 'archived' });
  role('tech').can('update', WorkOrder, { assigneeId: user.id, status: { $ne: 'closed' } });
  role('tech').can('update', WorkOrder, { urgent: true, priority: { $lte: user.maxPriority } });
  role('lead').can('approve', WorkOrder, { $or: [{ dueAt: { $exists: false } }, { 'site.region': 'west' }] });
  role('lead').cannot('approve', WorkOrder, { priority: { $gt: 7 }, assigneeId: { $nin: ['lead', null] } });
  role('lead').can('close', WorkOrder, { dueAt: { $lt: new Date('2026-06-01T00:00:00Z') } });
  role('lead').can('archive', WorkOrder, { assigneeId: null, status: { $in: ['open', 'closed'] } });
  role('admin').can('manage', 'all');
  role('admin').cannot('delete', WorkOrder, { urgent: true });
});

const users: User[] = [
  { id: 'tech', siteIds: [1, 2], maxPriority: 5 },
  { id: 'techNoMax', siteIds: [3] },
  { id: 'lead', siteIds: [] },
  { id: 'admin', siteIds: [] },
  { id: 'nobody', siteIds: [] },
];
const actions = ['read', 'update', 'approve', 'close', 'archive', 'delete'];

let ds: DataSource;
let authz: Authz<User>;
let all: WorkOrder[];

beforeAll(async () => {
  ds = createTestDataSource([Site, WorkOrder, CastellanRule]);
  await ds.initialize();
  await ds.getRepository(Site).save([
    { id: 1, region: 'west' },
    { id: 2, region: 'east' },
    { id: 3, region: 'west' },
  ]);
  const statuses = ['open', 'closed', 'archived', 'invoiced'];
  const assignees = ['tech', 'lead', 'other', null];
  const orders: Partial<WorkOrder>[] = [];
  for (let i = 1; i <= 96; i++) {
    orders.push({
      id: i,
      siteId: (i % 4) + 1, // site 4 has no Site row → null relation
      status: statuses[i % statuses.length]!,
      assigneeId: assignees[Math.floor(i / 4) % assignees.length]!,
      priority: i % 10,
      urgent: i % 3 === 0,
      dueAt: i % 5 === 0 ? null : new Date(Date.UTC(2026, i % 12, 1)),
    });
  }
  await ds.getRepository(WorkOrder).save(orders);
  all = await ds.getRepository(WorkOrder).find({ relations: { site: true }, order: { id: 'ASC' } });

  authz = await Authz.create<User>({ adapter: createTypeormAdapter(ds), policies, domains: false, logger: false });
  for (const role of ['tech', 'lead', 'admin']) await authz.assignRole(role, role);
  await authz.assignRole('techNoMax', 'tech');
});

afterAll(async () => {
  await ds.destroy();
});

describe('policy storage', () => {
  it('round-trips JSON conditions through the database (JSON with quotes and commas)', async () => {
    const reloaded = await Authz.create<User>({ adapter: createTypeormAdapter(ds), domains: false, logger: false });
    const fresh = await reloaded.listRules();
    expect(fresh).toEqual(await authz.listRules());
    expect(fresh.find((r) => r.action === 'close')?.conditions).toEqual({
      dueAt: { $lt: { $date: '2026-06-01T00:00:00.000Z' } },
    });
    expect(await ds.getRepository(CastellanRule).count()).toBe(policies.rules.length + 4);
  });
});

describe('parity: scopeQuery rows === rows where ability.can', () => {
  for (const user of users) {
    for (const action of actions) {
      it(`${user.id} ${action}`, async () => {
        const ability = await authz.abilityFor(user);
        const expected = all.filter((wo) => ability.can(action, wo)).map((wo) => wo.id);
        const qb = ds.getRepository(WorkOrder).createQueryBuilder('wo').leftJoin('wo.site', 'site');
        scopeQuery(qb, ability, action, WorkOrder);
        const actual = (await qb.orderBy('wo.id').getMany()).map((wo) => wo.id);
        expect(actual).toEqual(expected);
      });
    }
  }
});

describe('scopeQuery', () => {
  it('composes with existing OR conditions', async () => {
    const ability = await authz.abilityFor(users[0]!);
    const qb = ds
      .getRepository(WorkOrder)
      .createQueryBuilder('wo')
      .where('wo.priority = :a OR wo.priority = :b', { a: 1, b: 2 });
    scopeQuery(qb, ability, 'read', WorkOrder);
    const rows = await qb.getMany();
    expect(rows.length).toBeGreaterThan(0);
    for (const wo of rows) {
      expect([1, 2]).toContain(wo.priority);
      expect(ability.can('read', wo)).toBe(true);
    }
  });

  it('requires relations used in conditions to be joined', async () => {
    const ability = await authz.abilityFor(users[2]!);
    const qb = ds.getRepository(WorkOrder).createQueryBuilder('wo');
    expect(() => scopeQuery(qb, ability, 'approve', WorkOrder)).toThrow(/relation "site" is not joined/);
  });

  it('returns no rows when nothing is allowed', async () => {
    const ability = await authz.abilityFor(users[4]!);
    const qb = scopeQuery(ds.getRepository(WorkOrder).createQueryBuilder('wo'), ability, 'update', WorkOrder);
    expect(await qb.getCount()).toBe(0);
  });

  it('never interpolates values into SQL', async () => {
    const evil: User = { id: "x' OR '1'='1", siteIds: [] };
    await authz.assignRole(evil.id, 'tech');
    const ability = await authz.abilityFor(evil);
    const qb = scopeQuery(ds.getRepository(WorkOrder).createQueryBuilder('wo'), ability, 'update', WorkOrder);
    expect(qb.getQuery()).not.toContain("'1'='1");
    expect(await qb.getCount()).toBe(0);
  });
});

describe('toFindOptionsWhere', () => {
  it('matches scopeQuery for allow-only rule sets', async () => {
    for (const user of users) {
      for (const action of ['update', 'approve', 'close', 'archive']) {
        const ability = await authz.abilityFor(user);
        if (ability.rulesFor(action, WorkOrder).deny.length) continue;
        const expected = all.filter((wo) => ability.can(action, wo)).map((wo) => wo.id);
        const where = toFindOptionsWhere<WorkOrder>(ability, action, WorkOrder);
        const actual =
          where === null
            ? []
            : (await ds.getRepository(WorkOrder).find({ where, relations: { site: true }, order: { id: 'ASC' } })).map(
                (wo) => wo.id,
              );
        expect(actual, `${user.id} ${action}`).toEqual(expected);
      }
    }
  });

  it('refuses conditional deny rules', async () => {
    const ability = await authz.abilityFor(users[0]!);
    expect(() => toFindOptionsWhere(ability, 'read', WorkOrder)).toThrow(/use scopeQuery/);
  });
});
