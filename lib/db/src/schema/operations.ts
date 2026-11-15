import { pgTable, serial, text, integer, boolean, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { generatedClipsTable } from "./production";

export const schedulesTable = pgTable("publishing_schedules", {
  id: serial("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  clipId: integer("clip_id").notNull().references(() => generatedClipsTable.id, { onDelete: "cascade" }),
  platform: text("platform").notNull(),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
  status: text("status").notNull().default("draft"),
  demo: boolean("demo").notNull().default(false),
});
export const platformAccountsTable = pgTable("platform_accounts", {
  id: serial("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  platform: text("platform").notNull(),
  connected: boolean("connected").notNull().default(false),
  handle: text("handle").notNull().default(""),
});
export const analyticsLogsTable = pgTable("analytics_logs", {
  id: serial("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  message: text("message").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const trainingProgressTable = pgTable("training_progress", {
  id: serial("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  lessonId: integer("lesson_id").notNull(),
  completed: boolean("completed").notNull().default(false),
}, (t) => [uniqueIndex("training_owner_lesson").on(t.ownerId, t.lessonId)]);
export const insertScheduleSchema = createInsertSchema(schedulesTable).omit({ id: true });
export const insertAccountSchema = createInsertSchema(platformAccountsTable).omit({ id: true });
export const insertAnalyticsSchema = createInsertSchema(analyticsLogsTable).omit({ id: true, createdAt: true });
export const insertTrainingSchema = createInsertSchema(trainingProgressTable).omit({ id: true });
