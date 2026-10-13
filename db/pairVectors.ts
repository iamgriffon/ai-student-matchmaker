import { parseId, type UserId } from "../src/utils/idParser.ts";
import { connectDatabase, db } from "./db.ts";
import { or } from "@prisma/orm-postgres/orm-client";

const PAIR_FEATURE_COUNT = 4;
const MIN_FEATURE_VALUE = 0;
const MAX_FEATURE_VALUE = 1;
const MIN_QUERY_LIMIT = 1;
const MAX_QUERY_LIMIT = 100;
export const PAIR_VECTORS_CACHE_TTL_MS = 3_600_000;

type PairRows = Awaited<ReturnType<typeof db.orm.public.PairVectors.all>>;
type PairLookup = Awaited<ReturnType<typeof db.orm.public.PairVectors.first>>;
type Cache<Value> = { value: Value; expiresAt: number };

export const caches = {
  lists: new Map<string, Cache<PairRows>>(),
  byId: new Map<string, Cache<PairLookup>>(),
  byUsers: new Map<string, Cache<PairLookup>>(),
  byStudent: new Map<string, Cache<PairRows>>(),
  byContext: new Map<string, Cache<PairRows>>(),
};

let cacheRevision = 0;

export function invalidatePairVectorCaches(): void {
  caches.lists.clear();
  caches.byId.clear();
  caches.byUsers.clear();
  caches.byStudent.clear();
  caches.byContext.clear();
  cacheRevision += 1;
}

async function readCached<Value>(
  cache: Map<string, Cache<Value>>,
  key: string,
  load: () => Promise<Value>,
): Promise<Value> {
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    // Uma alteração no resultado pelo chamador não deve modificar o cache.
    return structuredClone(cached.value);
  }
  cache.delete(key);

  const revision = cacheRevision;
  const value = await load();
  // Uma escrita pode invalidar o cache enquanto a consulta está em andamento.
  if (revision === cacheRevision) {
    cache.set(key, {
      value: structuredClone(value),
      expiresAt: Date.now() + PAIR_VECTORS_CACHE_TTL_MS,
    });
  }
  return structuredClone(value);
}

export type PairVectorInput = {
  userAId: string;
  userBId: string;
  vector: readonly number[];
};

function normalizeMembers(firstId: string, secondId: string): {
  userAId: UserId;
  userBId: UserId;
} {
  const first = parseId(firstId);
  const second = parseId(secondId);
  if (first === second) throw new Error("Uma dupla precisa de dois alunos diferentes");

  // A+B e B+A usam a mesma combinação única no banco.
  return first < second
    ? { userAId: first, userBId: second }
    : { userAId: second, userBId: first };
}

function parseContextVersion(value: string): string {
  const version = value.trim();
  if (!version) throw new Error("A versão do contexto é obrigatória");
  return version;
}

function validateLimit(limit?: number): void {
  if (typeof limit == 'undefined') return;
  if (!Number.isInteger(limit) || limit < MIN_QUERY_LIMIT || limit > MAX_QUERY_LIMIT) {
    throw new Error(`O limite deve ser um inteiro entre ${MIN_QUERY_LIMIT} e ${MAX_QUERY_LIMIT}`);
  }
}

export async function getPairVectors(limit?: number) {
  validateLimit(limit);
  const key = typeof limit == 'undefined' ? "all" : String(limit);
  return await readCached(caches.lists, key, async () => {
    await connectDatabase();
    const query = db.orm.public.PairVectors;
    return typeof limit == 'undefined' ? await query.all() : await query.limit(limit).all();
  });
}

export async function getPairVectorsById(id: string) {
  const parsedId = parseId(id);
  return await readCached(caches.byId, parsedId, async () => {
    await connectDatabase();
    return await db.orm.public.PairVectors.where((v) => v.id.eq(parsedId)).first();
  });
}

export async function getPairVectorByUsers(
  firstUserId: string,
  secondUserId: string,
  contextVersion: string,
) {
  const { userAId, userBId } = normalizeMembers(firstUserId, secondUserId);
  const version = parseContextVersion(contextVersion);
  const key = JSON.stringify([userAId, userBId, version]);
  return await readCached(caches.byUsers, key, async () => {
    await connectDatabase();
    // Só reutilizamos o vetor se ele pertencer ao contexto solicitado.
    return await db.orm.public.PairVectors
      .where((v) => v.userAId.eq(userAId))
      .where((v) => v.userBId.eq(userBId))
      .where((v) => v.contextVersion.eq(version))
      .first();
  });
}

export async function getPairVectorsForUser(userId: string, contextVersion: string) {
  const id = parseId(userId);
  const version = parseContextVersion(contextVersion);
  const key = JSON.stringify([id, version]);
  return await readCached(caches.byStudent, key, async () => {
    await connectDatabase();
    return await db.orm.public.PairVectors
      .where((v) => v.contextVersion.eq(version))
      .where((v) => or(v.userAId.eq(id), v.userBId.eq(id)))
      .all();
  });
}

export async function getPairVectorsForContext(contextVersion: string) {
  const version = parseContextVersion(contextVersion);
  return await readCached(caches.byContext, version, async () => {
    await connectDatabase();
    return await db.orm.public.PairVectors.where((v) => v.contextVersion.eq(version)).all();
  });
}

export async function savePairVectors(
  pairs: readonly PairVectorInput[],
  contextVersion: string,
): Promise<void> {
  const version = parseContextVersion(contextVersion);
  const preparedPairs = pairs.map((pair) => {
    const members = normalizeMembers(pair.userAId, pair.userBId);
    const vector = Array.from(pair.vector);
    if (
      vector.length !== PAIR_FEATURE_COUNT ||
      !vector.every((value) =>
        Number.isFinite(value) && value >= MIN_FEATURE_VALUE && value <= MAX_FEATURE_VALUE,
      )
    ) {
      throw new Error(`O vetor da dupla deve ter ${PAIR_FEATURE_COUNT} valores finitos entre ${MIN_FEATURE_VALUE} e ${MAX_FEATURE_VALUE}`);
    }
    return { ...members, vector };
  });

  // Validamos o lote inteiro antes de escrever; um lote vazio não abre conexão.
  if (!preparedPairs.length) return;
  await connectDatabase();
  await db.transaction(async (tx) => {
    for (const { userAId, userBId, vector } of preparedPairs) {
      await tx.orm.public.PairVectors.upsert({
        create: { userAId, userBId, vector, contextVersion: version },
        update: { vector, contextVersion: version },
        conflictOn: { userAId, userBId },
      });
    }
  });
  invalidatePairVectorCaches();
}
