import { eq, ilike, or, and, sql, lte, desc, inArray } from "drizzle-orm";
import { randomUUID } from "crypto";
import { db } from "./db";
import {
  befiterIds, appLinks, apiKeys, identityUpdates, stats, leads, webhookEvents,
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

export function serializeIdentity(identity: BefiterId): SerializedBefiterId;
export function serializeIdentity(identity: BefiterIdWithLinks): SerializedBefiterIdWithLinks;
export function serializeIdentity(identity: BefiterId | BefiterIdWithLinks): SerializedBefiterId | SerializedBefiterIdWithLinks {
  return {
    ...identity,
    height: identity.height != null ? Number(identity.height) : null,
    weight: identity.weight != null ? Number(identity.weight) : null,
  };
}

export interface IStorage {
  lookupByCurrentPhone(phone: string): Promise<BefiterId | undefined>;
  lookupByEmail(email: string): Promise<BefiterId | undefined>;
  createOrUpdateIdentity(data: InsertBefiterId, appName: string, appUserId: string): Promise<CreateOrUpdateResult>;
  updateIdentity(befiterId: string, data: UpdateBefiterId, appName: string): Promise<SerializedBefiterIdWithLinks>;
  patchIdentity(befiterId: string, data: PatchBefiterId, appName: string): Promise<SerializedBefiterIdWithLinks>;
  adminUpdateIdentity(befiterId: string, data: Partial<BefiterId>): Promise<SerializedBefiterIdWithLinks>;
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
  deleteIdentity(befiterId: string): Promise<void>;
  createLead(data: InsertLead): Promise<Lead>;
  patchLead(id: string, data: PatchLead): Promise<Lead>;
  getLeadByStoreId(storeLeadId: string): Promise<Lead | undefined>;
  searchLeads(query: string, page: number, limit: number): Promise<{ results: Lead[]; total: number }>;
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

  async createOrUpdateIdentity(data: InsertBefiterId, appName: string, appUserId: string): Promise<CreateOrUpdateResult> {
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
          await tx.insert(appLinks).values({ befiterId: existingByEmail.id, appName, appUserId });
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
      }).returning();

      await tx.insert(appLinks).values({ befiterId: newIdentity.id, appName, appUserId });
      const links = await tx.select().from(appLinks).where(eq(appLinks.befiterId, newIdentity.id));
      const identity = serializeIdentity({ ...newIdentity, appLinks: links });
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

  async patchIdentity(befiterId: string, data: PatchBefiterId, appName: string): Promise<SerializedBefiterIdWithLinks> {
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

    dbUpdate.updatedAt = new Date();
    await tx.update(befiterIds)
      .set(dbUpdate)
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

  async adminUpdateIdentity(befiterId: string, data: Partial<BefiterId>): Promise<SerializedBefiterIdWithLinks> {
    const { id, createdAt, identityTag, previousPhones, ...updateData } = data as BefiterId;
    await db.update(befiterIds)
      .set({ ...updateData, updatedAt: new Date() })
      .where(eq(befiterIds.id, befiterId));
    return this.getIdentityWithLinks(befiterId);
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

    return {
      totalIds: totalResult.count,
      thisMonth: monthResult.count,
      appBreakdown: appBreakdown.map(r => ({ appName: r.appName, count: r.count })),
      duplicatePrevention: dupStat?.value ?? 0,
    };
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

  async deleteIdentity(befiterId: string): Promise<void> {
    await db.delete(identityUpdates).where(eq(identityUpdates.befiterId, befiterId));
    await db.delete(appLinks).where(eq(appLinks.befiterId, befiterId));
    await db.delete(befiterIds).where(eq(befiterIds.id, befiterId));
  }

  async createLead(data: InsertLead): Promise<Lead> {
    const [lead] = await db.insert(leads).values(data).returning();
    return lead;
  }

  async patchLead(id: string, data: PatchLead): Promise<Lead> {
    const [existing] = await db.select().from(leads).where(eq(leads.id, id)).limit(1);
    if (!existing) throw new LeadNotFoundError();
    const [updated] = await db.update(leads)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(leads.id, id))
      .returning();
    return updated;
  }

  async getLeadByStoreId(storeLeadId: string): Promise<Lead | undefined> {
    const [result] = await db.select().from(leads)
      .where(eq(leads.storeLeadId, storeLeadId))
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

  async searchLeads(query: string, page: number, limit: number): Promise<{ results: Lead[]; total: number }> {
    const offset = (page - 1) * limit;
    const whereClause = query
      ? or(
          ilike(leads.fullName, `%${query}%`),
          ilike(leads.phone, `%${query}%`),
          ilike(leads.email, `%${query}%`),
        )
      : undefined;

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
