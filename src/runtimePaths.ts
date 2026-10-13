import { extname } from "node:path";
import { fileURLToPath } from "node:url";

// O build reúne servidor e worker em dist/; no desenvolvimento os módulos ficam em src/.
const isProductionArtifact = extname(fileURLToPath(import.meta.url)) === ".mjs";
export const PUBLIC_DIRECTORY = new URL(isProductionArtifact ? "./public/" : "../public/", import.meta.url);
export const TRAINING_ENTRYPOINT = new URL(isProductionArtifact ? "./trainMatchmaking.mjs" : "../scripts/trainMatchmaking.ts", import.meta.url);
export const APPLICATION_WORKING_DIRECTORY = new URL("../", import.meta.url);
