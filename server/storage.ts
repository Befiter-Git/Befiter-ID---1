import { eq, ilike, or, and, sql, lte, desc, inArray } from "drizzle-orm";
import { randomUUID } from "crypto";
import { db } from "./db";
import {
  befiterIds, appLinks, apiKeys, identityUpdates, stats, leads, webhookEvents, adminAuditLog,
  type BefiterId, type InsertBefiterId, type UpdateBefiterId, type PatchBefiterId,
  type AppLink, type ApiKey, type IdentityUpdate, type BefiterIdWithLinks,
  type Lead, type InsertLead, type PatchLead,
  type WebhookEvent, type WebhookDestination, type WebhookEventType,
} from "@shared/schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function buildEnvelopeJson(eventType: WebhookEventType, eventId: string, data: Record<string, unknown>): string {
  return JSON.stringify({
    event_id: eventId,
    event_type: eventType,
    occurred_at: new Date().toISOString(),
    version: "1.0",
    source: "befiter.id",
    data,
  });
}

async function insertWebhookEventsTx(
  tx: Tx,
  eventType: WebhookEventType,
  data: Record<string, unknown>,
): Promise<void> {
  const destinations: WebhookDestination[] = ["com", "store"];
  const rows = destinations.map(destination => {
    const eventId = randomUUID();
    return {
      eventId,
      eventType,
      destination,
      payload: buildEnvelopeJson(eventType, eventId, data),
    };
  });
  await tx.insert(webhookEvents).values(rows);
}

export class LeadNotFoundError extends Error {
  constructor() { super("Lead not found"); }
}

export class EmailTakenError extends Error {
  code = "EMAIL_TAKEN" as const;
  constructor() { super("Email already belongs to another identity"); }
}

export class IdentityNotFoundError extends Error {
  code = "IDENTITY_NOT_FOUND" as const;
  constructor() { super("Identity not found"); }
}

export interface DashboardStats {
  totalIds: number;
  thisMonth: number;
  appBreakdown: { appName: string; count: number }[];
  duplicatePrevention: number;
  leads: {
    total: number;
    thisMonth: number;
    byStatus: { status: string; count: number }[];
    followUpsDue: number;
  };
  webhooks: {
    pending: number;
    dead: number;
    deliveredLast24h: number;
  };
}

export interface MetricsData {
  identitiesPerDay: { day: string; count: number }[];
  leadsPerDay: { day: string; count: number }[];
  webhooksPerDay: { day: string; success: number; dead: number }[];
  leadStatusBreakdown: { status: string; count: number }[];
  leadConversionRate: number;
  leadsTotal: number;
  leadsConverted: number;
  leadsLost: number;
  webhookSuccessRate: number;
  webhookTotal: number;
}

export interface CreateOrUpdateResult {
  identity: SerializedBefiterIdWithLinks;
  created: boolean;
}

export type SerializedBefiterId = Omit<BefiterId, "height" | "weight"> & {
  height: number | null;
  weight: number | null;
};
export type SerializedBefiterIdWithLinks = SerializedBefiterId & { appLinks: AppLink[] };

function unionFitnessGoalsFromLinks(links: AppLink[], fallback: string[] | null | undefined): string[] | null {
  const set = new Set<string>();
  for (const l of links) {
    const md = (l.metadata ?? {}) as Record<string, unknown>;
    const g = md.fitnessGoals;
    if (Array.isArray(g)) g.forEach((x) => typeof x === "string" && x.trim() && set.add(x.trim()));
  }
  if (set.size === 0) {
    return Array.isArray(fallback) && fallback.length > 0 ? fallback : null;
  }
  return Array.from(set);
}

export function serializeIdentity(identity: BefiterId): SerializedBefiterId;
export function serializeIdentity(identity: BefiterIdWithLinks): SerializedBefiterIdWithLinks;
export function serializeIdentity(identity: BefiterId | BefiterIdWithLinks): SerializedBefiterId | SerializedBefiterIdWithLinks {
  const links = (identity as BefiterIdWithLinks).appLinks;
  const base = {
    ...identity,
    height: identity.height != null ? Number(identity.height) : null,
    weight: identity.weight != null ? Number(identity.weight) : null,
  } as SerializedBefiterId & { appLinks?: AppLink[] };
  if (Array.isArray(links)) {
    base.fitnessGoals = unionFitnessGoalsFromLinks(links, identity.fitnessGoals);
    return base as SerializedBefiterIdWithLinks;
  }
  return base;
}

// Returns a copy of the serialized identity where the top-level `fitnessGoals`
// is scoped to the calling app's metadata bucket (instead of the deduped union
// across all apps). Used for app-authenticated API responses so one app cannot
// see peer apps' fitness goals on its own caller. Falls back to the union when
// the caller has no metadata of its own yet.
export function scopeFitnessGoalsToApp(
  identity: SerializedBefiterIdWithLinks,
  appName: string,
): SerializedBefiterIdWithLinks {
  // Strip peer apps' metadata so an app-scoped caller never sees another
  // app's bucket. Other apps' link rows are still listed (so the caller
  // knows the identity is multi-app) but their `metadata` is blanked out.
  const filteredLinks = identity.appLinks.map((l) =>
    l.appName === appName ? l : { ...l, metadata: {} as Record<string, unknown> },
  );
  const link = identity.appLinks.find((l) => l.appName === appName);
  const md = (link?.metadata ?? {}) as Record<string, unknown>;
  const scoped = md.fitnessGoals;
  let topLevel: string[] | null = identity.fitnessGoals ?? null;
  if (Array.isArray(scoped)) {
    const cleaned = scoped.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
    topLevel = cleaned.length > 0 ? cleaned : null;
  } else {
    // Caller has no metadata yet — don't leak the cross-app union; show
    // the legacy column value (or null).
    topLevel = identity.fitnessGoals ?? null;
  }
  return { ...identity, appLinks: filteredLinks, fitnessGoals: topLevel };
}

// Synthesizes a deterministic placeholder email for identities whose intake
// email failed validation but who still have a usable phone. The raw bad value
// is stored separately in `rejectedEmailAtIntake` for admin remediation.
export function isValidEmail(s: unknown): boolean {
  if (typeof s !== "string") return false;
  const t = s.trim();
  return t.length > 2 && t.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t);
}
// Phone is NOT unique (recycled SIMs), so the placeholder must be unique per
// identity to avoid silently merging two different people behind one row.
// We append a short random suffix; the original raw email (if any) is preserved
// in `rejected_email_at_intake` for admin reconciliation.
export function quarantineEmailFor(phone: string): string {
  const cleaned = phone.replace(/[^a-zA-Z0-9]/g, "");
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  return `quarantine.${cleaned}.${suffix}@befiter.invalid`;
}

const KNOWN_IDENTITY_KEYS = new Set([
  "fullName", "currentPhone", "phone", "previousPhones", "email",
  "dateOfBirth", "gender", "profilePhoto", "country", "state", "city",
  "pincode", "locality", "occupation", "maritalStatus",
  "emergencyContactName", "emergencyContactPhone", "emergencyContactRelationship",
  "landmark", "languagePreference", "height", "weight", "bloodGroup",
  "medicalHistory", "injuries", "healthConditions", "anniversary",
  "identityTag", "id", "createdAt", "updatedAt", "rejectedEmailAtIntake",
  "appUserId", "metadata", "fitnessGoals",
]);

// Pulls fitnessGoals + any unknown keys out of the input body and returns the
// per-app metadata bucket plus the cleaned body. Caller-supplied `metadata`
// object is merged on top.
export function extractMetadataBucket(body: Record<string, unknown>): {
  cleaned: Record<string, unknown>;
  metadata: Record<string, unknown>;
} {
  const metadata: Record<string, unknown> = {};
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === "metadata" && v && typeof v === "object") {
      Object.assign(metadata, v as Record<string, unknown>);
    } else if (k === "fitnessGoals") {
      if (Array.isArray(v)) metadata.fitnessGoals = v;
      cleaned[k] = v;
    } else if (!KNOWN_IDENTITY_KEYS.has(k)) {
      metadata[k] = v;
    } else {
      cleaned[k] = v;
    }
  }
  return { cleaned, metadata };
}

// Tolerant parse: tries to parse `input` against `schema`. If it fails, drops
// any failing OPTIONAL top-level fields (i.e. fields not in `requiredKeys`)
// and re-tries. Returns the parsed data plus a list of dropped fields so the
// caller can surface a `field_dropped:<name>` warning.
export function tolerantParse<T extends import("zod").ZodTypeAny>(
  schema: T,
  input: Record<string, unknown>,
  requiredKeys: Set<string>,
): { ok: true; data: import("zod").infer<T>; dropped: string[] } | { ok: false; error: import("zod").ZodError } {
  const dropped: string[] = [];
  let data: Record<string, unknown> = { ...input };
  for (let i = 0; i < 50; i++) {
    const result = schema.safeParse(data);
    if (result.success) return { ok: true, data: result.data, dropped };
    let progressed = false;
    for (const issue of result.error.issues) {
      const top = issue.path[0];
      if (typeof top === "string" && !requiredKeys.has(top) && top in data) {
        delete data[top];
        if (!dropped.includes(top)) dropped.push(top);
        progressed = true;
      }
    }
    if (!progressed) return { ok: false, error: result.error };
  }
  const final = schema.safeParse(data);
  if (final.success) return { ok: true, data: final.data, dropped };
  return { ok: false, error: final.error };
}

export interface CreateOrUpdateOptions {
  metadata?: Record<string, unknown>;
  rejectedEmailAtIntake?: string | null;
}

export interface IStorage {
  lookupByCurrentPhone(phone: string): Promise<BefiterId | undefined>;
  lookupByEmail(email: string): Promise<BefiterId | undefined>;
  createOrUpdateIdentity(data: InsertBefiterId, appName: string, appUserId: string, opts?: CreateOrUpdateOptions): Promise<CreateOrUpdateResult>;
  updateIdentity(befiterId: string, data: UpdateBefiterId, appName: string): Promise<SerializedBefiterIdWithLinks>;
  patchIdentity(befiterId: string, data: PatchBefiterId, appName: string, opts?: { metadata?: Record<string, unknown> }): Promise<SerializedBefiterIdWithLinks>;
  searchIntakeIssues(page: number, limit: number): Promise<{ results: SerializedBefiterIdWithLinks[]; total: number }>;
  clearRejectedEmail(befiterId: string, newEmail: string, adminUsername: string): Promise<SerializedBefiterIdWithLinks>;
  adminUpdateIdentity(befiterId: string, data: Partial<BefiterId>, adminUsername: string): Promise<SerializedBefiterIdWithLinks>;
  getIdentity(befiterId: string): Promise<SerializedBefiterIdWithLinks | undefined>;
  linkApp(befiterId: string, appName: string, appUserId: string): Promise<AppLink>;
  logAuditEntries(entries: { befiterId: string; appName: string; fieldChanged: string; oldValue: string | null; newValue: string | null }[]): Promise<void>;
  getAuditLog(befiterId: string): Promise<IdentityUpdate[]>;
  incrementDuplicatePrevention(): Promise<void>;
  getDashboardStats(): Promise<DashboardStats>;
  searchIdentities(query: string, page: number, limit: number): Promise<{ results: SerializedBefiterIdWithLinks[]; total: number }>;
  getAllApiKeys(): Promise<Omit<ApiKey, "keyHash">[]>;
  getApiKeyByPrefix(prefix: string): Promise<ApiKey | undefined>;
  createApiKey(appName: string, keyHash: string, keyPrefix: string): Promise<ApiKey>;
  updateApiKeyStatus(id: string, isActive: boolean): Promise<ApiKey>;
  deleteApiKey(id: string): Promise<void>;
  deleteIdentity(befiterId: string, adminUsername: string): Promise<void>;
  isAppLinked(befiterId: string, appName: string): Promise<boolean>;
  createLead(data: InsertLead, appName: string): Promise<Lead>;
  patchLead(id: string, data: PatchLead, appName: string): Promise<Lead>;
  getLeadByStoreId(storeLeadId: string, appName: string): Promise<Lead | undefined>;
  searchLeads(query: string, page: number, limit: number, status?: string): Promise<{ results: Lead[]; total: number }>;
  getLeadById(id: string): Promise<Lead | undefined>;
  getMetrics(): Promise<MetricsData>;
  lookupByAppUserId(appName: string, appUserId: string): Promise<SerializedBefiterIdWithLinks | undefined>;
  ensureAppLink(befiterId: string, appName: string, appUserId: string): Promise<void>;
  createWebhookEvent(data: { eventId: string; eventType: string; destination: WebhookDestination; payload: string }): Promise<WebhookEvent>;
  claimPendingWebhookEvents(limit: number): Promise<WebhookEvent[]>;
  markWebhookDelivered(id: string): Promise<void>;
  markWebhookFailed(id: string, errorMsg: string, nextAttemptAt: Date | null): Promise<void>;
  markWebhookDead(id: string, errorMsg: string): Promise<void>;
  requeueWebhookEvent(id: string): Promise<void>;
  listWebhookEvents(status: string | undefined, limit: number): Promise<WebhookEvent[]>;
}

export class DatabaseStorage implements IStorage {
  async lookupByCurrentPhone(phone: string): Promise<BefiterId | undefined> {
    const [result] = await db.select().from(befiterIds)
      .where(eq(befiterIds.currentPhone, phone))
      .limit(1);
    return result;
  }

  async lookupByEmail(email: string): Promise<BefiterId | undefined> {
    const [result] = await db.select().from(befiterIds)
      .where(eq(befiterIds.email, email.toLowerCase()))
      .limit(1);
    return result;
  }

  private async getIdentityWithLinks(befiterId: string): Promise<SerializedBefiterIdWithLinks> {
    const [identity] = await db.select().from(befiterIds).where(eq(befiterIds.id, befiterId)).limit(1);
    const links = await db.select().from(appLinks).where(eq(appLinks.befiterId, befiterId));
    return serializeIdentity({ ...identity, appLinks: links });
  }

  async ensureAppLink(befiterId: string, appName: string, appUserId: string): Promise<void> {
    const existing = await db.select().from(appLinks)
      .where(and(eq(appLinks.befiterId, befiterId), eq(appLinks.appName, appName)))
      .limit(1);
    if (existing.length === 0) {
      await db.insert(appLinks).values({ befiterId, appName, appUserId });
    }
  }

  private async mirrorFitnessGoalsToLegacyTx(tx: Tx, befiterId: string): Promise<void> {
    const allLinks = await tx.select().from(appLinks).where(eq(appLinks.befiterId, befiterId));
    const set = new Set<string>();
    for (const l of allLinks) {
      const md = (l.metadata ?? {}) as Record<string, unknown>;
      const g = md.fitnessGoals;
      if (Array.isArray(g)) g.forEach((x) => typeof x === "string" && x.trim() && set.add(x.trim()));
    }
    await tx.update(befiterIds).set({ fitnessGoals: Array.from(set) }).where(eq(befiterIds.id, befiterId));
  }

  private async upsertAppLinkMetadataTx(
    tx: Tx, befiterId: string, appName: string, metadata: Record<string, unknown>,
  ): Promise<void> {
    if (!metadata || Object.keys(metadata).length === 0) return;
    const [existing] = await tx.select().from(appLinks)
      .where(and(eq(appLinks.befiterId, befiterId), eq(appLinks.appName, appName)))
      .limit(1);
    if (!existing) return;
    const merged = { ...((existing.metadata ?? {}) as Record<string, unknown>), ...metadata };
    await tx.update(appLinks).set({ metadata: merged }).where(eq(appLinks.id, existing.id));
    // Mirror fitnessGoals union to the legacy `befiter_ids.fitness_goals`
    // column so any reader still using it during the transition window sees
    // a sensible value. Recomputed across all apps to remain consistent.
    if ("fitnessGoals" in metadata) {
      await this.mirrorFitnessGoalsToLegacyTx(tx, befiterId);
    }
  }

  async searchIntakeIssues(page: number, limit: number): Promise<{ results: SerializedBefiterIdWithLinks[]; total: number }> {
    const offset = (page - 1) * limit;
    const where = sql`${befiterIds.rejectedEmailAtIntake} IS NOT NULL`;
    const [totalRow] = await db.select({ count: sql<number>`count(*)::int` }).from(befiterIds).where(where);
    const rows = await db.select().from(befiterIds).where(where)
      .limit(limit).offset(offset).orderBy(sql`${befiterIds.createdAt} DESC`);
    const results = await Promise.all(rows.map(async (row) => {
      const links = await db.select().from(appLinks).where(eq(appLinks.befiterId, row.id));
      return serializeIdentity({ ...row, appLinks: links });
    }));
    return { results, total: totalRow.count };
  }

  async clearRejectedEmail(befiterId: string, newEmail: string, adminUsername: string): Promise<SerializedBefiterIdWithLinks> {
    return await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(befiterIds).where(eq(befiterIds.id, befiterId)).limit(1);
      if (!existing) throw new IdentityNotFoundError();
      const e = newEmail.trim().toLowerCase();
      if (!isValidEmail(e)) throw new Error("New email must be valid");
      const [taken] = await tx.select().from(befiterIds).where(eq(befiterIds.email, e)).limit(1);
      if (taken && taken.id !== befiterId) throw new EmailTakenError();
      await tx.update(befiterIds).set({
        email: e, rejectedEmailAtIntake: null, updatedAt: new Date(),
      }).where(eq(befiterIds.id, befiterId));
      await tx.insert(adminAuditLog).values([{
        action: "identity.fix_email", befiterId, adminUsername,
        fieldChanged: "email", oldValue: existing.email, newValue: e,
      }, {
        action: "identity.fix_email", befiterId, adminUsername,
        fieldChanged: "rejectedEmailAtIntake", oldValue: existing.rejectedEmailAtIntake, newValue: null,
      }]);
      // Also write to identity_updates so the change shows up in the audit log
      // alongside other field changes.
      await tx.insert(identityUpdates).values([
        { befiterId, appName: "admin", fieldChanged: "email", oldValue: existing.email, newValue: e },
        { befiterId, appName: "admin", fieldChanged: "rejectedEmailAtIntake", oldValue: existing.rejectedEmailAtIntake, newValue: null },
      ]);
      const [identityRow] = await tx.select().from(befiterIds).where(eq(befiterIds.id, befiterId)).limit(1);
      const links = await tx.select().from(appLinks).where(eq(appLinks.befiterId, befiterId));
      const identity = serializeIdentity({ ...identityRow, appLinks: links });
      // Resync downstream apps with the corrected email so caller systems can
      // re-key on the real address instead of the quarantine placeholder.
      await insertWebhookEventsTx(tx, "identity.updated", {
        source_app: "admin",
        changed_fields: ["email", "rejectedEmailAtIntake"],
        identity,
      });
      return identity;
    });
  }

  async createOrUpdateIdentity(data: InsertBefiterId, appName: string, appUserId: string, opts?: CreateOrUpdateOptions): Promise<CreateOrUpdateResult> {
    const metadata = opts?.metadata ?? {};
    const rejectedEmail = opts?.rejectedEmailAtIntake ?? null;
    return await db.transaction(async (tx) => {
      const [existingByEmail] = await tx.select().from(befiterIds)
        .where(eq(befiterIds.email, data.email.toLowerCase())).limit(1);

      if (existingByEmail) {
        const samePhone = existingByEmail.currentPhone === data.currentPhone;
        const auditEntries: { befiterId: string; appName: string; fieldChanged: string; oldValue: string | null; newValue: string | null }[] = [];

        if (!samePhone) {
          const oldPhone = existingByEmail.currentPhone;
          await tx.update(befiterIds).set({
            currentPhone: data.currentPhone,
            previousPhones: sql`array_append(${befiterIds.previousPhones}, ${oldPhone}::text)`,
            updatedAt: new Date(),
          }).where(eq(befiterIds.id, existingByEmail.id));

          auditEntries.push(
            { befiterId: existingByEmail.id, appName, fieldChanged: "currentPhone", oldValue: oldPhone, newValue: data.currentPhone },
            { befiterId: existingByEmail.id, appName, fieldChanged: "previousPhones",
              oldValue: JSON.stringify(existingByEmail.previousPhones ?? []),
              newValue: JSON.stringify([...(existingByEmail.previousPhones ?? []), oldPhone]) },
          );
        }

        if (auditEntries.length > 0) {
          await tx.insert(identityUpdates).values(auditEntries);
        }

        const existingLink = await tx.select().from(appLinks)
          .where(and(eq(appLinks.befiterId, existingByEmail.id), eq(appLinks.appName, appName)))
          .limit(1);
        const linkInserted = existingLink.length === 0;
        if (linkInserted) {
          await tx.insert(appLinks).values({ befiterId: existingByEmail.id, appName, appUserId, metadata });
          if (metadata && "fitnessGoals" in metadata) {
            await this.mirrorFitnessGoalsToLegacyTx(tx, existingByEmail.id);
          }
        } else if (Object.keys(metadata).length > 0) {
          await this.upsertAppLinkMetadataTx(tx, existingByEmail.id, appName, metadata);
        }

        const [identityRow] = await tx.select().from(befiterIds).where(eq(befiterIds.id, existingByEmail.id)).limit(1);
        const links = await tx.select().from(appLinks).where(eq(appLinks.befiterId, existingByEmail.id));
        const identity = serializeIdentity({ ...identityRow, appLinks: links });

        if (auditEntries.length > 0) {
          await insertWebhookEventsTx(tx, "identity.updated", {
            source_app: appName,
            changed_fields: auditEntries.map(e => e.fieldChanged),
            identity,
          });
        }
        if (linkInserted) {
          await insertWebhookEventsTx(tx, "identity.app_linked", {
            source_app: appName, app_name: appName, app_user_id: appUserId, identity,
          });
        }
        return { identity, created: false };
      }

      const [newIdentity] = await tx.insert(befiterIds).values({
        ...data,
        email: data.email.toLowerCase(),
        previousPhones: [],
        identityTag: "member",
        rejectedEmailAtIntake: rejectedEmail,
      }).returning();

      await tx.insert(appLinks).values({ befiterId: newIdentity.id, appName, appUserId, metadata });
      if (metadata && "fitnessGoals" in metadata) {
        await this.mirrorFitnessGoalsToLegacyTx(tx, newIdentity.id);
      }
      const links = await tx.select().from(appLinks).where(eq(appLinks.befiterId, newIdentity.id));
      const [refreshedIdentity] = await tx.select().from(befiterIds).where(eq(befiterIds.id, newIdentity.id)).limit(1);
      const identity = serializeIdentity({ ...refreshedIdentity, appLinks: links });
      await insertWebhookEventsTx(tx, "identity.created", { source_app: appName, identity });
      return { identity, created: true };
    });
  }

  async updateIdentity(befiterId: string, data: UpdateBefiterId, appName: string): Promise<SerializedBefiterIdWithLinks> {
    return await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(befiterIds).where(eq(befiterIds.id, befiterId)).limit(1);
      if (!existing) throw new IdentityNotFoundError();

      const auditEntries: { befiterId: string; appName: string; fieldChanged: string; oldValue: string | null; newValue: string | null }[] = [];

      for (const [field, newVal] of Object.entries(data)) {
        const oldVal = (existing as Record<string, unknown>)[field];
        const oldStr = oldVal === null || oldVal === undefined ? null : String(oldVal);
        const newStr = newVal === null || newVal === undefined ? null : String(newVal);
        if (oldStr !== newStr) {
          auditEntries.push({ befiterId, appName, fieldChanged: field, oldValue: oldStr, newValue: newStr });
        }
      }

      if (auditEntries.length > 0) {
        await tx.insert(identityUpdates).values(auditEntries);
      }

      await tx.update(befiterIds)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(befiterIds.id, befiterId));

      const [identityRow] = await tx.select().from(befiterIds).where(eq(befiterIds.id, befiterId)).limit(1);
      const links = await tx.select().from(appLinks).where(eq(appLinks.befiterId, befiterId));
      const updated = serializeIdentity({ ...identityRow, appLinks: links });

      if (auditEntries.length > 0) {
        await insertWebhookEventsTx(tx, "identity.updated", {
          source_app: appName,
          changed_fields: auditEntries.map(e => e.fieldChanged),
          identity: updated,
        });
      }
      return updated;
    });
  }

  async patchIdentity(befiterId: string, data: PatchBefiterId, appName: string, opts?: { metadata?: Record<string, unknown> }): Promise<SerializedBefiterIdWithLinks> {
   const metadata = opts?.metadata ?? {};
   return await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(befiterIds).where(eq(befiterIds.id, befiterId)).limit(1);
    if (!existing) throw new IdentityNotFoundError();

    if (data.email && data.email.toLowerCase() !== existing.email) {
      const [taken] = await tx.select().from(befiterIds)
        .where(eq(befiterIds.email, data.email.toLowerCase())).limit(1);
      if (taken && taken.id !== befiterId) throw new EmailTakenError();
    }

    const auditEntries: { befiterId: string; appName: string; fieldChanged: string; oldValue: string | null; newValue: string | null }[] = [];
    const dbUpdate: Record<string, unknown> = {};

    const { phone, email, ...rest } = data;

    if (phone && phone !== existing.currentPhone) {
      const oldPhone = existing.currentPhone;
      dbUpdate.currentPhone = phone;
      dbUpdate.previousPhones = sql`array_append(${befiterIds.previousPhones}, ${oldPhone}::text)`;
      auditEntries.push(
        { befiterId, appName, fieldChanged: "currentPhone", oldValue: oldPhone, newValue: phone },
        { befiterId, appName, fieldChanged: "previousPhones",
          oldValue: JSON.stringify(existing.previousPhones ?? []),
          newValue: JSON.stringify([...(existing.previousPhones ?? []), oldPhone]) },
      );
    }

    if (email && email.toLowerCase() !== existing.email) {
      const newEmail = email.toLowerCase();
      dbUpdate.email = newEmail;
      auditEntries.push({ befiterId, appName, fieldChanged: "email", oldValue: existing.email, newValue: newEmail });
    }

    for (const [field, newVal] of Object.entries(rest)) {
      if (newVal === undefined) continue;
      const oldVal = (existing as Record<string, unknown>)[field];
      const oldStr = oldVal === null || oldVal === undefined ? null : String(oldVal);
      const newStr = newVal === null ? null : String(newVal);
      if (oldStr !== newStr) {
        dbUpdate[field] = newVal;
        auditEntries.push({ befiterId, appName, fieldChanged: field, oldValue: oldStr, newValue: newStr });
      }
    }

    if (auditEntries.length > 0) await tx.insert(identityUpdates).values(auditEntries);

    if (Object.keys(dbUpdate).length > 0) {
      dbUpdate.updatedAt = new Date();
      await tx.update(befiterIds)
        .set(dbUpdate)
        .where(eq(befiterIds.id, befiterId));
    }

    if (Object.keys(metadata).length > 0) {
      await this.upsertAppLinkMetadataTx(tx, befiterId, appName, metadata);
      auditEntries.push({ befiterId, appName, fieldChanged: "metadata", oldValue: null, newValue: JSON.stringify(metadata) });
    }

    const [identityRow] = await tx.select().from(befiterIds).where(eq(befiterIds.id, befiterId)).limit(1);
    const links = await tx.select().from(appLinks).where(eq(appLinks.befiterId, befiterId));
    const updated = serializeIdentity({ ...identityRow, appLinks: links });

    if (auditEntries.length > 0) {
      await insertWebhookEventsTx(tx, "identity.updated", {
        source_app: appName,
        changed_fields: auditEntries.map(e => e.fieldChanged),
        identity: updated,
      });
    }
    return updated;
   });
  }

  async adminUpdateIdentity(befiterId: string, data: Partial<BefiterId>, adminUsername: string): Promise<SerializedBefiterIdWithLinks> {
    return await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(befiterIds).where(eq(befiterIds.id, befiterId)).limit(1);
      if (!existing) throw new IdentityNotFoundError();

      const { id, createdAt, identityTag, previousPhones, ...updateData } = data as BefiterId;
      const appName = `__admin__:${adminUsername}`;

      const auditEntries: { befiterId: string; appName: string; fieldChanged: string; oldValue: string | null; newValue: string | null }[] = [];
      const adminLogEntries: { action: string; befiterId: string; adminUsername: string; fieldChanged: string; oldValue: string | null; newValue: string | null }[] = [];

      for (const [field, newVal] of Object.entries(updateData)) {
        if (newVal === undefined) continue;
        const oldVal = (existing as Record<string, unknown>)[field];
        const oldStr = oldVal === null || oldVal === undefined ? null : String(oldVal);
        const newStr = newVal === null || newVal === undefined ? null : String(newVal);
        if (oldStr !== newStr) {
          auditEntries.push({ befiterId, appName, fieldChanged: field, oldValue: oldStr, newValue: newStr });
          adminLogEntries.push({ action: "identity.update", befiterId, adminUsername, fieldChanged: field, oldValue: oldStr, newValue: newStr });
        }
      }

      if (auditEntries.length > 0) {
        await tx.insert(identityUpdates).values(auditEntries);
        await tx.insert(adminAuditLog).values(adminLogEntries);
      }

      await tx.update(befiterIds)
        .set({ ...updateData, updatedAt: new Date() })
        .where(eq(befiterIds.id, befiterId));

      const [identityRow] = await tx.select().from(befiterIds).where(eq(befiterIds.id, befiterId)).limit(1);
      const links = await tx.select().from(appLinks).where(eq(appLinks.befiterId, befiterId));
      return serializeIdentity({ ...identityRow, appLinks: links });
    });
  }

  async getIdentity(befiterId: string): Promise<SerializedBefiterIdWithLinks | undefined> {
    const [identity] = await db.select().from(befiterIds).where(eq(befiterIds.id, befiterId)).limit(1);
    if (!identity) return undefined;
    const links = await db.select().from(appLinks).where(eq(appLinks.befiterId, befiterId));
    return serializeIdentity({ ...identity, appLinks: links });
  }

  async linkApp(befiterId: string, appName: string, appUserId: string): Promise<AppLink> {
    return await db.transaction(async (tx) => {
      const [link] = await tx.insert(appLinks).values({ befiterId, appName, appUserId }).returning();
      const [identityRow] = await tx.select().from(befiterIds).where(eq(befiterIds.id, befiterId)).limit(1);
      const links = await tx.select().from(appLinks).where(eq(appLinks.befiterId, befiterId));
      const identity = serializeIdentity({ ...identityRow, appLinks: links });
      await insertWebhookEventsTx(tx, "identity.app_linked", {
        source_app: appName,
        app_name: appName,
        app_user_id: appUserId,
        identity,
      });
      return link;
    });
  }

  async logAuditEntries(entries: { befiterId: string; appName: string; fieldChanged: string; oldValue: string | null; newValue: string | null }[]): Promise<void> {
    if (entries.length === 0) return;
    await db.insert(identityUpdates).values(entries);
  }

  async getAuditLog(befiterId: string): Promise<IdentityUpdate[]> {
    return db.select().from(identityUpdates)
      .where(eq(identityUpdates.befiterId, befiterId))
      .orderBy(sql`${identityUpdates.changedAt} DESC`);
  }

  async incrementDuplicatePrevention(): Promise<void> {
    await db.insert(stats).values({ key: "duplicate_prevention_count", value: 1 })
      .onConflictDoUpdate({
        target: stats.key,
        set: { value: sql`${stats.value} + 1` },
      });
  }

  async getDashboardStats(): Promise<DashboardStats> {
    const [totalResult] = await db.select({ count: sql<number>`count(*)::int` }).from(befiterIds);

    const now = new Date();
    const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const [monthResult] = await db.select({ count: sql<number>`count(*)::int` })
      .from(befiterIds)
      .where(sql`${befiterIds.createdAt} >= ${firstOfMonth}`);

    const appBreakdown = await db.select({
      appName: appLinks.appName,
      count: sql<number>`count(*)::int`,
    }).from(appLinks).groupBy(appLinks.appName);

    const [dupStat] = await db.select().from(stats).where(eq(stats.key, "duplicate_prevention_count")).limit(1);

    const [leadsTotal] = await db.select({ count: sql<number>`count(*)::int` }).from(leads);
    const [leadsMonth] = await db.select({ count: sql<number>`count(*)::int` })
      .from(leads).where(sql`${leads.createdAt} >= ${firstOfMonth}`);
    const leadsByStatus = await db.select({
      status: leads.leadStatus,
      count: sql<number>`count(*)::int`,
    }).from(leads).groupBy(leads.leadStatus);
    const [followUps] = await db.select({ count: sql<number>`count(*)::int` })
      .from(leads).where(sql`${leads.followUpDate} IS NOT NULL
        AND ${leads.followUpDate} <> ''
        AND ${leads.followUpDate} ~ '^\\d{4}-\\d{2}-\\d{2}'
        AND substring(${leads.followUpDate} from 1 for 10)::date <= current_date
        AND ${leads.leadStatus} NOT IN ('converted','lost')`);

    const [whPending] = await db.select({ count: sql<number>`count(*)::int` })
      .from(webhookEvents).where(eq(webhookEvents.status, "pending"));
    const [whDead] = await db.select({ count: sql<number>`count(*)::int` })
      .from(webhookEvents).where(eq(webhookEvents.status, "dead"));
    const [whDelivered] = await db.select({ count: sql<number>`count(*)::int` })
      .from(webhookEvents).where(sql`${webhookEvents.status} = 'success' AND ${webhookEvents.deliveredAt} >= now() - interval '24 hours'`);

    return {
      totalIds: totalResult.count,
      thisMonth: monthResult.count,
      appBreakdown: appBreakdown.map(r => ({ appName: r.appName, count: r.count })),
      duplicatePrevention: dupStat?.value ?? 0,
      leads: {
        total: leadsTotal.count,
        thisMonth: leadsMonth.count,
        byStatus: leadsByStatus.map(r => ({ status: r.status, count: r.count })),
        followUpsDue: followUps.count,
      },
      webhooks: {
        pending: whPending.count,
        dead: whDead.count,
        deliveredLast24h: whDelivered.count,
      },
    };
  }

  async getMetrics(): Promise<MetricsData> {
    const identitiesPerDay = await db.execute(sql`
      SELECT to_char(d::date, 'YYYY-MM-DD') AS day,
             COALESCE((SELECT COUNT(*)::int FROM ${befiterIds}
                       WHERE ${befiterIds.createdAt}::date = d::date), 0) AS count
      FROM generate_series(current_date - interval '29 days', current_date, interval '1 day') d
      ORDER BY day ASC
    `);

    const leadsPerDay = await db.execute(sql`
      SELECT to_char(d::date, 'YYYY-MM-DD') AS day,
             COALESCE((SELECT COUNT(*)::int FROM ${leads}
                       WHERE ${leads.createdAt}::date = d::date), 0) AS count
      FROM generate_series(current_date - interval '29 days', current_date, interval '1 day') d
      ORDER BY day ASC
    `);

    const webhooksPerDay = await db.execute(sql`
      SELECT to_char(d::date, 'YYYY-MM-DD') AS day,
             COALESCE((SELECT COUNT(*)::int FROM ${webhookEvents}
                       WHERE ${webhookEvents.deliveredAt}::date = d::date
                         AND ${webhookEvents.status} = 'success'), 0) AS success,
             COALESCE((SELECT COUNT(*)::int FROM ${webhookEvents}
                       WHERE COALESCE(${webhookEvents.deliveredAt}, ${webhookEvents.createdAt})::date = d::date
                         AND ${webhookEvents.status} = 'dead'), 0) AS dead
      FROM generate_series(current_date - interval '13 days', current_date, interval '1 day') d
      ORDER BY day ASC
    `);

    const leadStatusBreakdown = await db.select({
      status: leads.leadStatus,
      count: sql<number>`count(*)::int`,
    }).from(leads).groupBy(leads.leadStatus);

    const [convStats] = await db.select({
      total: sql<number>`count(*)::int`,
      converted: sql<number>`count(*) filter (where ${leads.leadStatus} = 'converted')::int`,
      lost: sql<number>`count(*) filter (where ${leads.leadStatus} = 'lost')::int`,
    }).from(leads);

    const closed = (convStats?.converted ?? 0) + (convStats?.lost ?? 0);
    const conversionRate = closed > 0 ? Math.round((convStats.converted / closed) * 1000) / 10 : 0;

    const [whTotals] = await db.select({
      total: sql<number>`count(*)::int`,
      success: sql<number>`count(*) filter (where ${webhookEvents.status} = 'success')::int`,
      dead: sql<number>`count(*) filter (where ${webhookEvents.status} = 'dead')::int`,
    }).from(webhookEvents);

    const finalised = (whTotals?.success ?? 0) + (whTotals?.dead ?? 0);
    const webhookSuccessRate = finalised > 0 ? Math.round((whTotals.success / finalised) * 1000) / 10 : 100;

    const toRows = (r: any): any[] => Array.isArray(r) ? r : (r?.rows ?? []);

    return {
      identitiesPerDay: toRows(identitiesPerDay).map((r: any) => ({ day: r.day, count: Number(r.count) })),
      leadsPerDay: toRows(leadsPerDay).map((r: any) => ({ day: r.day, count: Number(r.count) })),
      webhooksPerDay: toRows(webhooksPerDay).map((r: any) => ({
        day: r.day,
        success: Number(r.success),
        dead: Number(r.dead),
      })),
      leadStatusBreakdown: leadStatusBreakdown.map(r => ({ status: r.status, count: r.count })),
      leadConversionRate: conversionRate,
      leadsTotal: convStats?.total ?? 0,
      leadsConverted: convStats?.converted ?? 0,
      leadsLost: convStats?.lost ?? 0,
      webhookSuccessRate,
      webhookTotal: whTotals?.total ?? 0,
    };
  }

  async getLeadById(id: string): Promise<Lead | undefined> {
    const [row] = await db.select().from(leads).where(eq(leads.id, id)).limit(1);
    return row;
  }

  async searchIdentities(query: string, page: number, limit: number): Promise<{ results: SerializedBefiterIdWithLinks[]; total: number }> {
    const offset = (page - 1) * limit;

    const whereClause = query
      ? or(
          ilike(befiterIds.fullName, `%${query}%`),
          ilike(befiterIds.email, `%${query}%`),
          ilike(befiterIds.currentPhone, `%${query}%`),
        )
      : undefined;

    const [totalResult] = await db.select({ count: sql<number>`count(*)::int` })
      .from(befiterIds)
      .where(whereClause);

    const rows = whereClause
      ? await db.select().from(befiterIds).where(whereClause).limit(limit).offset(offset).orderBy(sql`${befiterIds.createdAt} DESC`)
      : await db.select().from(befiterIds).limit(limit).offset(offset).orderBy(sql`${befiterIds.createdAt} DESC`);

    const results: SerializedBefiterIdWithLinks[] = await Promise.all(
      rows.map(async (row) => {
        const links = await db.select().from(appLinks).where(eq(appLinks.befiterId, row.id));
        return serializeIdentity({ ...row, appLinks: links });
      })
    );

    return { results, total: totalResult.count };
  }

  async getAllApiKeys(): Promise<Omit<ApiKey, "keyHash">[]> {
    const keys = await db.select().from(apiKeys).orderBy(sql`${apiKeys.createdAt} DESC`);
    return keys.map(({ keyHash, ...rest }) => rest);
  }

  async getApiKeyByPrefix(prefix: string): Promise<ApiKey | undefined> {
    const [result] = await db.select().from(apiKeys)
      .where(and(eq(apiKeys.keyPrefix, prefix), eq(apiKeys.isActive, true)))
      .limit(1);
    return result;
  }

  async createApiKey(appName: string, keyHash: string, keyPrefix: string): Promise<ApiKey> {
    const [key] = await db.insert(apiKeys).values({ appName, keyHash, keyPrefix }).returning();
    return key;
  }

  async updateApiKeyStatus(id: string, isActive: boolean): Promise<ApiKey> {
    const [updated] = await db.update(apiKeys).set({ isActive }).where(eq(apiKeys.id, id)).returning();
    return updated;
  }

  async deleteApiKey(id: string): Promise<void> {
    await db.delete(apiKeys).where(eq(apiKeys.id, id));
  }

  async deleteIdentity(befiterId: string, adminUsername: string): Promise<void> {
    await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(befiterIds).where(eq(befiterIds.id, befiterId)).limit(1);

      // Archive the full mutation history to admin_audit_log before deletion
      // so per-field change records survive even after identity_updates rows are removed
      const history = await tx.select().from(identityUpdates).where(eq(identityUpdates.befiterId, befiterId));
      const archiveRows = history.map(row => ({
        action: "identity.history" as const,
        befiterId,
        adminUsername,
        fieldChanged: row.fieldChanged,
        oldValue: row.oldValue,
        newValue: row.newValue,
        occurredAt: row.changedAt ?? undefined,
      }));

      // Add a tombstone entry recording who deleted the identity and when
      archiveRows.push({
        action: "identity.delete",
        befiterId,
        adminUsername,
        fieldChanged: null,
        oldValue: existing
          ? JSON.stringify({ fullName: existing.fullName, email: existing.email, currentPhone: existing.currentPhone })
          : null,
        newValue: null,
        occurredAt: undefined,
      });

      await tx.insert(adminAuditLog).values(archiveRows);

      await tx.delete(identityUpdates).where(eq(identityUpdates.befiterId, befiterId));
      await tx.delete(appLinks).where(eq(appLinks.befiterId, befiterId));
      await tx.delete(befiterIds).where(eq(befiterIds.id, befiterId));
    });
  }

  async isAppLinked(befiterId: string, appName: string): Promise<boolean> {
    const [link] = await db.select().from(appLinks)
      .where(and(eq(appLinks.befiterId, befiterId), eq(appLinks.appName, appName)))
      .limit(1);
    return !!link;
  }

  async createLead(data: InsertLead, appName: string): Promise<Lead> {
    const [lead] = await db.insert(leads).values({ ...data, appName }).returning();
    return lead;
  }

  async patchLead(id: string, data: PatchLead, appName: string): Promise<Lead> {
    const [existing] = await db.select().from(leads)
      .where(and(eq(leads.id, id), eq(leads.appName, appName)))
      .limit(1);
    if (!existing) throw new LeadNotFoundError();
    const { appName: _stripped, ...safeData } = data as PatchLead & { appName?: unknown };
    const [updated] = await db.update(leads)
      .set({ ...safeData, updatedAt: new Date() })
      .where(eq(leads.id, id))
      .returning();
    return updated;
  }

  async getLeadByStoreId(storeLeadId: string, appName: string): Promise<Lead | undefined> {
    const [result] = await db.select().from(leads)
      .where(and(eq(leads.storeLeadId, storeLeadId), eq(leads.appName, appName)))
      .limit(1);
    return result;
  }

  async lookupByAppUserId(appName: string, appUserId: string): Promise<SerializedBefiterIdWithLinks | undefined> {
    const [link] = await db.select().from(appLinks)
      .where(and(eq(appLinks.appName, appName), eq(appLinks.appUserId, appUserId)))
      .limit(1);
    if (!link) return undefined;
    return this.getIdentity(link.befiterId);
  }

  async searchLeads(query: string, page: number, limit: number, status?: string): Promise<{ results: Lead[]; total: number }> {
    const offset = (page - 1) * limit;
    const searchClause = query
      ? or(
          ilike(leads.fullName, `%${query}%`),
          ilike(leads.phone, `%${query}%`),
          ilike(leads.email, `%${query}%`),
        )
      : undefined;
    const statusClause = status ? eq(leads.leadStatus, status) : undefined;
    const whereClause = searchClause && statusClause
      ? and(searchClause, statusClause)
      : (searchClause ?? statusClause);

    const [totalResult] = await db.select({ count: sql<number>`count(*)::int` })
      .from(leads)
      .where(whereClause);

    const results = whereClause
      ? await db.select().from(leads).where(whereClause).limit(limit).offset(offset).orderBy(sql`${leads.createdAt} DESC`)
      : await db.select().from(leads).limit(limit).offset(offset).orderBy(sql`${leads.createdAt} DESC`);

    return { results, total: totalResult.count };
  }

  async createWebhookEvent(data: { eventId: string; eventType: string; destination: WebhookDestination; payload: string }): Promise<WebhookEvent> {
    const [row] = await db.insert(webhookEvents).values({
      eventId: data.eventId,
      eventType: data.eventType,
      destination: data.destination,
      payload: data.payload,
    }).returning();
    return row;
  }

  async claimPendingWebhookEvents(limit: number): Promise<WebhookEvent[]> {
    // Atomic claim: SELECT ... FOR UPDATE SKIP LOCKED inside a transaction prevents
    // duplicate delivery if more than one worker process is ever running. We also
    // push next_attempt_at out by 5 minutes as a safety net so a crashed worker's
    // events are eventually retried by another worker.
    return await db.transaction(async (tx) => {
      const result: { rows: WebhookEvent[] } = await tx.execute(sql`
        SELECT id, event_id as "eventId", event_type as "eventType",
               destination, payload, status, attempts, last_error as "lastError",
               next_attempt_at as "nextAttemptAt", delivered_at as "deliveredAt",
               created_at as "createdAt", updated_at as "updatedAt"
        FROM webhook_events
        WHERE status = 'pending' AND next_attempt_at <= now()
        ORDER BY next_attempt_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      `) as unknown as { rows: WebhookEvent[] };
      const rows = result.rows ?? [];
      if (rows.length === 0) return [];
      const ids = rows.map(r => r.id);
      await tx.update(webhookEvents)
        .set({ nextAttemptAt: sql`now() + interval '5 minutes'`, updatedAt: new Date() })
        .where(inArray(webhookEvents.id, ids));
      return rows;
    });
  }

  async markWebhookDelivered(id: string): Promise<void> {
    await db.update(webhookEvents).set({
      status: "success",
      deliveredAt: new Date(),
      updatedAt: new Date(),
      lastError: null,
    }).where(eq(webhookEvents.id, id));
  }

  async markWebhookFailed(id: string, errorMsg: string, nextAttemptAt: Date | null): Promise<void> {
    await db.update(webhookEvents).set({
      status: "pending",
      attempts: sql`${webhookEvents.attempts} + 1`,
      lastError: errorMsg,
      nextAttemptAt: nextAttemptAt ?? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      updatedAt: new Date(),
    }).where(eq(webhookEvents.id, id));
  }

  async markWebhookDead(id: string, errorMsg: string): Promise<void> {
    await db.update(webhookEvents).set({
      status: "dead",
      attempts: sql`${webhookEvents.attempts} + 1`,
      lastError: errorMsg,
      updatedAt: new Date(),
    }).where(eq(webhookEvents.id, id));
  }

  async requeueWebhookEvent(id: string): Promise<void> {
    await db.update(webhookEvents).set({
      status: "pending",
      nextAttemptAt: new Date(),
      attempts: 0,
      lastError: null,
      updatedAt: new Date(),
    }).where(eq(webhookEvents.id, id));
  }

  async listWebhookEvents(status: string | undefined, limit: number): Promise<WebhookEvent[]> {
    const where = status ? eq(webhookEvents.status, status) : undefined;
    const q = where ? db.select().from(webhookEvents).where(where) : db.select().from(webhookEvents);
    return q.orderBy(desc(webhookEvents.createdAt)).limit(limit);
  }
}

export const storage = new DatabaseStorage();
