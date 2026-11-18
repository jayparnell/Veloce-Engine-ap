import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, stat, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ProxyAgent } from "undici";
import { configuredProxy, prepareYtdlpArguments, withCaptionResponse, writeYouTubeCookies, YOUTUBE_COOKIE_FILE } from "../pipeline/youtube-network";
import { metadataArguments, vodArguments, sourceToolError } from "../pipeline/ingestion";
import { jobContext, type JobContext } from "../pipeline/job-context";
import { accessibleCaptions } from "../pipeline/transcript";
import { redactError } from "../lib/failure-policy";

const proxy = "http://fixture-user:fixture-password@127.0.0.1:3128";
const cookies = "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t2147483647\tSID\tfixture-cookie-value\n";

test("every metadata and full-VOD request receives proxy before --", async () => {
  const commands = [
    metadataArguments("https://youtu.be/fixture"), metadataArguments("https://youtu.be/fixture", true),
    vodArguments("https://youtu.be/fixture", "/tmp/vod.mp4"),
    vodArguments("https://youtu.be/fixture", "/tmp/vod.mp4", true),
  ];
  for (const original of commands) {
    let preparedCookie = "";
    const args = await prepareYtdlpArguments(original, { PROXY_URL: proxy, YOUTUBE_COOKIES: cookies }, async contents => { preparedCookie = contents; });
    assert.equal(args[args.indexOf("--proxy") + 1], proxy);
    assert.equal(args[args.indexOf("--cookies") + 1], YOUTUBE_COOKIE_FILE);
    assert.ok(args.indexOf("--proxy") < args.indexOf("--"));
    assert.ok(args.indexOf("--cookies") < args.indexOf("--"));
    assert.equal(preparedCookie, cookies);
    assert.equal(args.at(-1), "https://youtu.be/fixture");
    assert.equal(original.includes("--proxy"), false);
  }
});
test("DataImpulse credentials pass through unchanged across jobs, captions, downloads and Retry", async () => {
  const env = { PROXY_URL: "http://fixture-user:p%40ssword@gw.dataimpulse.com:823" };
  const first = new URL(configuredProxy(env)!);
  assert.equal(decodeURIComponent(first.username), "fixture-user");
  assert.equal(decodeURIComponent(first.password), "p@ssword");
  assert.equal(configuredProxy(env), env.PROXY_URL);
  const explicitSession = "http://fixture-user__ses.old:pass@gw.dataimpulse.com:823";
  assert.equal(configuredProxy({ PROXY_URL: explicitSession }), explicitSession);
  assert.equal(configuredProxy({ PROXY_URL: proxy }), proxy);
  await jobContext.run({ job: { id: 71 } } as JobContext, async () => {
    for (const args of [metadataArguments("https://youtu.be/fixture"), vodArguments("https://youtu.be/fixture", "/tmp/fixture.mp4")]) {
      const prepared = await prepareYtdlpArguments(args, env);
      assert.equal(prepared[prepared.indexOf("--proxy") + 1], env.PROXY_URL);
    }
    assert.equal(configuredProxy(env), env.PROXY_URL, "caption transport uses the identical raw proxy");
    const caption = await withCaptionResponse(new URL("https://www.youtube.com/api/timedtext"), r => r.text(), env,
      async (_url, options) => { assert.ok((options as { dispatcher?: unknown }).dispatcher); return new Response("fixture captions"); });
    assert.equal(caption, "fixture captions");
  });
  await jobContext.run({ job: { id: 72 } } as JobContext, async () => {
    assert.equal(configuredProxy(env), env.PROXY_URL);
  });
  const safe = redactError(new Error(`ERROR: ${first.toString()}`), env);
  assert.ok(!safe.includes("fixture-user")); assert.ok(!safe.includes("p@ssword")); assert.ok(!safe.includes("p%40ssword"));
});
test("proxy and cookies are independently optional, with no stale cookie fallback", async () => {
  const original = metadataArguments("https://youtu.be/fixture");
  assert.deepEqual(await prepareYtdlpArguments(original, {}), original);
  assert.ok(!(await prepareYtdlpArguments(original, { PROXY_URL: proxy })).includes("--cookies"));
  const cookieOnly = await prepareYtdlpArguments(original, { YOUTUBE_COOKIES: cookies }, async () => {});
  assert.ok(cookieOnly.includes("--cookies")); assert.ok(!cookieOnly.includes("--proxy"));
  const one = await prepareYtdlpArguments(original, { PROXY_URL: proxy });
  const two = await prepareYtdlpArguments(original, { PROXY_URL: "https://other-fixture:changed-password@127.0.0.1:8443" });
  assert.notEqual(one[one.indexOf("--proxy") + 1], two[two.indexOf("--proxy") + 1]);
});
test("private cookie file is atomic, mode 0600, and never follows an existing symlink", async () => {
  const directory = await mkdtemp(join(tmpdir(), "youtube-cookie-test-"));
  try {
    const target = join(directory, "cookie-file.txt"), unrelated = join(directory, "unrelated.txt");
    await writeFile(unrelated, "untouched");
    await symlink(unrelated, target);
    await writeYouTubeCookies(cookies, target);
    assert.equal(await readFile(unrelated, "utf8"), "untouched");
    assert.equal(await readFile(target, "utf8"), cookies);
    assert.equal((await stat(target)).mode & 0o777, 0o600);
    const updated = cookies.replace("fixture-cookie-value", "updated-fixture-cookie");
    await Promise.all([writeYouTubeCookies(cookies, target), writeYouTubeCookies(updated, target)]);
    assert.ok([cookies, updated].includes(await readFile(target, "utf8")));
    assert.equal((await stat(target)).mode & 0o777, 0o600);
    await assert.rejects(writeYouTubeCookies("invalid-cookie-content-that-must-not-be-echoed", target), error => {
      assert.ok(error instanceof Error); assert.ok(!error.message.includes("must-not-be-echoed")); return true;
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("caption HTTP uses a scoped proxy dispatcher, rejects redirects and never retries directly", async () => {
  let calls = 0;
  const result = await withCaptionResponse(new URL("https://www.youtube.com/api/timedtext"), async response => response.text(),
    { PROXY_URL: proxy }, async (_url, init) => {
      calls++;
      assert.ok((init as RequestInit & { dispatcher?: unknown }).dispatcher instanceof ProxyAgent);
      assert.equal(init!.redirect, "error");
      assert.ok(init!.signal);
      return new Response("caption-fixture");
    });
  assert.equal(result, "caption-fixture"); assert.equal(calls, 1);
  await assert.rejects(withCaptionResponse(new URL("https://www.youtube.com/api/timedtext"), async response => response.text(),
    { PROXY_URL: proxy }, async () => { calls++; throw new Error("proxy unavailable"); }));
  assert.equal(calls, 2);
});
test("caption selection and parsing use the proxied HTTP path for each candidate", async () => {
  let calls = 0;
  const readCaption: typeof withCaptionResponse = (url, consume) => withCaptionResponse(url, consume, { PROXY_URL: proxy }, async (_url, init) => {
    calls++;
    assert.ok((init as RequestInit & { dispatcher?: unknown }).dispatcher instanceof ProxyAgent);
    return new Response("WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nActual source caption");
  });
  const segments = await accessibleCaptions({
    duration: 45, title: "Fixture", subtitles: { en: [{ ext: "vtt", url: "https://www.youtube.com/api/timedtext" }] },
  }, readCaption);
  assert.deepEqual(segments, [{ start: 1, end: 3, text: "Actual source caption" }]);
  assert.equal(calls, 1);
});
test("real caption transport sends authenticated CONNECT only to the configured local proxy", async () => {
  const server = createServer();
  let connections = 0, authorized = false, destination = "";
  server.on("connect", (request, socket) => {
    connections++;
    authorized = request.headers["proxy-authorization"] === `Basic ${Buffer.from("fixture:fake-password").toString("base64")}`;
    destination = request.url ?? "";
    // Never open an upstream socket: this fixture cannot reach YouTube.
    socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await assert.rejects(withCaptionResponse(new URL("https://www.youtube.com/api/timedtext"),
      async response => response.text(), { PROXY_URL: `http://fixture:fake-password@127.0.0.1:${port}` }));
    assert.equal(connections, 1); assert.equal(authorized, true); assert.equal(destination, "www.youtube.com:443");
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
test("invalid proxy configuration fails closed and never echoes credentials", async () => {
  for (const value of ["not-a-proxy-secret", "socks5://user:secret@127.0.0.1:1080", "file:///tmp/proxy"]) {
    assert.throws(() => configuredProxy({ PROXY_URL: value }), error => {
      assert.ok(error instanceof Error); assert.ok(!error.message.includes(value)); return true;
    });
    await assert.rejects(withCaptionResponse(new URL("https://www.youtube.com/api/timedtext"), async response => response.text(),
      { PROXY_URL: value }, async () => { assert.fail("Misconfigured proxy must not send a direct request"); }));
  }
});
test("provider errors and job cards redact proxy URLs, passwords and cookie entries", () => {
  const message = `ERROR: Sign in to confirm you're not a bot. --proxy ${proxy}`;
  const sanitized = redactError(new Error(message), { PROXY_URL: proxy });
  assert.ok(sanitized.includes("not a bot"));
  for (const value of [proxy, "fixture-password", "fixture-user"]) assert.ok(!sanitized.includes(value));
  assert.ok(!redactError(new Error("partial buffer: fixture-password@127.0.0.1:3128"), { PROXY_URL: proxy }).includes("fixture-password"));
  assert.ok(!redactError(new Error("socks5://user:synthetic@proxy.invalid:1080"), {}).includes("synthetic"));
  assert.ok(!sourceToolError("ERROR: Invalid cookie line .youtube.com\tTRUE\t/\tTRUE\t0\tSID\tfixture-cookie-value").includes("fixture-cookie-value"));
  assert.ok(!redactError(new Error(cookies), {}).includes("fixture-cookie-value"));
});
