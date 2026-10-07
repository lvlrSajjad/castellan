import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { Site } from './site.entity.js';

export type WorkOrderStatus = 'open' | 'closed' | 'invoiced';

@Entity('work_order')
export class WorkOrder {
  @PrimaryColumn({ type: 'integer' }) id!: number;
  @Column({ type: 'varchar' }) orgId!: string;
  @Column({ type: 'integer' }) siteId!: number;
  @ManyToOne(() => Site, { nullable: false })
  @JoinColumn({ name: 'siteId' })
  site?: Site;
  @Column({ type: 'varchar', nullable: true }) assigneeId!: string | null;
  @Column({ type: 'varchar' }) status!: WorkOrderStatus;
  @Column({ type: 'integer' }) priority!: number;
  @Column({ type: 'varchar' }) title!: string;
}
