import { pgTable, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

// No media foreign keys: audit evidence must survive project/clip deletion.
export const storageCleanupsTable = pgTable("storage_cleanups", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  status: text("status").notNull().default("preview"),
  report: jsonb("report").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("storage_cleanup_owner_recent").on(t.ownerId, t.createdAt)]);
export const insertStorageCleanupSchema = createInsertSchema(storageCleanupsTable);
