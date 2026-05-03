import { eq, ilike, or, and, sql } from "drizzle-orm";
import { db } from "./db";
import {
  befiterIds, appLinks, apiKeys, identityUpdates, stats, leads,
  type BefiterId, type InsertBefiterId, type UpdateBefiterId, type PatchBefiterId,
  type AppLink, type ApiKey, type IdentityUpdate, type BefiterIdWithLinks,
  type Lead, type InsertLead, type PatchLead,
} from "@shared/schema";

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
    const existingByEmail = await this.lookupByEmail(data.email);

    if (existingByEmail) {
      const samePhone = existingByEmail.currentPhone === data.currentPhone;

      if (!samePhone) {
        const oldPhone = existingByEmail.currentPhone;
        await db.update(befiterIds)
          .set({
            currentPhone: data.currentPhone,
            previousPhones: sql`array_append(${befiterIds.previousPhones}, ${oldPhone}::text)`,
            updatedAt: new Date(),
          })
          .where(eq(befiterIds.id, existingByEmail.id));

        await this.logAuditEntries([
          {
            befiterId: existingByEmail.id,
            appName,
            fieldChanged: "currentPhone",
            oldValue: oldPhone,
            newValue: data.currentPhone,
          },
          {
            befiterId: existingByEmail.id,
            appName,
            fieldChanged: "previousPhones",
            oldValue: JSON.stringify(existingByEmail.previousPhones ?? []),
            newValue: JSON.stringify([...(existingByEmail.previousPhones ?? []), oldPhone]),
          },
        ]);
      }

      await this.ensureAppLink(existingByEmail.id, appName, appUserId);
      const identity = await this.getIdentityWithLinks(existingByEmail.id);
      return { identity, created: false };
    }

    const [identity] = await db.insert(befiterIds).values({
      ...data,
      email: data.email.toLowerCase(),
      previousPhones: [],
      identityTag: "member",
    }).returning();

    await db.insert(appLinks).values({ befiterId: identity.id, appName, appUserId });
    const identityWithLinks = await this.getIdentityWithLinks(identity.id);
    return { identity: identityWithLinks, created: true };
  }

  async updateIdentity(befiterId: string, data: UpdateBefiterId, appName: string): Promise<SerializedBefiterIdWithLinks> {
    const [existing] = await db.select().from(befiterIds).where(eq(befiterIds.id, befiterId)).limit(1);
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
      await this.logAuditEntries(auditEntries);
    }

    await db.update(befiterIds)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(befiterIds.id, befiterId));

    return this.getIdentityWithLinks(befiterId);
  }

  async patchIdentity(befiterId: string, data: PatchBefiterId, appName: string): Promise<SerializedBefiterIdWithLinks> {
    const [existing] = await db.select().from(befiterIds).where(eq(befiterIds.id, befiterId)).limit(1);
    if (!existing) throw new IdentityNotFoundError();

    if (data.email && data.email.toLowerCase() !== existing.email) {
      const taken = await this.lookupByEmail(data.email);
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

    if (auditEntries.length > 0) await this.logAuditEntries(auditEntries);

    dbUpdate.updatedAt = new Date();
    await db.update(befiterIds)
      .set(dbUpdate)
      .where(eq(befiterIds.id, befiterId));

    return this.getIdentityWithLinks(befiterId);
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
    const [link] = await db.insert(appLinks).values({ befiterId, appName, appUserId }).returning();
    return link;
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
}

export const storage = new DatabaseStorage();
