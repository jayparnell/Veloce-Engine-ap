import { useState } from "react";
import { useRequestUploadUrl } from "@workspace/api-client-react";

const MAX = 524288000;
const ALLOWED = ["video/mp4", "image/png"];

export function validateFile(file: File): string | null {
  if (file.size > MAX) return "File exceeds the 500 MB limit.";
  if (!(ALLOWED.includes(file.type) || file.type.startsWith("audio/"))) return "Only MP4 video, audio files, or PNG images are accepted.";
  return null;
}

/** Real upload: request presigned URL, PUT bytes, return objectPath. */
export function useFileUpload() {
  const request = useRequestUploadUrl();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File): Promise<string | null> {
    const invalid = validateFile(file);
    if (invalid) {
      setError(invalid);
      return null;
    }
    setError(null);
    setUploading(true);
    try {
      const res = await request.mutateAsync({ data: { name: file.name, size: file.size, contentType: file.type || "application/octet-stream" } });
      const put = await fetch(res.uploadURL, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
      if (!put.ok) throw new Error(`Storage rejected the upload (${put.status})`);
      return res.objectPath;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
      return null;
    } finally {
      setUploading(false);
    }
  }

  return { upload, uploading, error };
}
