// Compile-time checks only (run by `tsc --noEmit`); not executed.
import { definePolicies } from '../src/index.js';
import { WorkOrder } from './fixtures.js';

interface User {
  id: string;
  siteIds: number[];
}

definePolicies<User, 'read' | 'update'>(({ everyone, role, user }) => {
  everyone.can('read', WorkOrder, { siteId: { $in: user.siteIds } });
  everyone.can('read', WorkOrder, { assigneeId: null, 'site.region': 'west' });
  role('x').can('update', WorkOrder, ['status', 'priority'], { assigneeId: user.id });
  role('x').can('manage', 'Report', { anything: 1 });

  // @ts-expect-error unknown field
  everyone.can('read', WorkOrder, { assigneId: user.id });
  // @ts-expect-error wrong value type
  everyone.can('read', WorkOrder, { priority: 'high' });
  // @ts-expect-error unknown operator
  everyone.can('read', WorkOrder, { priority: { $regex: 'x' } });
  // @ts-expect-error unknown action
  everyone.can('delete', WorkOrder);
  // @ts-expect-error unknown field in field list
  everyone.can('read', WorkOrder, ['nope']);
  // @ts-expect-error unknown user attribute
  everyone.can('read', WorkOrder, { assigneeId: user.email });
});
