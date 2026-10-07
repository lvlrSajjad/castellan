import { describe, expect, it } from 'vitest';
import { Authz, subject } from '../src/index.js';
import { type AppAction, type AppUser, Invoice, Site, WorkOrder, policies } from './fixtures.js';

const users: Record<string, AppUser> = {
  tech: { id: 'tech', siteIds: [1] },
  manager: { id: 'manager', siteIds: [1, 2] },
  director: { id: 'director', siteIds: [], managerOf: 2 },
  directorNoSite: { id: 'directorNoSite', siteIds: [] },
  finance: { id: 'finance', siteIds: [] },
  admin: { id: 'admin', siteIds: [] },
  auditor: { id: 'auditor', siteIds: [3] },
  nobody: { id: 'nobody', siteIds: [] },
};

const roleAssignments: Array<[string, string, string]> = [
  ['tech', 'technician', '*'],
  ['manager', 'site-manager', 'org-1'],
  ['director', 'director', '*'],
  ['directorNoSite', 'director', '*'],
  ['finance', 'finance', '*'],
  ['admin', 'admin', 'org-2'],
  ['auditor', 'auditor', '*'],
];

const subjects: Array<object | string | (abstract new (...a: never[]) => unknown)> = [
  WorkOrder,
  Site,
  Invoice,
  'Report',
  new WorkOrder({ id: 1, siteId: 1, assigneeId: 'tech', status: 'open', priority: 1, dueAt: null }),
  new WorkOrder({ id: 2, siteId: 1, assigneeId: 'tech', status: 'closed', priority: 1, dueAt: null }),
  new WorkOrder({ id: 3, siteId: 2, assigneeId: null, status: 'invoiced', priority: 7, dueAt: new Date('2026-01-01') }),
  new WorkOrder({ id: 4, siteId: 2, assigneeId: 'other', status: 'open', priority: 2, dueAt: new Date('2026-01-01'), site: { region: 'west' } }),
  new WorkOrder({ id: 5, siteId: 3, assigneeId: 'tech', status: 'open', priority: 2, dueAt: new Date('2026-01-01'), site: { region: 'east' } }),
  new Site({ id: 1, region: 'west' }),
  new Site({ id: 9, region: 'east' }),
  new Invoice({ id: 1, amount: 10, internalNotes: 'x' }),
  subject('WorkOrder', { id: 6, siteId: 1, assigneeId: 'tech', status: 'open', priority: 1, dueAt: null }),
];

const actions: Array<AppAction | 'manage'> = ['read', 'create', 'update', 'delete', 'approve', 'manage'];
const fields: Array<string | undefined> = [undefined, 'amount', 'internalNotes'];
const domains = ['org-1', 'org-2'];

describe('parity: ability.can === enforcer.enforce', async () => {
  const authz = await Authz.create<AppUser, AppAction>({ policies, logger: false });
  for (const [member, role, domain] of roleAssignments) await authz.assignRole(member, role, domain);

  it('agrees on every (user, domain, action, subject, field) combination', async () => {
    let checked = 0;
    let allowed = 0;
    const mismatches: string[] = [];
    for (const user of Object.values(users)) {
      for (const domain of domains) {
        const ability = await authz.abilityFor(user, { domain });
        for (const action of actions) {
          for (const subj of subjects) {
            for (const field of fields) {
              const inMemory = ability.can(action, subj, field);
              const enforced = await authz.enforce(user, action, subj, { domain, field });
              checked++;
              if (inMemory) allowed++;
              if (inMemory !== enforced) {
                mismatches.push(`${user.id}@${domain} ${action} ${JSON.stringify(subj)} ${field}: ability=${inMemory} enforcer=${enforced}`);
              }
            }
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
    expect(checked).toBe(8 * 2 * 6 * subjects.length * 3);
    // Sanity: the matrix is not trivially all-deny or all-allow.
    expect(allowed).toBeGreaterThan(checked * 0.05);
    expect(allowed).toBeLessThan(checked * 0.95);
  });
});
