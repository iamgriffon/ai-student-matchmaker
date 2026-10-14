export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
export function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
export async function modelHash(topology: unknown, weights: Uint8Array) {
  const topologyBytes = new TextEncoder().encode(JSON.stringify(topology));
  const bytes = new Uint8Array(topologyBytes.length + weights.length);
  bytes.set(topologyBytes);
  bytes.set(weights, topologyBytes.length);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
