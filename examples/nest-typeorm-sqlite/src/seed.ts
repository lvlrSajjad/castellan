import { AuthzService } from '@castellanjs/nestjs';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Organization, Site, WorkOrder } from './entities/index.js';
import { ROLE_ASSIGNMENTS } from './users.js';

/** Inserts demo data into the in-memory database and assigns roles (per organization = Casbin domain). */
@Injectable()
export class SeedService implements OnApplicationBootstrap {
  constructor(
    private readonly dataSource: DataSource,
    private readonly authz: AuthzService,
  ) {}

  async onApplicationBootstrap() {
    await this.dataSource.getRepository(Organization).save([
      { id: 'north', name: 'North Facilities' },
      { id: 'south', name: 'South Facilities' },
    ]);
    await this.dataSource.getRepository(Site).save([
      { id: 1, orgId: 'north', name: 'Harbor Office', region: 'west' },
      { id: 2, orgId: 'north', name: 'Hilltop Depot', region: 'east' },
      { id: 3, orgId: 'south', name: 'Lakeside Plant', region: 'east' },
    ]);
    await this.dataSource.getRepository(WorkOrder).save([
      { id: 1, orgId: 'north', siteId: 1, assigneeId: 'tina', status: 'open', priority: 2, title: 'Replace lobby HVAC filter' },
      { id: 2, orgId: 'north', siteId: 1, assigneeId: 'sam', status: 'open', priority: 3, title: 'Fix loading dock door' },
      { id: 3, orgId: 'north', siteId: 1, assigneeId: 'tina', status: 'closed', priority: 1, title: 'Inspect fire extinguishers' },
      { id: 4, orgId: 'north', siteId: 2, assigneeId: 'sam', status: 'open', priority: 2, title: 'Repaint warehouse floor' },
      { id: 5, orgId: 'north', siteId: 1, assigneeId: 'tina', status: 'invoiced', priority: 1, title: 'Quarterly boiler service' },
      { id: 6, orgId: 'south', siteId: 3, assigneeId: 'tara', status: 'open', priority: 2, title: 'Clear drainage channel' },
    ]);
    for (const { userId, role, orgId } of ROLE_ASSIGNMENTS) {
      await this.authz.assignRole(userId, role, orgId);
    }
  }
}
