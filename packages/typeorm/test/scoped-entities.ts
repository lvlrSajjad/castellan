import 'reflect-metadata';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { DB } from './db.js';

// Class names match the subject types in core's scoped fixtures (Site, WorkOrder, Reading).

@Entity('scoped_site')
export class Site {
  @PrimaryColumn({ type: 'integer' }) id!: number;
  @Index() @Column({ type: 'integer', name: 'org_id' }) orgId!: number;
}

@Entity('scoped_work_order')
export class WorkOrder {
  @PrimaryColumn({ type: 'integer' }) id!: number;
  @Index() @Column({ type: 'integer', name: 'org_id', nullable: true }) orgId!: number | null;
  /** Signed. */
  @Index() @Column({ type: 'integer', name: 'site_id', nullable: true }) siteId!: number | null;
  @Column({ type: 'varchar', length: 32 }) status!: string;
  @Column({ type: 'varchar', length: 64, name: 'assignee_id', nullable: true }) assigneeId!: string | null;
}

@Entity('scoped_reading')
export class Reading {
  @PrimaryColumn({ type: 'integer' }) id!: number;
  /** Unsigned on MySQL; no tenant column. */
  @Index()
  @Column({ type: 'integer', name: 'site_id', nullable: true, ...(DB === 'mysql' ? { unsigned: true } : {}) })
  siteId!: number | null;
}

/** Linked to the tenant through `snapshot.lists.members`; no leaf column. */
@Entity('scoped_member')
export class Member {
  @PrimaryColumn({ type: 'integer' }) id!: number;
  @Index() @Column({ type: 'varchar', length: 64, name: 'user_id', nullable: true }) userId!: string | null;
}
