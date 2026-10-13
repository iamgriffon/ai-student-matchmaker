#!/usr/bin/env -S bun
import type { Contract as End } from '../../snapshots/bd3b994218320cfcc0e9d56b35e59b471119f370834ad9e144d5ae5f20a3575a/contract';
import endContract from '../../snapshots/bd3b994218320cfcc0e9d56b35e59b471119f370834ad9e144d5ae5f20a3575a/contract.json' with { type: 'json' };
import type { Contract as Start } from '../../snapshots/ca361d7ffec2107a95c814238530c5fb0110ddfc82df1c66bc7f0cd0e93b7390/contract';
import startContract from '../../snapshots/ca361d7ffec2107a95c814238530c5fb0110ddfc82df1c66bc7f0cd0e93b7390/contract.json' with { type: 'json' };
import { Migration, MigrationCLI } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [this.dropColumn({ schema: 'public', table: 'StudentVectors', column: 'discount' })];
  }
}

MigrationCLI.run(import.meta.url, M);
