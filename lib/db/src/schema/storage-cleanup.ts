import { pgTable, text, timestamp, jsonb, index, primaryKey, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

// No media foreign keys: audit evidence must survive project/clip deletion.
export const storageCleanupsTable = pgTable("storage_cleanups", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  status: text("status").notNull().default("preview"),
  report: jsonb("report").notNull(),
  outcomes: jsonb("outcomes").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("storage_cleanup_owner_recent").on(t.ownerId, t.createdAt),
  index("storage_cleanup_owner_cursor").on(t.ownerId, t.createdAt.desc(), t.id.desc())]);
export const insertStorageCleanupSchema = createInsertSchema(storageCleanupsTable);

export const storageObjectIndexTable = pgTable("storage_object_index", {
  scope: text("scope").notNull(),
  objectPath: text("object_path").notNull(),
  ownerId: text("owner_id").notNull(),
  metadata: jsonb("metadata").notNull(),
  seenRun: text("seen_run").notNull(),
}, (t) => [primaryKey({ columns: [t.scope, t.objectPath] }),
  index("storage_objects_owner_path").on(t.scope, t.ownerId, t.objectPath)]);
export const storageInventoryStateTable = pgTable("storage_inventory_state", {
  scope: text("scope").primaryKey(),
  pageToken: text("page_token"),
  runId: text("run_id").notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  advancedAt: timestamp("advanced_at", { withTimezone: true }),
});
export const storageObjectReferencesTable = pgTable("storage_object_references", {
  sourceTable: text("source_table").notNull(),
  sourceId: text("source_id").notNull(),
  objectPath: text("object_path").notNull(),
  final: boolean("final").notNull().default(false),
}, (t) => [primaryKey({ columns: [t.sourceTable, t.sourceId, t.objectPath] }),
  index("storage_references_path").on(t.objectPath)]);
export const storageObjectFencesTable = pgTable("storage_object_fences", {
  objectPath: text("object_path").primaryKey(),
  cleanupId: text("cleanup_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
