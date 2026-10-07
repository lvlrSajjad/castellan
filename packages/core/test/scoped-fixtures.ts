import { type Assignment, type GrantSnapshot, createScopeTree, definePolicies, defineSubjects } from '../src/index.js';

export class Site {
  id!: number;
  orgId!: number;
  constructor(init: Partial<Site>) {
    Object.assign(this, init);
  }
}

export class WorkOrder {
  id!: number;
  orgId!: number | null;
  siteId!: number | null;
  status!: string;
  assigneeId!: string | null;
  constructor(init: Partial<WorkOrder>) {
    Object.assign(this, init);
  }
}

/** No tenant column: tenant-wide means "all the tenant's leaves". */
export class Reading {
  id!: number;
  siteId!: number | null;
  constructor(init: Partial<Reading>) {
    Object.assign(this, init);
  }
}

/** Not in the subject map. */
export class Unmapped {
  id!: number;
}

export interface User {
  id: string;
}

//  *
//  ├─ partner:7
//  │  ├─ org:812
//  │  │  ├─ group:north ── site:1001, site:1002
//  │  │  └─ group:south ── site:1003
//  │  └─ org:900 ── site:2001
export const tree = createScopeTree([
  { key: 'partner:7' },
  { key: 'org:812', parent: 'partner:7' },
  { key: 'group:north', parent: 'org:812' },
  { key: 'group:south', parent: 'org:812' },
  { key: 'site:1001', parent: 'group:north', leaf: 1001 },
  { key: 'site:1002', parent: 'group:north', leaf: 1002 },
  { key: 'site:1003', parent: 'group:south', leaf: 1003 },
  { key: 'org:900', parent: 'partner:7' },
  { key: 'site:2001', parent: 'org:900', leaf: 2001 },
]);

export const subjects = defineSubjects({
  Site: { tenant: 'orgId', leaf: 'id' },
  WorkOrder: { tenant: 'orgId', leaf: 'siteId' },
  Reading: { leaf: 'siteId' },
});

export const policies = definePolicies<User>(({ role, everyone, user }) => {
  role('site.read').can('read', Site).can('read', WorkOrder).can('read', Reading);
  role('work_order.update').can('update', WorkOrder, { status: { $ne: 'closed' } });
  role('work_order.update_own').can('update', WorkOrder, { assigneeId: user.id });
  role('site.manage').can(['update', 'delete'], Site);
  role('org.manager', ({ inherits }) => inherits('site.read', 'work_order.update', 'site.manage'));
  role('platform.admin').can('manage', 'all');
  everyone.cannot('delete', WorkOrder, { status: 'invoiced' }).because('Invoiced work orders are immutable');
});

export const NOW = Date.UTC(2026, 9, 8);
const day = 24 * 3600 * 1000;

const grants: Record<string, { assignments: Assignment[]; roles?: Record<string, string[]> }> = {
  platform: { assignments: [{ role: 'platform.admin', scope: '*' }] },
  partner: { assignments: [{ role: 'org.manager', scope: 'partner:7', source: 'partner' }] },
  tenant: { assignments: [{ role: 'org.manager', scope: 'org:812' }] },
  group: { assignments: [{ role: 'org.manager', scope: 'group:north' }] },
  site: {
    assignments: [
      { role: 'site.read', scope: 'site:1003' },
      { role: 'work_order.update_own', scope: 'site:1001' },
    ],
  },
  custom: {
    roles: { 'custom:42': ['site.read', 'work_order.update'] },
    assignments: [{ role: 'custom:42', scope: 'group:south' }],
  },
  expired: { assignments: [{ role: 'org.manager', scope: 'org:812', validUntil: new Date(NOW - day) }] },
  future: { assignments: [{ role: 'org.manager', scope: 'org:812', validFrom: new Date(NOW + day).toISOString() }] },
  windowed: {
    assignments: [{ role: 'site.read', scope: 'org:812', validFrom: NOW - day, validUntil: new Date(NOW + day) }],
  },
  limited: { assignments: [{ role: 'org.manager', scope: 'org:812', limitTo: ['site.read'], source: 'delegation' }] },
  unknown: { assignments: [{ role: 'nope', scope: 'org:812' }] },
  otherTenant: { assignments: [{ role: 'org.manager', scope: 'org:900' }] },
  mixed: {
    assignments: [
      { role: 'site.read', scope: 'group:north' },
      { role: 'site.manage', scope: 'site:1003' },
      { role: 'work_order.update', scope: 'org:812', limitTo: ['site.read'] },
    ],
  },
  nobody: { assignments: [] },
};

export const userIds = Object.keys(grants);

export function snapshotFor(userId: string): GrantSnapshot {
  const g = grants[userId]!;
  return { assignments: g.assignments, roles: g.roles, tree };
}

export const instances: object[] = [
  new Site({ id: 1001, orgId: 812 }),
  new Site({ id: 1003, orgId: 812 }),
  new Site({ id: 2001, orgId: 900 }),
  new WorkOrder({ id: 1, orgId: 812, siteId: 1001, status: 'open', assigneeId: 'site' }),
  new WorkOrder({ id: 2, orgId: 812, siteId: 1002, status: 'closed', assigneeId: null }),
  new WorkOrder({ id: 3, orgId: 812, siteId: 1003, status: 'invoiced', assigneeId: 'group' }),
  new WorkOrder({ id: 4, orgId: 900, siteId: 2001, status: 'open', assigneeId: 'site' }),
  new WorkOrder({ id: 5, orgId: 900, siteId: 1001, status: 'open', assigneeId: 'site' }), // inconsistent tenant
  new WorkOrder({ id: 6, orgId: 812, siteId: null, status: 'open', assigneeId: 'site' }),
  new WorkOrder({ id: 7, orgId: null, siteId: 1001, status: 'open', assigneeId: 'site' }),
  new Reading({ id: 1, siteId: 1001 }),
  new Reading({ id: 2, siteId: 1003 }),
  new Reading({ id: 3, siteId: 2001 }),
  new Reading({ id: 4, siteId: null }),
];

export const types = [Site, WorkOrder, Reading];
export const actions = ['read', 'update', 'delete', 'manage', 'approve'] as const;
export const domains = ['org:812', 'org:900'];
