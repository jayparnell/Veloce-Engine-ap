import type { StorageObject, StorageRetention } from "@workspace/api-zod";

export type InventoryObject = {
  objectPath: string; owner: string; private: boolean; contentType: string;
  purpose: string; bytes: number; createdAt: string; generation: string; metageneration: string;
};

/** Walk complete rows, including nested AI responses, recipes, checkpoints and media URLs. */
export function collectObjectPaths(value: unknown, paths = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    for (const match of value.matchAll(/\/objects\/[a-zA-Z0-9/_-]+/g)) paths.add(match[0]);
  } else if (Array.isArray(value)) {
    for (const child of value) collectObjectPaths(child, paths);
  } else if (value && typeof value === "object") {
    for (const child of Object.values(value)) collectObjectPaths(child, paths);
  }
  return paths;
}

export function assessObject(item: InventoryObject, owner: string, refs: Set<string>, finals: Set<string>,
  busy: boolean, policy: StorageRetention, now = Date.now()): StorageObject | null {
  if (item.owner !== owner || !item.private) return null;
  const upload = item.objectPath.startsWith("/objects/uploads/");
  const mp4 = item.contentType.split(";")[0] === "video/mp4";
  const pack = item.contentType === "application/zip";
  const category = upload ? "uploads" : finals.has(item.objectPath) ? "final clips" : pack ? "export packs" : "recovery intermediates";
  const days = pack ? policy.exportDays : policy.intermediateDays;
  let reason = "Unverified legacy object: kept";
  let eligible = false;
  if (upload) reason = "Original upload: always kept";
  else if (mp4) reason = "Playable MP4: always kept";
  else if (refs.has(item.objectPath)) reason = "Referenced by saved media, recovery or publishing data: kept";
  else if (!pack && busy) reason = "Resumable or running jobs exist: intermediates kept";
  else if (!pack && (item.purpose !== "intermediate" || !["audio/mpeg", "audio/mp3", "text/plain", "application/x-subrip", "image/jpeg", "image/png", "image/webp"].includes(item.contentType))) {
    reason = "Unknown provenance or media type: kept";
  } else if (days == null) reason = "Retention disabled: kept";
  else if (!item.generation || !item.metageneration || !Number.isFinite(item.bytes) || item.bytes < 0 || !Number.isFinite(Date.parse(item.createdAt))) reason = "Incomplete metadata: kept";
  else if (now - Date.parse(item.createdAt) < days * 86400000) reason = "Within retention period: kept";
  else { eligible = true; reason = pack ? `Unreferenced export older than ${days} days` : `Unreferenced generated intermediate older than ${days} days`; }
  return { objectPath: item.objectPath, category, bytes: item.bytes, createdAt: item.createdAt,
    generation: item.generation, metageneration: item.metageneration, eligible, reason, outcome: "not requested" };
}
