import { definePolicies } from '../src/index.js';

export class WorkOrder {
  id!: number;
  siteId!: number;
  assigneeId!: string | null;
  status!: 'open' | 'closed' | 'invoiced';
  priority!: number;
  dueAt!: Date | null;
  site?: { region: string };
  constructor(init: Partial<WorkOrder>) {
    Object.assign(this, init);
  }
}

export class Site {
  id!: number;
  region!: string;
  constructor(init: Partial<Site>) {
    Object.assign(this, init);
  }
}

export class Invoice {
  id!: number;
  amount!: number;
  internalNotes!: string;
  constructor(init: Partial<Invoice>) {
    Object.assign(this, init);
  }
}

export interface AppUser {
  id: string;
  siteIds: number[];
  managerOf?: number;
}

export type AppAction = 'read' | 'create' | 'update' | 'delete' | 'approve';

export const policies = definePolicies<AppUser, AppAction>(({ role, everyone, user }) => {
  everyone.can('read', WorkOrder, { siteId: { $in: user.siteIds } });
  everyone.cannot('delete', WorkOrder, { status: 'invoiced' }).because('Invoiced work orders are immutable');

  role('technician', ({ can }) => {
    can('update', WorkOrder, { assigneeId: user.id, status: { $ne: 'closed' } });
  });

  role('site-manager', ({ can, cannot, inherits }) => {
    inherits('technician');
    can(['update', 'delete'], WorkOrder, { siteId: { $in: user.siteIds } });
    can('manage', Site, { id: { $in: user.siteIds } });
    cannot('approve', WorkOrder, { priority: { $gte: 5 } }).because('High priority needs a director');
    can('approve', WorkOrder, { $or: [{ dueAt: { $exists: false } }, { 'site.region': 'west' }] });
  });

  role('finance', { domain: 'org-1' }, ({ can, cannot }) => {
    can('read', Invoice);
    can('update', Invoice, ['amount']);
    cannot('read', Invoice, ['internalNotes']);
  });

  role('director').can('approve', WorkOrder, { siteId: user.managerOf });
  role('director').cannot('delete', WorkOrder, { siteId: { $ne: user.managerOf } });
  role('admin').can('manage', 'all');
  role('auditor').can('read', 'all');
  role('auditor').cannot('read', Invoice).because('Auditors cannot see invoices');
});
