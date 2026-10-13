#!/usr/bin/env -S bun
import type { Contract as Start } from '../../snapshots/bd3b994218320cfcc0e9d56b35e59b471119f370834ad9e144d5ae5f20a3575a/contract';
import startContract from '../../snapshots/bd3b994218320cfcc0e9d56b35e59b471119f370834ad9e144d5ae5f20a3575a/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/f066f8d9f4a0f7a69ad4874ad1e427192e1830d182c3bb23eec2654c1a7ad741/contract';
import endContract from '../../snapshots/f066f8d9f4a0f7a69ad4874ad1e427192e1830d182c3bb23eec2654c1a7ad741/contract.json' with { type: 'json' };
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
        table: 'PairOutcomes',
        columns: [
          col('completedAt', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('contextVersion', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('encoderVersion', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('feedbackA', 'float8', { codecRef: { codecId: 'pg/float8@1' } }),
          col('feedbackB', 'float8', { codecRef: { codecId: 'pg/float8@1' } }),
          col('id', 'character(36)', {
            notNull: true,
            codecRef: { codecId: 'sql/char@1', typeParams: { length: 36 } },
          }),
          col('modelId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('notes', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('participationA', 'float8', { codecRef: { codecId: 'pg/float8@1' } }),
          col('participationB', 'float8', { codecRef: { codecId: 'pg/float8@1' } }),
          col('policyVersion', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('scoreAfterA', 'float8', { codecRef: { codecId: 'pg/float8@1' } }),
          col('scoreAfterB', 'float8', { codecRef: { codecId: 'pg/float8@1' } }),
          col('scoreBeforeA', 'float8', { notNull: true, codecRef: { codecId: 'pg/float8@1' } }),
          col('scoreBeforeB', 'float8', { notNull: true, codecRef: { codecId: 'pg/float8@1' } }),
          col('startedAt', 'timestamptz', {
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
          checkExpression(
            'complete_observations_e04df2cf',
            '("completedAt" IS NULL AND "scoreAfterA" IS NULL AND "scoreAfterB" IS NULL AND "participationA" IS NULL AND "participationB" IS NULL AND "feedbackA" IS NULL AND "feedbackB" IS NULL) OR ("completedAt" IS NOT NULL AND "scoreAfterA" IS NOT NULL AND "scoreAfterB" IS NOT NULL AND "participationA" IS NOT NULL AND "participationB" IS NOT NULL AND "feedbackA" IS NOT NULL AND "feedbackB" IS NOT NULL)',
          ),
          checkExpression(
            'feedback_ranges_f8fabbc1',
            '("feedbackA" IS NULL OR "feedbackA" BETWEEN 1 AND 5) AND ("feedbackB" IS NULL OR "feedbackB" BETWEEN 1 AND 5)',
          ),
          checkExpression('ordered_members_f8bc5df7', '"userAId" < "userBId"'),
          checkExpression(
            'participation_ranges_62455506',
            '("participationA" IS NULL OR "participationA" BETWEEN 0 AND 1) AND ("participationB" IS NULL OR "participationB" BETWEEN 0 AND 1)',
          ),
          checkExpression(
            'score_ranges_0aab7461',
            '"scoreBeforeA" BETWEEN 0 AND 100 AND "scoreBeforeB" BETWEEN 0 AND 100 AND ("scoreAfterA" IS NULL OR "scoreAfterA" BETWEEN 0 AND 100) AND ("scoreAfterB" IS NULL OR "scoreAfterB" BETWEEN 0 AND 100)',
          ),
        ],
      }),
      this.createIndex({
        schema: 'public',
        table: 'PairOutcomes',
        index: 'PairOutcomes_userAId_idx_96e77d1b',
        columns: ['userAId'],
      }),
      this.createIndex({
        schema: 'public',
        table: 'PairOutcomes',
        index: 'PairOutcomes_userBId_idx_2ac770a6',
        columns: ['userBId'],
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'PairOutcomes',
        foreignKey: {
          name: 'PairOutcomes_userAId_fkey',
          columns: ['userAId'],
          references: { schema: 'public', table: 'Users', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'public',
        table: 'PairOutcomes',
        foreignKey: {
          name: 'PairOutcomes_userBId_fkey',
          columns: ['userBId'],
          references: { schema: 'public', table: 'Users', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
