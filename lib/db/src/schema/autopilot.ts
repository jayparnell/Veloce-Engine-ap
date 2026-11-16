import { pgTable, serial, text, integer, boolean, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { projectsTable, generatedClipsTable } from "./production";

export type Checkpoint = Record<string, unknown>;
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
]);

// A started call without a stored result is ambiguous: never automatically repeat it.
export const aiCheckpointsTable = pgTable("autopilot_ai_calls", {
  jobId: integer("job_id").notNull().references(() => autopilotJobsTable.id, { onDelete: "cascade" }),
  callKey: text("call_key").notNull(),
  status: text("status").notNull(),
  result: jsonb("result").$type<Checkpoint>(),
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
  checkpoint: jsonb("checkpoint").$type<Checkpoint>().notNull().default({}),
  attempts: integer("attempts").notNull().default(0),
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
export const insertAutopilotJobSchema = createInsertSchema(autopilotJobsTable);
export const insertSocialAccountSchema = createInsertSchema(socialAccountsTable);
export type AutopilotJob = typeof autopilotJobsTable.$inferSelect;
export type SocialAccount = typeof socialAccountsTable.$inferSelect;
export type PublishWork = typeof publishQueueTable.$inferSelect;
