import { pgTable, serial, text, integer, boolean, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { projectsTable, generatedClipsTable } from "./production";

export type Checkpoint = Record<string, unknown>;
export type AIUsageMetrics = {
  inputTokens: number | null; outputTokens: number | null; totalTokens: number | null;
  inputAudioTokens: number | null; outputAudioTokens: number | null; audioSeconds: number | null;
};
// No media foreign keys: usage and uncertain attempts survive deletion and acknowledged retries.
export const aiUsageTable = pgTable("autopilot_ai_usage", {
  id: serial("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  jobId: integer("job_id").notNull(),
  projectId: integer("project_id").notNull(),
  sourceTitle: text("source_title").notNull(),
  language: text("language").notNull(),
  category: text("category").notNull(),
  callKey: text("call_key").notNull(),
  status: text("status").notNull().default("started"),
  units: integer("units").notNull().default(1),
  model: text("model"),
  metrics: jsonb("metrics").$type<AIUsageMetrics>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("ai_usage_owner_recent").on(t.ownerId, t.createdAt), index("ai_usage_job").on(t.jobId)]);
// Intentionally no media foreign keys: deleting a clip/project cannot reset daily usage or replay a paid launch.
export const autopilotAdmissionsTable = pgTable("autopilot_admissions", {
  id: serial("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  requestKey: text("request_key").notNull(),
  inputHash: text("input_hash").notNull(),
  jobId: integer("job_id"),
  projectId: integer("project_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("admission_owner_request").on(t.ownerId, t.requestKey), index("admission_owner_created").on(t.ownerId, t.createdAt)]);
export const autopilotJobsTable = pgTable("autopilot_jobs", {
  id: serial("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  projectId: integer("project_id").notNull().references(() => projectsTable.id, { onDelete: "cascade" }),
  requestKey: text("request_key").notNull(),
  inputHash: text("input_hash").notNull(),
  language: text("language").notNull().default("en"),
  originalClipId: integer("original_clip_id").references(() => generatedClipsTable.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("queued"),
  stage: text("stage").notNull().default("accepted"),
  progress: integer("progress").notNull().default(0),
  checkpoint: jsonb("checkpoint").$type<Checkpoint>().notNull().default({}),
  notice: text("notice").notNull().default(""),
  error: text("error"),
  failures: integer("failures").notNull().default(0),
  retryAt: timestamp("retry_at", { withTimezone: true }),
  failureKind: text("failure_kind"),
  leaseToken: text("lease_token"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  cancelRequested: boolean("cancel_requested").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("autopilot_owner_request").on(t.ownerId, t.requestKey),
  index("autopilot_project").on(t.projectId),
  index("autopilot_owner_recent").on(t.ownerId, t.id),
  index("autopilot_claim").on(t.status, t.leaseUntil, t.id).where(sql`${t.status} IN ('queued','processing') AND ${t.cancelRequested}=false`),
  index("autopilot_retry_claim").on(t.status, t.retryAt, t.id).where(sql`${t.cancelRequested}=false AND ${t.status} IN ('queued','retry','budget_paused')`),
]);

// A started call without a stored result is ambiguous: never automatically repeat it.
export const aiCheckpointsTable = pgTable("autopilot_ai_calls", {
  jobId: integer("job_id").notNull().references(() => autopilotJobsTable.id, { onDelete: "cascade" }),
  callKey: text("call_key").notNull(),
  status: text("status").notNull(),
  result: jsonb("result").$type<Checkpoint>(),
  usageId: integer("usage_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("autopilot_ai_call").on(t.jobId, t.callKey)]);

export const socialAccountsTable = pgTable("social_accounts", {
  id: serial("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  provider: text("provider").notNull(),
  platform: text("platform").notNull(),
  remoteAccountId: text("remote_account_id").notNull(),
  handle: text("handle").notNull(),
  encryptedTokens: text("encrypted_tokens"),
  postingRoute: text("posting_route").notNull().default("direct"),
  unifiedAccountId: text("unified_account_id"),
  unifiedProfileId: text("unified_profile_id"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  scopes: text("scopes").notNull(),
  approved: boolean("approved").notNull().default(false),
  connected: boolean("connected").notNull().default(true),
  autoEnabled: boolean("auto_enabled").notNull().default(false),
  autoEnabledAt: timestamp("auto_enabled_at", { withTimezone: true }),
  includeDubs: boolean("include_dubs").notNull().default(false),
  timezone: text("timezone").notNull().default("America/New_York"),
  slots: jsonb("slots").$type<string[]>().notNull(),
  error: text("error"),
}, (t) => [uniqueIndex("social_owner_remote").on(t.ownerId, t.provider, t.remoteAccountId)]);

export const publishQueueTable = pgTable("autopilot_publish_queue", {
  id: serial("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  accountId: integer("account_id").notNull().references(() => socialAccountsTable.id, { onDelete: "cascade" }),
  clipId: integer("clip_id").notNull().references(() => generatedClipsTable.id, { onDelete: "cascade" }),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
  timezone: text("timezone").notNull(),
  status: text("status").notNull().default("scheduled"),
  remoteId: text("remote_id"),
  remoteUrl: text("remote_url"),
  checkpoint: jsonb("checkpoint").$type<Checkpoint>().notNull().default({}),
  attempts: integer("attempts").notNull().default(0),
  failureCountVersion: integer("failure_count_version").notNull().default(1),
  failureKind: text("failure_kind"),
  retryAt: timestamp("retry_at", { withTimezone: true }),
  error: text("error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("publish_account_clip").on(t.accountId, t.clipId),
  uniqueIndex("publish_account_slot").on(t.accountId, t.scheduledAt),
  index("publish_due").on(t.scheduledAt, t.retryAt).where(sql`${t.status} IN ('scheduled','processing','publishing','retry')`),
]);
export const workerServicesTable = pgTable("autopilot_services", {
  name: text("name").primaryKey(),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
});
export const unifiedPostingSettingsTable = pgTable("unified_posting_settings", {
  ownerId: text("owner_id").primaryKey(),
  provider: text("provider").notNull(),
  credentialHash: text("credential_hash").notNull(),
  discovery: jsonb("discovery").$type<Array<{ id: string; nativeId: string; profileId: string; provider: string; handle: string }>>().notNull().default([]),
  discoveredAt: timestamp("discovered_at", { withTimezone: true }),
});
export const automationSettingsTable = pgTable("automation_settings", {
  ownerId: text("owner_id").primaryKey(),
  dailyRenderCap: integer("daily_render_cap").notNull().default(15),
  dailyRequestUnitLimit: integer("daily_request_unit_limit"),
});
// No media foreign keys: deleting media must not refund completed output usage.
export const renderReservationsTable = pgTable("render_reservations", {
  outputKey: text("output_key").primaryKey(),
  ownerId: text("owner_id").notNull(),
  jobId: integer("job_id"),
  momentIndex: integer("moment_index"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (t) => [index("render_owner").on(t.ownerId)]);
export const insertAutopilotJobSchema = createInsertSchema(autopilotJobsTable);
export const insertSocialAccountSchema = createInsertSchema(socialAccountsTable);
export type AutopilotJob = typeof autopilotJobsTable.$inferSelect;
export type SocialAccount = typeof socialAccountsTable.$inferSelect;
export type PublishWork = typeof publishQueueTable.$inferSelect;
