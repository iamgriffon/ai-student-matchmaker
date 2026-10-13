#!/usr/bin/env -S bun
import type { Contract as End } from '../../snapshots/9e1af0b0c7830044146d9479a721e77f5bdb625eda01e2c2a4dff8180ee7dcb7/contract';
import endContract from '../../snapshots/9e1af0b0c7830044146d9479a721e77f5bdb625eda01e2c2a4dff8180ee7dcb7/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/f066f8d9f4a0f7a69ad4874ad1e427192e1830d182c3bb23eec2654c1a7ad741/contract';
import startContract from '../../snapshots/f066f8d9f4a0f7a69ad4874ad1e427192e1830d182c3bb23eec2654c1a7ad741/contract.json' with { type: 'json' };
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
      this.createTable({
        schema: 'public',
        table: 'TrainedModels',
        columns: [
          col('activeKey', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('artifact', 'jsonb', { notNull: true, codecRef: { codecId: 'pg/jsonb@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
          col('id', 'character(36)', {
            notNull: true,
            codecRef: { codecId: 'sql/char@1', typeParams: { length: 36 } },
          }),
          col('kind', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('modelId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('trainingReport', 'jsonb', { codecRef: { codecId: 'pg/jsonb@1' } }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-string@1' },
          }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression('active_kind_13263b1f', '"activeKey" IS NULL OR "activeKey" = "kind"'),
          checkExpression(
            'artifact_identity_4b8c96e6',
            `jsonb_typeof("artifact") = 'object' AND ("artifact" #>> '{metadata,modelId}') IS NOT NULL AND "modelId" = "artifact" #>> '{metadata,modelId}'`,
          ),
          checkExpression(
            'report_object_53868cbb',
            `"trainingReport" IS NULL OR jsonb_typeof("trainingReport") = 'object'`,
          ),
        ],
      }),
      this.addUnique({
        schema: 'public',
        table: 'TrainedModels',
        constraint: 'TrainedModels_activeKey_key',
        columns: ['activeKey'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'TrainedModels',
        index: 'TrainedModels_modelId_idx_a8222b0e',
        columns: ['modelId'],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
