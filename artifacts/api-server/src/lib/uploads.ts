import { db, mediaUploadsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { storage } from "./mediaStorage";
import { setObjectAclPolicy } from "./objectAcl";

export async function reserveUpload(objectPath: string, ownerId: string, size: number, contentType: string) {
  await db.insert(mediaUploadsTable).values({ objectPath, ownerId, size, contentType });
}
export async function finalizeUpload(objectPath: string, ownerId: string) {
  const [upload] = await db.select().from(mediaUploadsTable).where(and(eq(mediaUploadsTable.objectPath, objectPath), eq(mediaUploadsTable.ownerId, ownerId)));
  if (!upload || upload.finalized) return;
  const file = await storage.getObjectEntityFile(objectPath);
  const [meta] = await file.getMetadata();
  if (Number(meta.size) > upload.size || Number(meta.size) > 524288000 || meta.contentType !== upload.contentType) {
    await file.delete().catch(() => {});
    throw new Error("Upload size or type did not match the reservation");
  }
  await setObjectAclPolicy(file, { owner: ownerId, visibility: "private" });
  await db.update(mediaUploadsTable).set({ finalized: true }).where(eq(mediaUploadsTable.objectPath, objectPath));
}
