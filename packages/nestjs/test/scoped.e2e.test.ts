import 'reflect-metadata';
import { type GrantSnapshot, createScopeTree, definePolicies, defineSubjects } from '@castellanjs/core';
import { applyScope } from '@castellanjs/typeorm';
import {
  type CanActivate,
  Controller,
  type ExecutionContext,
  Get,
  type INestApplication,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import request from 'supertest';
import { Column, DataSource, Entity, PrimaryColumn, Repository } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthzGuard, AuthzModule, AuthzService, CheckAbility, RequirePermission } from '../src/index.js';

@Entity('scoped_asset')
class Asset {
  @PrimaryColumn({ type: 'integer' }) id!: number;
  @Column({ type: 'integer' }) orgId!: number;
  @Column({ type: 'integer' }) siteId!: number;
}

interface User {
  id: string;
}

const policies = definePolicies<User>(({ role }) => {
  role('asset.read').can('read', Asset);
  role('asset.update').can('update', Asset);
  role('org.admin', ({ inherits }) => inherits('asset.read', 'asset.update'));
});

const subjects = defineSubjects({ Asset: { tenant: 'orgId', leaf: 'siteId' } });

//  org:1 ── group:a ── site:11, site:12
//        └─ group:b ── site:13
//  org:2 ── site:21
const tree = createScopeTree([
  { key: 'org:1' },
  { key: 'group:a', parent: 'org:1' },
  { key: 'group:b', parent: 'org:1' },
  { key: 'site:11', parent: 'group:a', leaf: 11 },
  { key: 'site:12', parent: 'group:a', leaf: 12 },
  { key: 'site:13', parent: 'group:b', leaf: 13 },
  { key: 'org:2' },
  { key: 'site:21', parent: 'org:2', leaf: 21 },
]);

/** What an app's own access-context builder would produce, per user. */
const snapshots: Record<string, GrantSnapshot> = {
  admin: { tree, assignments: [{ role: 'org.admin', scope: 'org:1' }] },
  reader: { tree, assignments: [{ role: 'asset.read', scope: 'org:1' }] },
  group: { tree, assignments: [{ role: 'org.admin', scope: 'group:a' }] },
  elsewhere: { tree, assignments: [{ role: 'org.admin', scope: 'org:2' }] },
};

/** Fake authentication: `x-user: <id>` header. */
@Injectable()
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const id = req.headers['x-user'] as string | undefined;
    if (id) req.user = { id };
    return true;
  }
}

@Injectable()
class AssetService {
  constructor(
    @InjectRepository(Asset) readonly repo: Repository<Asset>,
    readonly authz: AuthzService<User>,
  ) {}

  findOne(id: string) {
    return this.repo.findOneBy({ id: Number(id) });
  }

  /** The repository-base pattern: resolve, refuse `none`, apply. */
  async list(req: unknown) {
    const scope = await this.authz.scopeFor(req, 'read', Asset);
    if (scope.kind === 'none') throw new NotFoundException();
    return applyScope(this.repo.createQueryBuilder('a'), scope, { relations: false }).orderBy('a.id').getMany();
  }
}

const loadAsset = (req: { params: { id: string } }, refs: ModuleRef) =>
  refs.get(AssetService, { strict: false }).findOne(req.params.id);

@Controller('orgs/:orgId/assets')
@UseGuards(FakeAuthGuard, AuthzGuard)
class AssetController {
  constructor(private readonly assets: AssetService) {}

  @Get()
  @RequirePermission('asset.read', 'asset.update')
  list(@Req() req: unknown) {
    return this.assets.list(req);
  }

  @Get(':id')
  @CheckAbility('read', Asset, { load: loadAsset })
  get(@Param('id') id: string) {
    return this.assets.findOne(id);
  }

  @Patch(':id')
  @RequirePermission('asset.update')
  @CheckAbility('update', Asset, { load: loadAsset })
  update() {
    return { ok: true };
  }
}

@Module({
  imports: [
    TypeOrmModule.forRoot({ type: 'better-sqlite3', database: ':memory:', entities: [Asset], synchronize: true }),
    TypeOrmModule.forFeature([Asset]),
    AuthzModule.forRoot<User>({
      grants: 'snapshot',
      policies,
      subjects,
      logger: false,
      domainFromRequest: (req: { params: { orgId: string } }) => `org:${req.params.orgId}`,
      snapshotFromRequest: (_req, user) => snapshots[user.id] ?? { tree, assignments: [] },
      onNoDomainAccess: 'not-found',
      onDeniedInstance: 'not-found',
    }),
  ],
  controllers: [AssetController],
  providers: [AssetService, FakeAuthGuard],
})
class AppModule {}

let app: INestApplication;
const http = () => request(app.getHttpServer());

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
  await moduleRef.get(DataSource).getRepository(Asset).save([
    { id: 1, orgId: 1, siteId: 11 },
    { id: 2, orgId: 1, siteId: 12 },
    { id: 3, orgId: 1, siteId: 13 },
    { id: 4, orgId: 2, siteId: 21 },
  ]);
});

afterAll(async () => {
  await app?.close();
});

describe('external grants mode in NestJS', () => {
  it('answers 401 without a user', async () => {
    await http().get('/orgs/1/assets').expect(401);
  });

  it('answers 404 when nothing reaches the domain', async () => {
    await http().get('/orgs/1/assets').set('x-user', 'elsewhere').expect(404);
    await http().get('/orgs/1/assets').set('x-user', 'stranger').expect(404);
    await http().get('/orgs/2/assets').set('x-user', 'elsewhere').expect(200);
  });

  it('scopes lists to the tenant and to sub-tenant assignments', async () => {
    const admin = await http().get('/orgs/1/assets').set('x-user', 'admin').expect(200);
    expect(admin.body.map((a: Asset) => a.id)).toEqual([1, 2, 3]);
    const group = await http().get('/orgs/1/assets').set('x-user', 'group').expect(200);
    expect(group.body.map((a: Asset) => a.id)).toEqual([1, 2]);
  });

  it('@RequirePermission answers 403 with the missing keys', async () => {
    const res = await http().patch('/orgs/1/assets/1').set('x-user', 'reader').expect(403);
    expect(res.body).toMatchObject({ message: 'Missing permission: asset.update', permissions: ['asset.update'] });
    await http().patch('/orgs/1/assets/1').set('x-user', 'admin').expect(200);
  });

  it('answers 404 for instances outside the scope or the tenant', async () => {
    await http().get('/orgs/1/assets/1').set('x-user', 'group').expect(200);
    await http().get('/orgs/1/assets/3').set('x-user', 'group').expect(404);
    await http().patch('/orgs/1/assets/4').set('x-user', 'admin').expect(404); // a row of org 2
    await http().get('/orgs/1/assets/99').set('x-user', 'admin').expect(404);
  });
});
