import { sql } from "drizzle-orm";
import { pgTable, text, varchar, boolean, timestamp, date, numeric, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const befiterIds = pgTable("befiter_ids", {
  id: varchar("id", { length: 50 }).primaryKey().default(sql`gen_random_uuid()`),
  fullName: text("full_name").notNull(),
  phone: text("phone").notNull().unique(),
  email: text("email").notNull().unique(),
  dateOfBirth: date("date_of_birth"),
  gender: text("gender"),
  profilePhoto: text("profile_photo"),
  country: text("country"),
  state: text("state"),
  city: text("city"),
  pincode: text("pincode"),
  locality: text("locality"),
  occupation: text("occupation"),
  maritalStatus: text("marital_status"),
  emergencyContactName: text("emergency_contact_name"),
  emergencyContactPhone: text("emergency_contact_phone"),
  languagePreference: text("language_preference").default("en"),
  height: numeric("height"),
  weight: numeric("weight"),
  bloodGroup: text("blood_group"),
  fitnessGoals: text("fitness_goals").array(),
  medicalHistory: text("medical_history"),
  identityTag: text("identity_tag").default("member"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const appLinks = pgTable("app_links", {
  id: varchar("id", { length: 50 }).primaryKey().default(sql`gen_random_uuid()`),
  befiterId: varchar("befiter_id", { length: 50 }).notNull().references(() => befiterIds.id),
  appName: text("app_name").notNull(),
  appUserId: text("app_user_id").notNull(),
  linkedAt: timestamp("linked_at").defaultNow(),
});

export const apiKeys = pgTable("api_keys", {
  id: varchar("id", { length: 50 }).primaryKey().default(sql`gen_random_uuid()`),
  appName: text("app_name").notNull().unique(),
  keyHash: text("key_hash").notNull(),
  keyPrefix: text("key_prefix").notNull(),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

export const identityUpdates = pgTable("identity_updates", {
  id: varchar("id", { length: 50 }).primaryKey().default(sql`gen_random_uuid()`),
  befiterId: varchar("befiter_id", { length: 50 }).notNull().references(() => befiterIds.id),
  appName: text("app_name").notNull(),
  fieldChanged: text("field_changed").notNull(),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  changedAt: timestamp("changed_at").defaultNow(),
});

export const stats = pgTable("stats", {
  id: varchar("id", { length: 50 }).primaryKey().default(sql`gen_random_uuid()`),
  key: text("key").notNull().unique(),
  value: integer("value").default(0).notNull(),
});

export const insertBefiterIdSchema = createInsertSchema(befiterIds).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  identityTag: true,
}).extend({
  fullName: z.string().min(1, "Full name is required"),
  phone: z.string().min(1, "Phone is required"),
  email: z.string().email("Valid email is required"),
});

export const updateBefiterIdSchema = createInsertSchema(befiterIds).omit({
  id: true,
  phone: true,
  email: true,
  createdAt: true,
  updatedAt: true,
  identityTag: true,
}).partial();

export const insertAppLinkSchema = createInsertSchema(appLinks).omit({
  id: true,
  linkedAt: true,
});

export const insertApiKeySchema = createInsertSchema(apiKeys).omit({
  id: true,
  createdAt: true,
});

export const insertIdentityUpdateSchema = createInsertSchema(identityUpdates).omit({
  id: true,
  changedAt: true,
});

export type BefiterId = typeof befiterIds.$inferSelect;
export type InsertBefiterId = z.infer<typeof insertBefiterIdSchema>;
export type UpdateBefiterId = z.infer<typeof updateBefiterIdSchema>;
export type AppLink = typeof appLinks.$inferSelect;
export type InsertAppLink = z.infer<typeof insertAppLinkSchema>;
export type ApiKey = typeof apiKeys.$inferSelect;
export type InsertApiKey = z.infer<typeof insertApiKeySchema>;
export type IdentityUpdate = typeof identityUpdates.$inferSelect;
export type InsertIdentityUpdate = z.infer<typeof insertIdentityUpdateSchema>;
export type Stat = typeof stats.$inferSelect;

export type BefiterIdWithLinks = BefiterId & { appLinks: AppLink[] };

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
