export const STUDENT_VECTORS_CACHE_TTL_MS = 3_600_000;

type SearchRows = { userId: string; distance: number }[];
type Cache = { value: SearchRows; expiresAt: number };

export const caches = { nearest: new Map<string, Cache>() };
let cacheRevision = 0;

export function invalidateStudentVectorCaches(): void {
  caches.nearest.clear();
  cacheRevision += 1;
}

export async function readCachedStudentVectors(
  key: string,
  load: () => Promise<SearchRows>,
): Promise<SearchRows> {
  const cached = caches.nearest.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return structuredClone(cached.value);
  }
  caches.nearest.delete(key);

  const revision = cacheRevision;
  const value = await load();
  // Uma atualização concorrente impede que uma consulta anterior recoloque
  // resultados desatualizados no cache após a invalidação.
  if (revision === cacheRevision) {
    caches.nearest.set(key, {
      value: structuredClone(value),
      expiresAt: Date.now() + STUDENT_VECTORS_CACHE_TTL_MS,
    });
  }
  return structuredClone(value);
}
