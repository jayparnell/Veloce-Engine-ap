import { pgTable, serial, text, boolean, timestamp, integer, primaryKey, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

export const youtubeSubscriptionsTable = pgTable("youtube_subscriptions", {
  id: serial("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  kind: text("kind").notNull(),
  providerId: text("provider_id").notNull(),
  feedUrl: text("feed_url").notNull(),
  title: text("title").notNull(),
  paused: boolean("paused").notNull().default(false),
  baselineAt: timestamp("baseline_at", { withTimezone: true }),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  nextPollAt: timestamp("next_poll_at", { withTimezone: true }).notNull().defaultNow(),
  error: text("error"),
  etag: text("etag"),
  lastModified: text("last_modified"),
  leaseToken: text("lease_token"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("youtube_subscription_identity").on(t.ownerId, t.kind, t.providerId)]);
export const youtubeSourcesTable = pgTable("youtube_sources", {
  ownerId: text("owner_id").notNull(), videoId: text("video_id").notNull(), title: text("title").notNull(),
  state: text("state").notNull().default("pending"), projectId: integer("project_id"), jobId: integer("job_id"),
  reason: text("reason"), retryAt: timestamp("retry_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.ownerId, t.videoId] })]);
export const youtubeFeedEntriesTable = pgTable("youtube_feed_entries", {
  subscriptionId: integer("subscription_id").notNull().references(() => youtubeSubscriptionsTable.id, { onDelete: "cascade" }),
  videoId: text("video_id").notNull(), baseline: boolean("baseline").notNull(),
  discoveredAt: timestamp("discovered_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.subscriptionId, t.videoId] })]);
export const insertYoutubeSubscriptionSchema = createInsertSchema(youtubeSubscriptionsTable);
export type YoutubeSubscription = typeof youtubeSubscriptionsTable.$inferSelect;
