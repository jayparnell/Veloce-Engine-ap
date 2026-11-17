import { pool, type PoolClient } from "@workspace/db";
import { claimFeed, admitFeedSources } from "../../lib/youtube-feeds";

// Standalone interruption fixture: never starts a media worker, publisher or network fetch.
const [schema, owner, action] = process.argv.slice(2);
if (process.env.NODE_ENV === "production" || !schema || !/^feeds_[a-f0-9]+$/.test(schema) || !owner?.startsWith("fixture:")) throw new Error("Isolated feed fixture only.");
(pool.options as { onConnect?: (c: PoolClient) => Promise<unknown> }).onConnect = (client) => client.query(`SET search_path TO "${schema}"`);
try {
  if (action === "claim") {
    const feed = await claimFeed(owner);
    process.send?.({ type: "claimed", id: feed?.id });
    // Parent kills this process to simulate an interrupted network poll.
    await new Promise(() => {});
  } else if (action === "admit") {
    const admitted = await admitFeedSources(owner);
    process.send?.({ type: "admitted", count: admitted });
  } else throw new Error("Invalid fixture action");
} finally {
  await pool.end();
  process.disconnect?.();
}
