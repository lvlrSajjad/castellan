import { Column, Entity, PrimaryColumn } from 'typeorm';

export type Region = 'west' | 'east';

@Entity('site')
export class Site {
  @PrimaryColumn({ type: 'integer' }) id!: number;
  @Column({ type: 'varchar' }) orgId!: string;
  @Column({ type: 'varchar' }) name!: string;
  @Column({ type: 'varchar' }) region!: Region;
}
