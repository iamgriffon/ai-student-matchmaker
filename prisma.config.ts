import "dotenv/config";

import { defineConfig as composer } from "@prisma/composer/config";
import { nodeBuild } from "@prisma/composer/node/control";
import {
  prismaCloud,
  prismaState,
} from "@prisma/composer-prisma-cloud/control";
import { defineConfig as ormConfig } from "@prisma/orm-postgres/config";
import pgvector from "@prisma/orm-extension-pgvector/control";
import { definePrismaConfig } from "prisma/config";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to load the Prisma configuration.");
}

export default definePrismaConfig({
  skills: {
    agents: [],
  },
  orm: ormConfig({
    extensions: [pgvector],
    contract: "./db/contract.ts",
    output: "./db/generated",
    db: {
      connection: databaseUrl,
    },
  }),
  composer: composer({
    extensions: [prismaCloud({ region: "us-east-1" }), nodeBuild()],
    state: prismaState(),
  }),
});
