import { pgTable, serial, text, integer, boolean, real, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

export const campaignsTable = pgTable("monetization_campaigns", {
  id: serial("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  name: text("name").notNull(),
  brand: text("brand").notNull(),
  cpm: real("cpm").notNull(),
  budget: real("budget").notNull(),
  status: text("status").notNull().default("active"),
  affiliateUrl: text("affiliate_url").notNull().default(""),
  cta: text("cta").notNull().default(""),
  audioPath: text("audio_path"),
  watermarkPath: text("watermark_path"),
  views: integer("views").notNull().default(0),
  demo: boolean("demo").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const insertCampaignSchema = createInsertSchema(campaignsTable).omit({ id: true, createdAt: true });
export type Campaign = typeof campaignsTable.$inferSelect;
