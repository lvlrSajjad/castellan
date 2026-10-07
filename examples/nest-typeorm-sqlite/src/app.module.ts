import { CastellanRule, createTypeormAdapter } from '@castellan/typeorm';
import { AuthzModule } from '@castellan/nestjs';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { FakeAuthGuard } from './auth.guard.js';
import { Organization, Site, WorkOrder } from './entities/index.js';
import { policies } from './policies.js';
import { SeedService } from './seed.js';
import type { AppUser } from './users.js';
import { WorkOrdersController } from './work-orders.controller.js';
import { WorkOrdersService } from './work-orders.service.js';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Organization, Site, WorkOrder, CastellanRule],
      synchronize: true,
    }),
    TypeOrmModule.forFeature([WorkOrder]),
    AuthzModule.forRootAsync({
      inject: [DataSource],
      useFactory: (ds: DataSource) => ({
        adapter: createTypeormAdapter(ds), // policies and role links live in the castellan_rule table
        policies, // synced into the store at startup
        domainFromRequest: (req: { user: AppUser }) => req.user.orgId,
      }),
    }),
  ],
  controllers: [WorkOrdersController],
  providers: [WorkOrdersService, SeedService, FakeAuthGuard],
})
export class AppModule {}
