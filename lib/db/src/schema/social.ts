import { pgTable, text, boolean, timestamp, primaryKey } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

export const socialConfigsTable = pgTable("social_configs", {
  ownerId: text("owner_id").notNull(),
  provider: text("provider").notNull(),
  clientId: text("client_id").notNull().default(""),
  appApproved: boolean("app_approved").notNull().default(false),
  encryptedTokens: text("encrypted_tokens"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
}, (t) => [primaryKey({ columns: [t.ownerId, t.provider] })]);
export const oauthStatesTable = pgTable("oauth_states", {
  stateHash: text("state_hash").primaryKey(),
  ownerId: text("owner_id").notNull(),
  provider: text("provider").notNull(),
  verifier: text("verifier").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
export const insertSocialConfigSchema = createInsertSchema(socialConfigsTable);
export const insertOauthStateSchema = createInsertSchema(oauthStatesTable);
