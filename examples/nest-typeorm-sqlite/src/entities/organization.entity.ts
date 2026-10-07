import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('organization')
export class Organization {
  @PrimaryColumn({ type: 'varchar' }) id!: string;
  @Column({ type: 'varchar' }) name!: string;
}
