import 'reflect-metadata';
import { Column, Entity, ManyToOne, PrimaryColumn } from 'typeorm';

/** Set CASTELLAN_PG_URL to run the suite against Postgres instead of in-memory SQLite. */
export const PG_URL = process.env.CASTELLAN_PG_URL;

@Entity('site')
export class Site {
  @PrimaryColumn({ type: 'integer' })
  id!: number;

  @Column({ type: 'varchar' })
  region!: string;
}

@Entity('work_order')
export class WorkOrder {
  @PrimaryColumn({ type: 'integer' })
  id!: number;

  @Column({ type: 'integer', name: 'site_id' })
  siteId!: number;

  @ManyToOne(() => Site, { nullable: true })
  site?: Site | null;

  @Column({ type: 'varchar', nullable: true, name: 'assignee_id' })
  assigneeId!: string | null;

  @Column({ type: 'varchar' })
  status!: string;

  @Column({ type: 'integer' })
  priority!: number;

  @Column({ type: 'boolean', default: false })
  urgent!: boolean;

  @Column({ type: PG_URL ? 'timestamptz' : 'datetime', nullable: true, name: 'due_at' })
  dueAt!: Date | null;
}
