#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/2c53f8e505613541dda0de4ebeaf62bc480cecfea6e37dc5f34ceb44bb7f0d65/contract';
import startContract from '../../snapshots/2c53f8e505613541dda0de4ebeaf62bc480cecfea6e37dc5f34ceb44bb7f0d65/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/9bd2482206b5594702311387d5f804f3793e1e68c4f74754187de0765ea273c6/contract';
import endContract from '../../snapshots/9bd2482206b5594702311387d5f804f3793e1e68c4f74754187de0765ea273c6/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, primaryKey } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropTable({ schema: 'public', table: 'Post' }),
      this.dropTable({ schema: 'public', table: 'User' }),
      this.createTable({
        schema: 'public',
        table: 'DataVectors',
        columns: [
          col('createdAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('discount', 'int8', { notNull: true, codecRef: { codecId: 'pg/int8@1' } }),
          col('id', 'character(36)', {
            notNull: true,
            codecRef: { codecId: 'sql/char@1', typeParams: { length: 36 } },
          }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('userId', 'character(36)', {
            notNull: true,
            codecRef: { codecId: 'sql/char@1', typeParams: { length: 36 } },
          }),
          col('vector', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'public',
        table: 'Users',
        columns: [
          col('age', 'int8', { notNull: true, codecRef: { codecId: 'pg/int8@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('disability', 'bool', { notNull: true, codecRef: { codecId: 'pg/bool@1' } }),
          col('discount', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('email', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'character(36)', {
            notNull: true,
            codecRef: { codecId: 'sql/char@1', typeParams: { length: 36 } },
          }),
          col('income', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('name', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('score', 'int8', { notNull: true, codecRef: { codecId: 'pg/int8@1' } }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.addUnique({
        schema: 'public',
        table: 'Users',
        constraint: 'Users_email_key',
        columns: ['email'],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
