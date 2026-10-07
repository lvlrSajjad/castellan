import 'reflect-metadata';
import { type Ability, definePolicies } from '@castellanjs/core';
import { CastellanRule, createTypeormAdapter, scopeQuery } from '@castellanjs/typeorm';
import {
  type CanActivate,
  Controller,
  Delete,
  type ExecutionContext,
  Get,
  type INestApplication,
  Injectable,
  Module,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import request from 'supertest';
import { Column, DataSource, Entity, PrimaryColumn, Repository } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthzGuard, AuthzModule, AuthzService, CheckAbility, CurrentAbility } from '../src/index.js';

@Entity('ticket')
class Ticket {
  @PrimaryColumn({ type: 'integer' }) id!: number;
  @Column({ type: 'varchar' }) orgId!: string;
  @Column({ type: 'varchar' }) ownerId!: string;
  @Column({ type: 'varchar' }) status!: string;
}

interface User {
  id: string;
  orgId: string;
}

const policies = definePolicies<User>(({ everyone, role, user }) => {
  everyone.can('read', Ticket, { orgId: user.orgId });
  everyone.can('update', Ticket, { ownerId: user.id });
  everyone.cannot('update', Ticket, { status: 'locked' }).because('Locked tickets cannot be edited');
  role('admin').can('delete', Ticket);
});

/** Fake authentication: `x-user: id@org` header. */
@Injectable()
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const header = req.headers['x-user'] as string | undefined;
    if (header) {
      const [id, orgId] = header.split('@');
      req.user = { id, orgId };
    }
    return true;
  }
}

@Injectable()
class TicketService {
  constructor(
    @InjectRepository(Ticket) readonly repo: Repository<Ticket>,
    readonly authz: AuthzService<User>,
  ) {}

  findOne(id: string) {
    return this.repo.findOneBy({ id: Number(id) });
  }

  findAccessible(ability: Ability) {
    return scopeQuery(this.repo.createQueryBuilder('t'), ability, 'read', Ticket).orderBy('t.id').getMany();
  }
}

const loadTicket = (req: { params: { id: string } }, refs: ModuleRef) =>
  refs.get(TicketService, { strict: false }).findOne(req.params.id);

@Controller('tickets')
@UseGuards(FakeAuthGuard, AuthzGuard)
class TicketController {
  constructor(private readonly tickets: TicketService) {}

  @Get()
  @CheckAbility('read', Ticket)
  list(@CurrentAbility() ability: Ability) {
    return this.tickets.findAccessible(ability);
  }

  @Get(':id')
  @CheckAbility('read', Ticket, { load: loadTicket })
  get(@Param('id') id: string) {
    return this.tickets.findOne(id);
  }

  @Patch(':id')
  @CheckAbility('update', Ticket, { load: loadTicket })
  update() {
    return { ok: true };
  }

  @Delete(':id')
  @CheckAbility('delete', Ticket)
  remove() {
    return { ok: true };
  }
}

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Ticket, CastellanRule],
      synchronize: true,
    }),
    TypeOrmModule.forFeature([Ticket]),
    AuthzModule.forRootAsync({
      inject: [DataSource],
      useFactory: (ds: DataSource) => ({
        adapter: createTypeormAdapter(ds),
        policies,
        logger: false,
        domainFromRequest: (req: { user: User }) => req.user.orgId,
      }),
    }),
  ],
  controllers: [TicketController],
  providers: [TicketService, FakeAuthGuard],
})
class AppModule {}

let app: INestApplication;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
  await moduleRef.get(DataSource).getRepository(Ticket).save([
    { id: 1, orgId: 'acme', ownerId: 'alice', status: 'open' },
    { id: 2, orgId: 'acme', ownerId: 'bob', status: 'open' },
    { id: 3, orgId: 'acme', ownerId: 'alice', status: 'locked' },
    { id: 4, orgId: 'globex', ownerId: 'carol', status: 'open' },
  ]);
  await moduleRef.get(AuthzService).assignRole('root', 'admin', 'acme');
});

afterAll(async () => {
  await app?.close();
});

describe('AuthzGuard + @CheckAbility', () => {
  it('rejects anonymous requests with 401', async () => {
    await request(app.getHttpServer()).get('/tickets/1').expect(401);
  });

  it('scopes list queries to accessible rows', async () => {
    const res = await request(app.getHttpServer()).get('/tickets').set('x-user', 'alice@acme').expect(200);
    expect(res.body.map((t: Ticket) => t.id)).toEqual([1, 2, 3]);
  });

  it('checks loaded instances against conditions', async () => {
    await request(app.getHttpServer()).get('/tickets/1').set('x-user', 'alice@acme').expect(200);
    await request(app.getHttpServer()).get('/tickets/4').set('x-user', 'alice@acme').expect(403);
    await request(app.getHttpServer()).patch('/tickets/1').set('x-user', 'alice@acme').expect(200);
    await request(app.getHttpServer()).patch('/tickets/2').set('x-user', 'alice@acme').expect(403);
  });

  it('returns the deny reason in the 403 body', async () => {
    const res = await request(app.getHttpServer()).patch('/tickets/3').set('x-user', 'alice@acme').expect(403);
    expect(res.body).toMatchObject({ message: 'Locked tickets cannot be edited', action: 'update', subject: 'Ticket' });
  });

  it('returns 404 when the loader finds nothing', async () => {
    await request(app.getHttpServer()).patch('/tickets/99').set('x-user', 'alice@acme').expect(404);
  });

  it('applies domain-scoped roles', async () => {
    await request(app.getHttpServer()).delete('/tickets/1').set('x-user', 'root@acme').expect(200);
    await request(app.getHttpServer()).delete('/tickets/4').set('x-user', 'root@globex').expect(403);
    await request(app.getHttpServer()).delete('/tickets/1').set('x-user', 'alice@acme').expect(403);
  });
});

describe('AuthzService', () => {
  it('asserts through the enforcer and maps to a 403 exception', async () => {
    const service = app.get(AuthzService);
    const locked = Object.assign(new Ticket(), { id: 3, orgId: 'acme', ownerId: 'alice', status: 'locked' });
    await expect(service.assert({ id: 'alice', orgId: 'acme' }, 'update', locked, { domain: 'acme' })).rejects.toMatchObject({
      status: 403,
      details: { reason: 'Locked tickets cannot be edited' },
    });
  });
});
