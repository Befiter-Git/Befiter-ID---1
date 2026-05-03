import { sql } from "drizzle-orm";
import { pgTable, text, varchar, boolean, timestamp, date, numeric, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const befiterIds = pgTable("befiter_ids", {
  id: varchar("id", { length: 50 }).primaryKey().default(sql`gen_random_uuid()`),
  fullName: text("full_name").notNull(),
  currentPhone: text("current_phone").notNull(),
  previousPhones: text("previous_phones").array().default(sql`'{}'`),
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
  injuries: text("injuries"),
  healthConditions: text("health_conditions"),
  anniversary: date("anniversary"),
  emergencyContactRelationship: text("emergency_contact_relationship"),
  landmark: text("landmark"),
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
  previousPhones: true,
}).extend({
  fullName: z.string().min(1, "Full name is required"),
  currentPhone: z.string().min(1, "Phone is required"),
  email: z.string().email("Valid email is required"),
});

export const VALID_FITNESS_GOALS = [
  "Weight Loss",
  "Muscle Gain",
  "Flexibility",
  "Endurance",
  "General Fitness",
  "Rehabilitation",
  "Sports Performance",
  "Stress Relief",
] as const;

export const updateBefiterIdSchema = createInsertSchema(befiterIds).omit({
  id: true,
  currentPhone: true,
  previousPhones: true,
  email: true,
  createdAt: true,
  updatedAt: true,
  identityTag: true,
}).partial().extend({
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format").optional(),
  anniversary: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format").optional(),
  fitnessGoals: z.array(z.enum(VALID_FITNESS_GOALS)).optional(),
});

export const patchBefiterIdSchema = z.object({
  fullName: z.string().min(1).optional(),
  phone: z.string().min(1).optional(),
  email: z.string().email().optional(),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format").optional(),
  gender: z.string().optional(),
  profilePhoto: z.string().optional(),
  country: z.string().optional(),
  state: z.string().optional(),
  city: z.string().optional(),
  pincode: z.string().optional(),
  locality: z.string().optional(),
  occupation: z.string().optional(),
  maritalStatus: z.string().optional(),
  emergencyContactName: z.string().optional(),
  emergencyContactPhone: z.string().optional(),
  emergencyContactRelationship: z.string().optional(),
  landmark: z.string().optional(),
  languagePreference: z.string().min(2).max(10).optional(),
  height: z.union([z.string(), z.number()]).transform(v => String(v)).optional(),
  weight: z.union([z.string(), z.number()]).transform(v => String(v)).optional(),
  bloodGroup: z.string().optional(),
  fitnessGoals: z.array(z.enum(VALID_FITNESS_GOALS)).optional(),
  medicalHistory: z.string().optional(),
  injuries: z.string().optional(),
  healthConditions: z.string().optional(),
  anniversary: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format").optional(),
});

export const upsertBefiterIdSchema = patchBefiterIdSchema.extend({
  appUserId: z.string().min(1),
});
export type UpsertBefiterId = z.infer<typeof upsertBefiterIdSchema>;

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
export type PatchBefiterId = z.infer<typeof patchBefiterIdSchema>;
export type AppLink = typeof appLinks.$inferSelect;
export type InsertAppLink = z.infer<typeof insertAppLinkSchema>;
export type ApiKey = typeof apiKeys.$inferSelect;
export type InsertApiKey = z.infer<typeof insertApiKeySchema>;
export type IdentityUpdate = typeof identityUpdates.$inferSelect;
export type InsertIdentityUpdate = z.infer<typeof insertIdentityUpdateSchema>;
export type Stat = typeof stats.$inferSelect;

export type BefiterIdWithLinks = BefiterId & { appLinks: AppLink[] };

export const leads = pgTable("leads", {
  id: varchar("id", { length: 50 }).primaryKey().default(sql`gen_random_uuid()`),
  storeLeadId: text("store_lead_id").notNull().unique(),
  fullName: text("full_name").notNull(),
  phone: text("phone").notNull(),
  email: text("email"),
  brandName: text("brand_name").notNull(),
  branchName: text("branch_name").notNull(),
  leadSource: text("lead_source"),
  leadStatus: text("lead_status").notNull(),
  interestedService: text("interested_service"),
  interestedPackage: text("interested_package"),
  packagePrice: numeric("package_price"),
  offeredPrice: numeric("offered_price"),
  visitDate: text("visit_date"),
  followUpDate: text("follow_up_date"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

const numericField = z.union([z.string(), z.number()]).transform(v => String(v)).optional();

export const insertLeadSchema = createInsertSchema(leads).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  fullName: z.string().min(1, "Full name is required"),
  phone: z.string().min(1, "Phone is required"),
  brandName: z.string().min(1, "Brand name is required"),
  branchName: z.string().min(1, "Branch name is required"),
  leadStatus: z.string().min(1, "Lead status is required"),
  storeLeadId: z.string().min(1, "Store lead ID is required"),
  packagePrice: numericField,
  offeredPrice: numericField,
});

export const patchLeadSchema = createInsertSchema(leads).omit({
  id: true,
  storeLeadId: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  packagePrice: numericField,
  offeredPrice: numericField,
}).partial();

export type Lead = typeof leads.$inferSelect;
export type InsertLead = z.infer<typeof insertLeadSchema>;
export type PatchLead = z.infer<typeof patchLeadSchema>;

export const webhookEvents = pgTable("webhook_events", {
  id: varchar("id", { length: 50 }).primaryKey().default(sql`gen_random_uuid()`),
  eventId: varchar("event_id", { length: 50 }).notNull().unique(),
  eventType: text("event_type").notNull(),
  destination: text("destination").notNull(),
  payload: text("payload").notNull(),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  nextAttemptAt: timestamp("next_attempt_at").notNull().defaultNow(),
  deliveredAt: timestamp("delivered_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type WebhookStatus = "pending" | "success" | "failed" | "dead";
export type WebhookDestination = "com" | "store";
export type WebhookEventType =
  | "identity.created"
  | "identity.updated"
  | "identity.app_linked";

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
