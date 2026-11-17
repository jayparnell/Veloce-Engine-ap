import { randomUUID } from "node:crypto";
import { ObjectStorageService, objectStorageClient } from "./objectStorage";
import { setObjectAclPolicy, canAccessObject, ObjectPermission } from "./objectAcl";

export const storage = new ObjectStorageService();
export async function storeBytes(bytes: Buffer, owner: string, contentType: string) {
  const objectPath = `/objects/${randomUUID()}`;
  const fullPath = `${storage.getPrivateObjectDir()}${objectPath.slice("/objects".length)}`;
  const [, bucket, ...parts] = fullPath.split("/");
  const file = objectStorageClient.bucket(bucket!).file(parts.join("/"));
  await file.save(bytes, { resumable: false, contentType });
  await setObjectAclPolicy(file, { owner, visibility: "private" });
  await file.setMetadata({ metadata: { "veloce:purpose": contentType === "application/zip" ? "export" : "intermediate" } });
  return objectPath;
}
/** Stream large remote sources from disk rather than allocating a multi-GB Buffer. */
export async function storeLocalFile(path: string, owner: string, contentType: string) {
  const objectPath = `/objects/${randomUUID()}`;
  const fullPath = `${storage.getPrivateObjectDir()}${objectPath.slice("/objects".length)}`;
  const [, bucket, ...parts] = fullPath.split("/");
  const [file] = await objectStorageClient.bucket(bucket!).upload(path, {
    destination: parts.join("/"), resumable: true, metadata: { contentType },
  });
  await setObjectAclPolicy(file, { owner, visibility: "private" });
  await file.setMetadata({ metadata: { "veloce:purpose": contentType === "application/zip" ? "export" : "intermediate" } });
  return objectPath;
}
export async function ownedFile(objectPath: string, owner: string) {
  if (!/^\/objects\/[a-zA-Z0-9/_-]+$/.test(objectPath)) throw new Error("Invalid media path");
  const file = await storage.getObjectEntityFile(objectPath);
  if (!(await canAccessObject({ userId: owner, objectFile: file, requestedPermission: ObjectPermission.READ }))) {
    throw new Error("You do not have access to this media");
  }
  return file;
}
