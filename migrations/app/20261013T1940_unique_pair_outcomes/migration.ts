#!/usr/bin/env -S bun
import type { Contract as End } from '../../snapshots/0e407dbfaeade8f331b60af20ad584ede0cbc909853dad6a23827c9f4b2958d9/contract';
import endContract from '../../snapshots/0e407dbfaeade8f331b60af20ad584ede0cbc909853dad6a23827c9f4b2958d9/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/9e1af0b0c7830044146d9479a721e77f5bdb625eda01e2c2a4dff8180ee7dcb7/contract';
import startContract from '../../snapshots/9e1af0b0c7830044146d9479a721e77f5bdb625eda01e2c2a4dff8180ee7dcb7/contract.json' with { type: 'json' };
import { Migration, MigrationCLI } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.addUnique({
        schema: 'public',
        table: 'PairOutcomes',
        constraint: 'PairOutcomes_userAId_userBId_key',
        columns: ['userAId', 'userBId'],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
