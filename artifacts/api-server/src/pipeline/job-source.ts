import { mkdtemp, rm, stat, readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { ingestVod, MAX_REMOTE_BYTES, SourceIngestionError, type Execute } from "./ingestion";

/** Temporary full VOD, shared by this job's audio extraction and all selected clips. */
export class JobSource {
  readonly path: string;
  private download?: Promise<string>;
  private temporary?: string;
  constructor(jobId: number, private url: string, private execute: Execute) {
    if (!Number.isSafeInteger(jobId) || jobId < 1) throw new Error("Invalid source job ID.");
    this.path = `/tmp/source_${jobId}.mp4`;
  }
  get() {
    return this.download ??= this.retrieve().catch(error => { this.download = undefined; throw error; });
  }
  private async retrieve() {
    // A killed process cannot run finally. A deliberate Retry removes its leftovers.
    await this.cleanup();
    try {
      await ingestVod(this.url, this.path, async (exe, args, timeout) => {
        // yt-dlp keeps partial streams/merge intermediates in a private job directory.
        await rm(this.path, { force: true });
        if (this.temporary) await rm(this.temporary, { recursive: true, force: true });
        this.temporary = await mkdtemp(`${this.path}.parts-`);
        const output = args.indexOf("-o");
        const options = [...args];
        // Absolute -o would make yt-dlp ignore --paths, leaking partial streams.
        options[output + 1] = basename(args[output + 1]!);
        return this.execute(exe, ["--paths", "home:/tmp", "--paths", `temp:${this.temporary}`, ...options], timeout);
      });
      const bytes = (await stat(this.path)).size;
      if (!bytes) throw new SourceIngestionError("Full-source download produced an empty MP4.");
      if (bytes > MAX_REMOTE_BYTES) throw new SourceIngestionError("Full-source download exceeds the 2 GB source limit.");
      return this.path;
    } catch (error) { await this.cleanup(); throw error; }
  }
  async cleanup() {
    try { await rm(this.path, { force: true }); }
    finally {
      const prefix = `${basename(this.path)}.parts-`;
      const stale = (await readdir("/tmp")).filter(name => name.startsWith(prefix));
      await Promise.all(stale.map(name => rm(join("/tmp", name), { recursive: true, force: true })));
      this.temporary = undefined;
    }
  }
}
