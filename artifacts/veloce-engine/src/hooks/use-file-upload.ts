import { useEffect, useRef, useState } from "react";
import { requestUploadUrl, finalizeMediaUpload } from "@workspace/api-client-react";
import { useToast } from "./use-toast";

const MAX = 524288000;
const ALLOWED = ["video/mp4", "image/png"];

export function validateFile(file: File): string | null {
  if (file.size > MAX) return "File exceeds the 500 MB limit.";
  if (!(ALLOWED.includes(file.type) || file.type.startsWith("audio/"))) return "Only MP4 video, audio files, or PNG images are accepted.";
  return null;
}

/** Real upload: request presigned URL, PUT bytes, return objectPath. */
export function useFileUpload() {
  const { toast } = useToast();
  const active = useRef<AbortController | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [verifying, setVerifying] = useState(false);
  useEffect(() => () => active.current?.abort(), []);

  function fail(message: string) {
    setError(message);
    toast({ title: "Upload failed", description: message, variant: "destructive" });
  }

  async function upload(file: File): Promise<string | null> {
    if (active.current) return null;
    const invalid = validateFile(file);
    if (invalid) {
      fail(invalid);
      return null;
    }
    const controller = new AbortController();
    active.current = controller;
    setError(null);
    setProgress(0);
    setVerifying(false);
    setUploading(true);
    try {
      const options = () => ({ signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) });
      const res = await requestUploadUrl({ name: file.name, size: file.size, contentType: file.type }, options());
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        let idle: ReturnType<typeof setTimeout>;
        const abort = () => xhr.abort();
        const cleanup = () => { clearTimeout(idle); controller.signal.removeEventListener("abort", abort); };
        const finish = (message?: string) => { cleanup(); message ? reject(new Error(message)) : resolve(); };
        const watch = () => {
          clearTimeout(idle);
          idle = setTimeout(() => { finish("Upload stalled for 60 seconds. Check your connection and retry."); xhr.abort(); }, 60000);
        };
        xhr.open("PUT", res.uploadURL);
        xhr.setRequestHeader("Content-Type", file.type);
        xhr.timeout = 15 * 60 * 1000;
        xhr.upload.onprogress = (event) => { watch(); if (event.lengthComputable) setProgress(Math.min(100, Math.round(event.loaded / event.total * 100))); };
        xhr.onload = () => finish(xhr.status >= 200 && xhr.status < 300 ? undefined : `Storage rejected the upload (HTTP ${xhr.status}). Please retry.`);
        xhr.onerror = () => finish("Could not reach file storage. Check your connection and retry.");
        xhr.ontimeout = () => finish("Upload exceeded 15 minutes. Try a smaller file or faster connection.");
        xhr.onabort = () => finish("Upload cancelled. Select the file again to retry.");
        controller.signal.addEventListener("abort", abort, { once: true });
        if (controller.signal.aborted) { finish("Upload cancelled."); return; }
        watch();
        xhr.send(file);
      });
      setProgress(100);
      setVerifying(true);
      await finalizeMediaUpload({ objectPath: res.objectPath }, options());
      return res.objectPath;
    } catch (e) {
      fail(e instanceof DOMException && ["TimeoutError", "AbortError"].includes(e.name)
        ? "Upload request timed out or was cancelled. Please retry."
        : e instanceof Error ? e.message : "Upload failed. Please retry.");
      return null;
    } finally {
      active.current = null;
      setVerifying(false);
      setUploading(false);
    }
  }

  return { upload, uploading, progress, verifying, error };
}
