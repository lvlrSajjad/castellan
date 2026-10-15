import { describe, expect, it } from 'vitest';
import {
  ConditionError,
  definePolicies,
  evaluateCondition,
  normalizeConditions,
  reviveConditions,
  serializeConditions,
} from '../src/index.js';

const evaluate = (conditions: object, data: object, user: object = {}) =>
  evaluateCondition(normalizeConditions(reviveConditions(serializeConditions(conditions))), data, user);

describe('condition evaluation', () => {
  it('implements every v1 operator with SQL-compatible null semantics', () => {
    expect(evaluate({ a: 1 }, { a: 1 })).toBe(true);
    expect(evaluate({ a: { $ne: 1 } }, { a: null })).toBe(true);
    expect(evaluate({ a: { $in: [1, 2] } }, { a: 2 })).toBe(true);
    expect(evaluate({ a: { $in: [] } }, { a: 2 })).toBe(false);
    expect(evaluate({ a: { $nin: [1] } }, { a: null })).toBe(true);
    expect(evaluate({ a: { $gt: 1 } }, { a: 2 })).toBe(true);
    expect(evaluate({ a: { $gte: 2, $lt: 3 } }, { a: 2 })).toBe(true);
    expect(evaluate({ a: { $lte: 1 } }, { a: null })).toBe(false);
    expect(evaluate({ a: { $lte: 2 } }, { a: 2 })).toBe(true);
    expect(evaluate({ a: { $lte: 2 } }, { a: 3 })).toBe(false);
    expect(evaluate({ a: { $lt: 1 } }, { a: null })).toBe(false);
    expect(evaluate({ a: { $exists: true } }, { a: 0 })).toBe(true);
    expect(evaluate({ a: { $exists: false } }, { a: null })).toBe(true);
    expect(evaluate({ $or: [{ a: 1 }, { b: 1 }] }, { b: 1 })).toBe(true);
    expect(evaluate({ $and: [{ a: 1 }, { b: 1 }] }, { a: 1, b: 2 })).toBe(false);
    expect(evaluate({ 'site.region': 'west' }, { site: { region: 'west' } })).toBe(true);
    expect(evaluate({ 'site.region': 'west' }, { site: null })).toBe(false);
  });

  it('round-trips dates through JSON', () => {
    const d = new Date('2026-05-01T00:00:00Z');
    expect(serializeConditions({ due: { $lt: d } })).toEqual({ due: { $lt: { $date: d.toISOString() } } });
    expect(evaluate({ due: { $lt: d } }, { due: new Date('2026-04-01') })).toBe(true);
    expect(evaluate({ due: d }, { due: new Date(d) })).toBe(true);
  });

  it('resolves refs from the user', () => {
    expect(evaluate({ owner: { $ref: 'user.id' } }, { owner: 'u1' }, { id: 'u1' })).toBe(true);
    expect(evaluate({ site: { $in: { $ref: 'user.sites' } } }, { site: 3 }, { sites: [3] })).toBe(true);
  });

  it('rejects unsupported operators, unsafe field names and reserved keys', () => {
    expect(() => normalizeConditions({ a: { $regex: 'x' } })).toThrow(ConditionError);
    expect(() => normalizeConditions({ a: { $elemMatch: {} } })).toThrow(ConditionError);
    expect(() => normalizeConditions({ $where: 'x' })).toThrow(ConditionError);
    expect(() => normalizeConditions({ 'a.b.c': 1 })).toThrow(/one dotted relation level/);
    expect(() => normalizeConditions({ 'a; DROP TABLE x': 1 })).toThrow(ConditionError);
    expect(() => normalizeConditions({ __fields: 1 })).toThrow(/reserved/);
    expect(() => normalizeConditions({ a: [1, 2] })).toThrow(/Arrays are only allowed/);
    expect(() => normalizeConditions({ a: { $ref: 'process.env' } })).toThrow(/Invalid \$ref/);
  });
});

describe('user proxy', () => {
  it('compiles property access into refs', () => {
    const set = definePolicies<{ id: string; org: { id: string } }>(({ everyone, user }) => {
      everyone.can('read', 'Doc', { ownerId: user.id, orgId: user.org.id });
    });
    expect(set.rules[0]?.conditions).toEqual({ ownerId: { $ref: 'user.id' }, orgId: { $ref: 'user.org.id' } });
  });

  it('explains why branching on user values does not work', () => {
    expect(() =>
      definePolicies<{ roles: string[] }>(({ everyone, user }) => {
        if ((user.roles as unknown as string[]).includes('x')) everyone.can('read', 'Doc');
      }),
    ).toThrow(/Policies are static/);
    expect(() =>
      definePolicies<{ id: string }>(({ everyone, user }) => {
        everyone.can('read', 'Doc', { path: `${user.id as unknown as string}/x` });
      }),
    ).toThrow(/Policies are static/);
  });
});
