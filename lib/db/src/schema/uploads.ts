import { pgTable, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
export const mediaUploadsTable = pgTable("media_uploads", {
  objectPath: text("object_path").primaryKey(),
  ownerId: text("owner_id").notNull(),
  size: integer("size").notNull(),
  contentType: text("content_type").notNull(),
  finalized: boolean("finalized").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const insertUploadSchema = createInsertSchema(mediaUploadsTable);
