import { pgTable, serial, text, integer, boolean, timestamp, jsonb, real } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

export const projectsTable = pgTable("projects", {
  id: serial("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  title: text("title").notNull(),
  sourceUrl: text("source_url").notNull(),
  mode: text("mode").notNull(),
  clipCount: integer("clip_count").notNull().default(3),
  campaignId: integer("campaign_id"),
  status: text("status").notNull().default("queued"),
  stage: integer("stage").notNull().default(0),
  progress: integer("progress").notNull().default(0),
  error: text("error"),
  demo: boolean("demo").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const sourceVideosTable = pgTable("source_videos", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projectsTable.id, { onDelete: "cascade" }),
  objectPath: text("object_path").notNull(),
  title: text("title").notNull(),
  duration: real("duration").notNull().default(0),
  transcript: jsonb("transcript").$type<{ start: number; end: number; text: string }[]>().notNull().default([]),
});
export const generatedClipsTable = pgTable("generated_clips", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projectsTable.id, { onDelete: "cascade" }),
  ownerId: text("owner_id").notNull(),
  title: text("title").notNull(),
  creator: text("creator").notNull(),
  mode: text("mode").notNull(),
  duration: real("duration").notNull(),
  score: real("score").notNull(),
  hookScore: real("hook_score").notNull(),
  visualScore: real("visual_score").notNull(),
  commentaryScore: real("commentary_score").notNull(),
  thumbnail: text("thumbnail").notNull().default(""),
  videoUrl: text("video_url").notNull().default(""),
  objectPath: text("object_path"),
  voiceoverObjectPath: text("voiceover_object_path"),
  captionsObjectPath: text("captions_object_path"),
  status: text("status").notNull().default("ready"),
  demo: boolean("demo").notNull().default(false),
  hook: text("hook").notNull(),
  script: text("script").notNull(),
  hashtags: text("hashtags").notNull(),
  pinnedComment: text("pinned_comment").notNull(),
  platforms: text("platforms").array().notNull().default(["YouTube Shorts", "TikTok", "Instagram Reels"]),
  captions: boolean("captions").notNull().default(true),
  pictureInPicture: boolean("picture_in_picture").notNull().default(true),
  campaignId: integer("campaign_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const insertProjectSchema = createInsertSchema(projectsTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertSourceVideoSchema = createInsertSchema(sourceVideosTable).omit({ id: true });
export const insertClipSchema = createInsertSchema(generatedClipsTable).omit({ id: true, createdAt: true });
export type Project = typeof projectsTable.$inferSelect;
export type Clip = typeof generatedClipsTable.$inferSelect;
