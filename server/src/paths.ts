import { fileURLToPath } from "node:url";
import path from "node:path";

// Leaf module: imports nothing from the rest of the app.
// `server/src/index.ts` (and downstream) imports FROM here. Do not add app-level
// imports — keep this file safe to require from anywhere without creating cycles.
export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REFERENCE_DOCS_ROOT = path.join(APP_ROOT, "docs/reference");
