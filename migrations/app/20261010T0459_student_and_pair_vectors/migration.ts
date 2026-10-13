#!/usr/bin/env -S bun
import type { Contract as Start } from '../../snapshots/95a676f8367371378c2af55b5164c7dd7c97313ca88b121326fca6801d7bdd52/contract';
import startContract from '../../snapshots/95a676f8367371378c2af55b5164c7dd7c97313ca88b121326fca6801d7bdd52/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/ca361d7ffec2107a95c814238530c5fb0110ddfc82df1c66bc7f0cd0e93b7390/contract';
import endContract from '../../snapshots/ca361d7ffec2107a95c814238530c5fb0110ddfc82df1c66bc7f0cd0e93b7390/contract.json' with { type: 'json' };
import {
  Migration,
  MigrationCLI,
  checkExpression,
  col,
  primaryKey,
} from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dropTable({ schema: 'public', table: 'DataVectors' }),
      this.dropNativeEnumType({ schema: 'public', typeName: 'DataVectorType' }),
      this.createTable({
        schema: 'public',
        table: 'PairVectors',
        columns: [
          col('contextVersion', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('id', 'character(36)', {
            notNull: true,
            codecRef: { codecId: 'sql/char@1', typeParams: { length: 36 } },
          }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('userAId', 'character(36)', {
            notNull: true,
            codecRef: { codecId: 'sql/char@1', typeParams: { length: 36 } },
          }),
          col('userBId', 'character(36)', {
            notNull: true,
            codecRef: { codecId: 'sql/char@1', typeParams: { length: 36 } },
          }),
          col('vector', 'vector(4)', {
            notNull: true,
            codecRef: { codecId: 'pg/vector@1', typeParams: { length: 4 } },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression('ordered_members_f8bc5df7', '"userAId" < "userBId"'),
        ],
      }),
      this.createTable({
        schema: 'public',
        table: 'StudentVectors',
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
          col('vector', 'vector(3)', {
            notNull: true,
            codecRef: { codecId: 'pg/vector@1', typeParams: { length: 3 } },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.addUnique({
        schema: 'public',
        table: 'PairVectors',
        constraint: 'PairVectors_userAId_userBId_key',
        columns: ['userAId', 'userBId'],
      }),
      this.addUnique({
        schema: 'public',
        table: 'StudentVectors',
        constraint: 'StudentVectors_userId_key',
        columns: ['userId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'PairVectors',
        index: 'PairVectors_userBId_idx_2ac770a6',
        columns: ['userBId'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'PairVectors',
        foreignKey: {
          name: 'PairVectors_userAId_fkey',
          columns: ['userAId'],
          references: { schema: 'public', table: 'Users', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'PairVectors',
        foreignKey: {
          name: 'PairVectors_userBId_fkey',
          columns: ['userBId'],
          references: { schema: 'public', table: 'Users', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'StudentVectors',
        foreignKey: {
          name: 'StudentVectors_userId_fkey',
          columns: ['userId'],
          references: { schema: 'public', table: 'Users', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
