import { definePolicies } from '@castellan/core';
import { Site, WorkOrder } from './entities/index.js';
import type { AppAction, AppUser } from './users.js';

export const policies = definePolicies<AppUser, AppAction>(({ everyone, role, user }) => {
  // Everyone can read work orders at their own sites.
  everyone.can('read', WorkOrder, { siteId: { $in: user.siteIds } });

  // Nobody (not even an admin: deny beats allow) can delete an invoiced work order.
  everyone.cannot('delete', WorkOrder, { status: 'invoiced' }).because('Invoiced work orders are immutable');

  // Technicians update their own work orders until they are closed.
  role('technician').can('update', WorkOrder, { assigneeId: user.id, status: { $ne: 'closed' } });

  role('site-manager', ({ can, inherits }) => {
    inherits('technician');
    can(['update', 'delete'], WorkOrder, { siteId: { $in: user.siteIds } });
    can('manage', Site, { id: { $in: user.siteIds } });
  });

  role('org-admin').can('manage', 'all');
});
