#!/usr/bin/env -S bun
import type { Contract as End } from '../../snapshots/95a676f8367371378c2af55b5164c7dd7c97313ca88b121326fca6801d7bdd52/contract';
import endContract from '../../snapshots/95a676f8367371378c2af55b5164c7dd7c97313ca88b121326fca6801d7bdd52/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/a57ffd221b5c7e7cc3c24c231e764b2e1f051025ea9da36c272fdacd6a7e15a5/contract';
import startContract from '../../snapshots/a57ffd221b5c7e7cc3c24c231e764b2e1f051025ea9da36c272fdacd6a7e15a5/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, col, lit } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createNativeEnumType({
        schema: 'public',
        typeName: 'DataVectorType',
        members: ['individual', 'pair', 'cohort'],
      }),
      this.addColumn({
        schema: 'public',
        table: 'DataVectors',
        column: col('type', '"DataVectorType"', {
          notNull: true,
          default: lit('individual'),
          codecRef: { codecId: 'pg/enum@1', typeParams: { typeName: 'DataVectorType' } },
        }),
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
