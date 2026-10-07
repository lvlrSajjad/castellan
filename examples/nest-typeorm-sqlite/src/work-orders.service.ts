import { type Ability } from '@castellanjs/core';
import { scopeQuery } from '@castellanjs/typeorm';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WorkOrder, type WorkOrderStatus } from './entities/index.js';
import type { AppUser } from './users.js';

@Injectable()
export class WorkOrdersService {
  constructor(@InjectRepository(WorkOrder) private readonly repo: Repository<WorkOrder>) {}

  /** Work orders the ability allows the user to read, translated to SQL by scopeQuery. */
  findAccessible(user: AppUser, ability: Ability) {
    const qb = this.repo
      .createQueryBuilder('wo')
      .leftJoinAndSelect('wo.site', 'site') // joined so rules may also filter on e.g. site.region
      .where('wo.orgId = :orgId', { orgId: user.orgId }) // tenant filter; add before scopeQuery
      .orderBy('wo.id');
    return scopeQuery(qb, ability, 'read', WorkOrder).getMany();
  }

  /** Loads a work order, hiding other organizations' rows (the caller turns null into 404). */
  async findForUser(user: AppUser, id: string) {
    const wo = await this.repo.findOneBy({ id: Number(id) });
    return wo && wo.orgId === user.orgId ? wo : null;
  }

  async setStatus(wo: WorkOrder, status: WorkOrderStatus) {
    wo.status = status;
    return this.repo.save(wo);
  }

  async remove(wo: WorkOrder) {
    await this.repo.remove(wo);
  }
}
