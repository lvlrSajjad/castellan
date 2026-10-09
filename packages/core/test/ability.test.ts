import { beforeAll, describe, expect, it } from 'vitest';
import { Authz, ForbiddenError, SubjectTypeError, subject } from '../src/index.js';
import { type AppAction, type AppUser, Invoice, Site, WorkOrder, policies } from './fixtures.js';

const tech: AppUser = { id: 'tech', siteIds: [1] };
const manager: AppUser = { id: 'manager', siteIds: [1, 2] };
const director: AppUser = { id: 'director', siteIds: [], managerOf: 2 };
const directorNoSite: AppUser = { id: 'directorNoSite', siteIds: [] };
const finance: AppUser = { id: 'finance', siteIds: [] };
const auditor: AppUser = { id: 'auditor', siteIds: [] };

const wo = (init: Partial<WorkOrder>) =>
  new WorkOrder({ id: 1, siteId: 1, assigneeId: 'tech', status: 'open', priority: 1, dueAt: null, ...init });

let authz: Authz<AppUser, AppAction>;

beforeAll(async () => {
  authz = await Authz.create<AppUser, AppAction>({ policies, logger: false });
  await authz.assignRole('tech', 'technician');
  await authz.assignRole('manager', 'site-manager', 'org-1');
  await authz.assignRole('director', 'director');
  await authz.assignRole('directorNoSite', 'director');
  await authz.assignRole('finance', 'finance');
  await authz.assignRole('auditor', 'auditor');
});

describe('ABAC conditions', () => {
  it('scopes reads to the user sites via $in + $ref', async () => {
    const ability = await authz.abilityFor(tech, { domain: 'org-1' });
    expect(ability.can('read', wo({ siteId: 1 }))).toBe(true);
    expect(ability.can('read', wo({ siteId: 2 }))).toBe(false);
  });

  it('lets technicians update only their own non-closed work orders', async () => {
    const ability = await authz.abilityFor(tech, { domain: 'org-1' });
    expect(ability.can('update', wo({}))).toBe(true);
    expect(ability.can('update', wo({ status: 'closed' }))).toBe(false);
    expect(ability.can('update', wo({ assigneeId: 'someone-else' }))).toBe(false);
  });

  it('supports $or, $exists and one-level dotted paths', async () => {
    const ability = await authz.abilityFor(manager, { domain: 'org-1' });
    expect(ability.can('approve', wo({ dueAt: null }))).toBe(true);
    expect(ability.can('approve', wo({ dueAt: new Date(), site: { region: 'west' } }))).toBe(true);
    expect(ability.can('approve', wo({ dueAt: new Date(), site: { region: 'east' } }))).toBe(false);
  });

  it('checks tagged plain objects and rejects untagged ones', async () => {
    const ability = await authz.abilityFor(tech, { domain: 'org-1' });
    expect(ability.can('read', subject(WorkOrder, { siteId: 1 }))).toBe(true);
    expect(() => ability.can('read', { siteId: 1 })).toThrow(SubjectTypeError);
  });
});

describe('RBAC', () => {
  it('inherits roles and respects role domains', async () => {
    const inOrg1 = await authz.abilityFor(manager, { domain: 'org-1' });
    const inOrg2 = await authz.abilityFor(manager, { domain: 'org-2' });
    // site-manager inherits technician
    expect(inOrg1.can('update', wo({ siteId: 9, assigneeId: 'manager' }))).toBe(true);
    expect(inOrg1.can('delete', wo({ siteId: 2 }))).toBe(true);
    expect(inOrg2.can('delete', wo({ siteId: 2 }))).toBe(false);
  });

  it('expands manage and all', async () => {
    const ability = await authz.abilityFor(manager, { domain: 'org-1' });
    expect(ability.can('delete', new Site({ id: 2 }))).toBe(true);
    expect(ability.can('manage', new Site({ id: 2 }))).toBe(true);
    expect(ability.can('delete', new Site({ id: 3 }))).toBe(false);
  });

  it('scopes domain-specific roles', async () => {
    expect((await authz.abilityFor(finance, { domain: 'org-1' })).can('read', Invoice)).toBe(true);
    expect((await authz.abilityFor(finance, { domain: 'org-2' })).can('read', Invoice)).toBe(false);
  });
});

describe('deny rules', () => {
  it('any matching deny wins, with its reason', async () => {
    const ability = await authz.abilityFor(manager, { domain: 'org-1' });
    const invoiced = wo({ siteId: 2, status: 'invoiced' });
    expect(ability.can('delete', invoiced)).toBe(false);
    expect(ability.relevantRuleFor('delete', invoiced)?.reason).toBe('Invoiced work orders are immutable');
  });

  it('type-level checks ignore conditional denies but honour unconditional ones', async () => {
    const ability = await authz.abilityFor(auditor, { domain: 'org-1' });
    expect(ability.can('read', Site)).toBe(true);
    expect(ability.can('read', Invoice)).toBe(false);
    const managerAbility = await authz.abilityFor(manager, { domain: 'org-1' });
    expect(managerAbility.can('delete', WorkOrder)).toBe(true);
  });

  it('assert throws ForbiddenError carrying the reason', async () => {
    const invoiced = wo({ siteId: 2, status: 'invoiced' });
    await expect(authz.assert(manager, 'delete', invoiced, { domain: 'org-1' })).rejects.toMatchObject({
      name: 'ForbiddenError',
      message: 'Invoiced work orders are immutable',
      details: { reason: 'Invoiced work orders are immutable', subjectType: 'WorkOrder' },
    });
    await expect(authz.assert(manager, 'delete', wo({ siteId: 2 }), { domain: 'org-1' })).resolves.toBeUndefined();
    await expect(authz.assert(tech, 'delete', wo({}), { domain: 'org-1' })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('unresolved $ref fails closed', () => {
  it('does not match allow rules and does match deny rules', async () => {
    const withSite = await authz.abilityFor(director, { domain: 'org-1' });
    const noSite = await authz.abilityFor(directorNoSite, { domain: 'org-1' });
    expect(withSite.can('approve', wo({ siteId: 2 }))).toBe(true);
    expect(noSite.can('approve', wo({ siteId: 2 }))).toBe(false);
    expect(await authz.enforce(directorNoSite, 'approve', wo({ siteId: 2 }), { domain: 'org-1' })).toBe(false);
  });
});

describe('field-level permissions', () => {
  it('handles field rules and permittedFieldsOf', async () => {
    const ability = await authz.abilityFor(finance, { domain: 'org-1' });
    const invoice = new Invoice({ id: 1, amount: 5, internalNotes: 'n' });
    expect(ability.can('update', invoice)).toBe(true);
    expect(ability.can('update', invoice, 'amount')).toBe(true);
    expect(ability.can('update', invoice, 'internalNotes')).toBe(false);
    expect(ability.can('read', invoice)).toBe(true);
    expect(ability.can('read', invoice, 'internalNotes')).toBe(false);
    expect(ability.permittedFieldsOf('read', invoice, { allFields: ['id', 'amount', 'internalNotes'] })).toEqual(['id', 'amount']);
    expect(ability.permittedFieldsOf('update', invoice)).toEqual(['amount']);
  });
});

describe('explain', () => {
  it('reports both layers and agreement', async () => {
    const result = await authz.explain(tech, 'update', wo({ status: 'closed' }), { domain: 'org-1' });
    expect(result).toMatchObject({ allowed: false, enforcer: false, agree: true });
    expect(result.message).toMatch(/no rule allows update WorkOrder/);
  });
});

describe('domains', () => {
  it('requires a domain when enabled', async () => {
    await expect(authz.abilityFor(tech)).rejects.toThrow(/domain is required/);
  });

  it('supports the 3-field model when domains are disabled', async () => {
    const flat = await Authz.create<AppUser, AppAction>({ policies, domains: false, logger: false });
    await flat.assignRole('tech', 'technician');
    expect(await flat.enforce(tech, 'update', wo({}))).toBe(true);
    expect((await flat.abilityFor(tech)).can('update', wo({ status: 'closed' }))).toBe(false);
  });
});

describe('canAll', () => {
  it('is true only when every subject passes can()', async () => {
    const ability = await authz.abilityFor(tech, { domain: 'org-1' });
    expect(ability.canAll('update', [wo({}), wo({})])).toBe(true);
    expect(ability.canAll('update', [wo({}), wo({ status: 'closed' })])).toBe(false);
  });

  it('is vacuously true for an empty array', async () => {
    const ability = await authz.abilityFor(tech, { domain: 'org-1' });
    expect(ability.canAll('update', [])).toBe(true);
  });
});

describe('canAny', () => {
  it('is true when at least one subject passes can()', async () => {
    const ability = await authz.abilityFor(tech, { domain: 'org-1' });
    expect(ability.canAny('update', [wo({}), wo({})])).toBe(true);
    expect(ability.canAny('update', [wo({ status: 'closed' }), wo({})])).toBe(true);
    expect(ability.canAny('update', [wo({ status: 'closed' }), wo({ assigneeId: 'someone-else' })])).toBe(false);
  });

  it('is false for an empty array', async () => {
    const ability = await authz.abilityFor(tech, { domain: 'org-1' });
    expect(ability.canAny('update', [])).toBe(false);
  });
});
