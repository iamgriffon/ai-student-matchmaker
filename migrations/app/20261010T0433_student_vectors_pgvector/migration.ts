#!/usr/bin/env -S bun
import type { Contract as End } from '../../snapshots/a57ffd221b5c7e7cc3c24c231e764b2e1f051025ea9da36c272fdacd6a7e15a5/contract';
import endContract from '../../snapshots/a57ffd221b5c7e7cc3c24c231e764b2e1f051025ea9da36c272fdacd6a7e15a5/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/fa0a075d4e772a5df13b995a8cc4c541bd5092d9b6ea7a4872aac6e606ebe5fd/contract';
import startContract from '../../snapshots/fa0a075d4e772a5df13b995a8cc4c541bd5092d9b6ea7a4872aac6e606ebe5fd/contract.json' with { type: 'json' };
import { Migration, MigrationCLI } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.alterColumnType({
        schema: 'public',
        table: 'DataVectors',
        column: 'vector',
        options: {
          qualifiedTargetType: 'vector(3)',
          formatTypeExpected: 'vector(3)',
          rawTargetTypeForLabel: 'vector(3)',
          using: '"vector"::vector(3)',
        },
      }),
      this.addUnique({
        schema: 'public',
        table: 'DataVectors',
        constraint: 'DataVectors_userId_key',
        columns: ['userId'],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
