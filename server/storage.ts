import { eq, ilike, or, and, sql } from "drizzle-orm";
import { db } from "./db";
import {
  befiterIds, appLinks, apiKeys, identityUpdates, stats,
  type BefiterId, type InsertBefiterId, type UpdateBefiterId,
  type AppLink, type ApiKey, type IdentityUpdate, type BefiterIdWithLinks,
} from "@shared/schema";

export interface DashboardStats {
  totalIds: number;
  thisMonth: number;
  appBreakdown: { appName: string; count: number }[];
  duplicatePrevention: number;
}

export interface CreateOrUpdateResult {
  identity: BefiterIdWithLinks;
  created: boolean;
}

export interface IStorage {
  lookupByCurrentPhone(phone: string): Promise<BefiterId | undefined>;
  lookupByEmail(email: string): Promise<BefiterId | undefined>;
  createOrUpdateIdentity(data: InsertBefiterId, appName: string, appUserId: string): Promise<CreateOrUpdateResult>;
  updateIdentity(befiterId: string, data: UpdateBefiterId, appName: string): Promise<BefiterId>;
  adminUpdateIdentity(befiterId: string, data: Partial<BefiterId>): Promise<BefiterId>;
  getIdentity(befiterId: string): Promise<BefiterIdWithLinks | undefined>;
  linkApp(befiterId: string, appName: string, appUserId: string): Promise<AppLink>;
  logAuditEntries(entries: { befiterId: string; appName: string; fieldChanged: string; oldValue: string | null; newValue: string | null }[]): Promise<void>;
  getAuditLog(befiterId: string): Promise<IdentityUpdate[]>;
  incrementDuplicatePrevention(): Promise<void>;
  getDashboardStats(): Promise<DashboardStats>;
  searchIdentities(query: string, page: number, limit: number): Promise<{ results: BefiterIdWithLinks[]; total: number }>;
  getAllApiKeys(): Promise<Omit<ApiKey, "keyHash">[]>;
  getApiKeyByPrefix(prefix: string): Promise<ApiKey | undefined>;
  createApiKey(appName: string, keyHash: string, keyPrefix: string): Promise<ApiKey>;
  updateApiKeyStatus(id: string, isActive: boolean): Promise<ApiKey>;
  deleteApiKey(id: string): Promise<void>;
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

  private async getIdentityWithLinks(befiterId: string): Promise<BefiterIdWithLinks> {
    const [identity] = await db.select().from(befiterIds).where(eq(befiterIds.id, befiterId)).limit(1);
    const links = await db.select().from(appLinks).where(eq(appLinks.befiterId, befiterId));
    return { ...identity, appLinks: links };
  }

  private async ensureAppLink(befiterId: string, appName: string, appUserId: string): Promise<void> {
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

  async updateIdentity(befiterId: string, data: UpdateBefiterId, appName: string): Promise<BefiterId> {
    const [existing] = await db.select().from(befiterIds).where(eq(befiterIds.id, befiterId)).limit(1);
    if (!existing) throw new Error("Identity not found");

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

    const [updated] = await db.update(befiterIds)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(befiterIds.id, befiterId))
      .returning();

    return updated;
  }

  async adminUpdateIdentity(befiterId: string, data: Partial<BefiterId>): Promise<BefiterId> {
    const { id, createdAt, identityTag, previousPhones, ...updateData } = data as BefiterId;
    const [updated] = await db.update(befiterIds)
      .set({ ...updateData, updatedAt: new Date() })
      .where(eq(befiterIds.id, befiterId))
      .returning();
    return updated;
  }

  async getIdentity(befiterId: string): Promise<BefiterIdWithLinks | undefined> {
    const [identity] = await db.select().from(befiterIds).where(eq(befiterIds.id, befiterId)).limit(1);
    if (!identity) return undefined;
    const links = await db.select().from(appLinks).where(eq(appLinks.befiterId, befiterId));
    return { ...identity, appLinks: links };
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

  async searchIdentities(query: string, page: number, limit: number): Promise<{ results: BefiterIdWithLinks[]; total: number }> {
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

    const results: BefiterIdWithLinks[] = await Promise.all(
      rows.map(async (row) => {
        const links = await db.select().from(appLinks).where(eq(appLinks.befiterId, row.id));
        return { ...row, appLinks: links };
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
}

export const storage = new DatabaseStorage();
