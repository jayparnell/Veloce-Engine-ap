import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Source execution and bundled worker/API entrypoints have different locations.
// Resolve from this module, never from the launcher's current working directory.
let artifactRoot = dirname(fileURLToPath(import.meta.url));
while (!existsSync(join(artifactRoot, "src/pipeline/media_worker.py"))) {
  const parent = dirname(artifactRoot);
  if (parent === artifactRoot) throw new Error("Media runtime files are missing from the application bundle.");
  artifactRoot = parent;
}
export const workspaceRoot = resolve(artifactRoot, "../..");
export const mediaPython = join(workspaceRoot, ".pythonlibs/bin/python3");
export const mediaRenderer = join(artifactRoot, "src/pipeline/media_worker.py");
