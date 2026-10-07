import { type Ability } from '@castellan/core';
import { AuthzGuard, CheckAbility, CurrentAbility } from '@castellan/nestjs';
import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Req, UseGuards } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { FakeAuthGuard } from './auth.guard.js';
import { WorkOrder, type WorkOrderStatus } from './entities/index.js';
import type { AppUser } from './users.js';
import { WorkOrdersService } from './work-orders.service.js';

/** Loader used by `@CheckAbility`: the guard checks rule conditions against this instance (null -> 404). */
const loadWorkOrder = (req: { params: { id: string }; user: AppUser }, refs: ModuleRef) =>
  refs.get(WorkOrdersService, { strict: false }).findForUser(req.user, req.params.id);

const STATUSES: WorkOrderStatus[] = ['open', 'closed', 'invoiced'];

@Controller()
@UseGuards(FakeAuthGuard, AuthzGuard)
export class WorkOrdersController {
  constructor(private readonly workOrders: WorkOrdersService) {}

  /** The current user's compiled rules, e.g. to feed a frontend ability (CASL-style). */
  @Get('me/permissions')
  permissions(@CurrentAbility() ability: Ability) {
    return ability.rules;
  }

  @Get('work-orders')
  @CheckAbility('read', WorkOrder)
  list(@Req() req: { user: AppUser }, @CurrentAbility() ability: Ability) {
    return this.workOrders.findAccessible(req.user, ability);
  }

  @Get('work-orders/:id')
  @CheckAbility('read', WorkOrder, { load: loadWorkOrder })
  get(@Req() req: { user: AppUser }, @Param('id') id: string) {
    return this.workOrders.findForUser(req.user, id);
  }

  @Patch('work-orders/:id/status')
  @CheckAbility('update', WorkOrder, { load: loadWorkOrder })
  async updateStatus(@Req() req: { user: AppUser }, @Param('id') id: string, @Body() body: { status?: WorkOrderStatus }) {
    if (!body?.status || !STATUSES.includes(body.status)) {
      throw new BadRequestException(`status must be one of ${STATUSES.join(', ')}`);
    }
    const wo = await this.workOrders.findForUser(req.user, id);
    return this.workOrders.setStatus(wo!, body.status);
  }

  @Delete('work-orders/:id')
  @CheckAbility('delete', WorkOrder, { load: loadWorkOrder })
  async remove(@Req() req: { user: AppUser }, @Param('id') id: string) {
    await this.workOrders.remove((await this.workOrders.findForUser(req.user, id))!);
    return { deleted: Number(id) };
  }
}
