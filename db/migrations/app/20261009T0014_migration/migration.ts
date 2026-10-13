#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/394938f3e96434ffbdf0cb19a82fc5e8ff7c6c40747c7a7b1cf9af2aa9343a21/contract';
import endContract from '../../snapshots/394938f3e96434ffbdf0cb19a82fc5e8ff7c6c40747c7a7b1cf9af2aa9343a21/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/9bd2482206b5594702311387d5f804f3793e1e68c4f74754187de0765ea273c6/contract';
import startContract from '../../snapshots/9bd2482206b5594702311387d5f804f3793e1e68c4f74754187de0765ea273c6/contract.json' with { type: 'json' };
import { Migration, MigrationCLI, placeholder } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.dataTransform(endContract, 'typechange-Users-age', {
        check: () => placeholder('typechange-Users-age:check'),
        run: () => placeholder('typechange-Users-age:run'),
      }),
      this.alterColumnType({
        schema: 'public',
        table: 'Users',
        column: 'age',
        options: {
          qualifiedTargetType: 'float8',
          formatTypeExpected: 'double precision',
          rawTargetTypeForLabel: 'float8',
        },
      }),
      this.dataTransform(endContract, 'typechange-Users-score', {
        check: () => placeholder('typechange-Users-score:check'),
        run: () => placeholder('typechange-Users-score:run'),
      }),
      this.alterColumnType({
        schema: 'public',
        table: 'Users',
        column: 'score',
        options: {
          qualifiedTargetType: 'float8',
          formatTypeExpected: 'double precision',
          rawTargetTypeForLabel: 'float8',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
