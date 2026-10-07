import 'reflect-metadata';
import { Column, Entity, ManyToOne, PrimaryColumn } from 'typeorm';
import { DATE_TYPE } from './db.js';

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

  @Column({ type: DATE_TYPE, nullable: true, name: 'due_at' })
  dueAt!: Date | null;
}
