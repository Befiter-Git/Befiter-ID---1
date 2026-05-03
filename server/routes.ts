import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import { storage, EmailTakenError, IdentityNotFoundError, LeadNotFoundError } from "./storage";
import { retryWebhookNow, isChannelConfigured } from "./webhook-publisher";
import { apiKeyAuth } from "./auth";
import { requireAdminSession, sessionMiddleware } from "./admin-auth";
import { readRateLimiter, writeRateLimiter, adminLoginLimiter, apiError } from "./security";
import { normalisePhone } from "./phone-utils";
import { insertBefiterIdSchema, updateBefiterIdSchema, patchBefiterIdSchema, upsertBefiterIdSchema, insertLeadSchema, patchLeadSchema } from "@shared/schema";

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  app.use(sessionMiddleware);

  // ─── Admin Auth Routes ────────────────────────────────────────────────────

  app.post("/admin/login", adminLoginLimiter, async (req: Request, res: Response) => {
    const { username, password } = req.body ?? {};
    const adminUsername = process.env.ADMIN_USERNAME || "admin";
    const adminPassword = process.env.ADMIN_PASSWORD || "admin123";

    if (username === adminUsername && password === adminPassword) {
      req.session.adminLoggedIn = true;
      req.session.adminUsername = username;
      return res.json({ success: true });
    }
    return apiError(res, 401, "UNAUTHORIZED", "Invalid username or password");
  });

  app.post("/admin/logout", (req: Request, res: Response) => {
    req.session.destroy(() => {
      res.json({ success: true });
    });
  });

  app.get("/admin/me", (req: Request, res: Response) => {
    if (req.session?.adminLoggedIn) {
      return res.json({ loggedIn: true, username: req.session.adminUsername });
    }
    return res.status(401).json({ loggedIn: false });
  });

  // ─── Admin Data Routes ────────────────────────────────────────────────────

  app.get("/admin/stats", requireAdminSession, async (_req: Request, res: Response) => {
    try {
      const stats = await storage.getDashboardStats();
      return res.json(stats);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Failed to fetch stats" });
    }
  });

  app.get("/admin/identities", requireAdminSession, async (req: Request, res: Response, next) => {
    if ((req.headers["accept"] || "").startsWith("text/html")) return next();
    try {
      const query = (req.query.q as string) || "";
      const page = parseInt((req.query.page as string) || "1", 10);
      const limit = parseInt((req.query.limit as string) || "50", 10);
      const result = await storage.searchIdentities(query, page, limit);
      return res.json(result);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Failed to search identities" });
    }
  });

  app.get("/admin/identity/:befiterId", requireAdminSession, async (req: Request, res: Response, next) => {
    if ((req.headers["accept"] || "").startsWith("text/html")) return next();
    try {
      const identity = await storage.getIdentity(req.params.befiterId);
      if (!identity) return res.status(404).json({ error: "Identity not found" });
      return res.json({ identity });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Failed to fetch identity" });
    }
  });

  app.put("/admin/identity/:befiterId", requireAdminSession, async (req: Request, res: Response) => {
    try {
      const existing = await storage.getIdentity(req.params.befiterId);
      if (!existing) return res.status(404).json({ error: "Identity not found" });
      const updated = await storage.adminUpdateIdentity(req.params.befiterId, req.body);
      return res.json({ identity: updated });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Failed to update identity" });
    }
  });

  app.delete("/admin/identity/:befiterId", requireAdminSession, async (req: Request, res: Response) => {
    try {
      const existing = await storage.getIdentity(req.params.befiterId);
      if (!existing) return res.status(404).json({ error: "Identity not found" });
      await storage.deleteIdentity(req.params.befiterId);
      return res.json({ success: true });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Failed to delete identity" });
    }
  });

  app.get("/admin/audit/:befiterId", requireAdminSession, async (req: Request, res: Response) => {
    try {
      const log = await storage.getAuditLog(req.params.befiterId);
      return res.json({ log });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Failed to fetch audit log" });
    }
  });

  app.get("/admin/api-keys", requireAdminSession, async (req: Request, res: Response, next) => {
    if ((req.headers["accept"] || "").startsWith("text/html")) return next();
    try {
      const keys = await storage.getAllApiKeys();
      return res.json({ keys });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Failed to fetch API keys" });
    }
  });

  app.post("/admin/api-keys", requireAdminSession, async (req: Request, res: Response) => {
    try {
      const { appName } = req.body;
      if (!appName || typeof appName !== "string" || !appName.trim()) {
        return res.status(400).json({ error: "appName is required" });
      }

      const rawKey = "befiter_" + randomBytes(24).toString("base64url").slice(0, 24);
      const keyPrefix = rawKey.slice(0, 10);
      const keyHash = await bcrypt.hash(rawKey, 10);

      const key = await storage.createApiKey(appName.trim(), keyHash, keyPrefix);
      const { keyHash: _, ...keyWithoutHash } = key;

      return res.status(201).json({ key: keyWithoutHash, rawKey });
    } catch (err: any) {
      if (err?.code === "23505") {
        return res.status(409).json({ error: "An API key for this app already exists" });
      }
      console.error(err);
      return res.status(500).json({ error: "Failed to create API key" });
    }
  });

  app.patch("/admin/api-keys/:id", requireAdminSession, async (req: Request, res: Response) => {
    try {
      const { isActive } = req.body;
      if (typeof isActive !== "boolean") {
        return res.status(400).json({ error: "isActive (boolean) is required" });
      }
      const updated = await storage.updateApiKeyStatus(req.params.id, isActive);
      const { keyHash: _, ...keyWithoutHash } = updated;
      return res.json({ key: keyWithoutHash });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Failed to update API key" });
    }
  });

  app.delete("/admin/api-keys/:id", requireAdminSession, async (req: Request, res: Response) => {
    try {
      await storage.deleteApiKey(req.params.id);
      return res.json({ success: true });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Failed to delete API key" });
    }
  });

  // ─── Public API Identity Routes ───────────────────────────────────────────

  // Lookup: email first (verified via OTP), then phone (unverified — pre-fill only)
  app.get("/api/identity/lookup", apiKeyAuth, readRateLimiter, async (req: Request, res: Response) => {
    try {
      const { phone, email } = req.query as { phone?: string; email?: string };

      if (!phone && !email) {
        return res.status(400).json({ error: "At least one of phone or email is required" });
      }

      let identity = undefined;
      let matchedBy: "email" | "phone" | undefined;

      // Email is searched FIRST — it is the verified login identifier (email OTP)
      if (email) {
        identity = await storage.lookupByEmail(email);
        if (identity) matchedBy = "email";
      }

      // Phone is searched SECOND only if email did not find anything
      // Phone is unverified — result should be used for pre-fill only, not as confirmed identity
      if (!identity && phone) {
        const normalised = normalisePhone(phone);
        identity = await storage.lookupByCurrentPhone(normalised);
        if (identity) matchedBy = "phone";
      }

      if (identity) {
        await storage.incrementDuplicatePrevention();
        const fullIdentity = await storage.getIdentity(identity.id);
        return res.json({ found: true, matched_by: matchedBy, identity: fullIdentity });
      }

      return res.json({ found: false });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Lookup failed" });
    }
  });

  // Create: smart upsert by email
  // Email exists + same phone   → return existing, link app (200)
  // Email exists + diff phone   → update current_phone, move old to previous_phones, link app (200)
  // Email not found             → create new identity (201)
  // Phone uniqueness is NOT enforced — phone numbers can be recycled by operators
  app.post("/api/identity/create", apiKeyAuth, writeRateLimiter, async (req: Request, res: Response) => {
    try {
      const body = { ...req.body };
      // Accept both `phone` and `currentPhone` in request body for ease of integration
      if (body.phone && !body.currentPhone) {
        body.currentPhone = body.phone;
      }
      delete body.phone;

      const parseResult = insertBefiterIdSchema.safeParse(body);
      if (!parseResult.success) {
        return res.status(400).json({ error: "Validation failed", details: parseResult.error.flatten() });
      }

      const data = parseResult.data;
      data.currentPhone = normalisePhone(data.currentPhone);

      const { appUserId } = req.body;
      if (!appUserId) {
        return res.status(400).json({ error: "appUserId is required" });
      }

      const result = await storage.createOrUpdateIdentity(data, req.appName!, appUserId);

      if (result.created) {
        return res.status(201).json({ identity: result.identity });
      } else {
        return res.status(200).json({ identity: result.identity });
      }
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Failed to create identity" });
    }
  });

  app.put("/api/identity/upsert", apiKeyAuth, writeRateLimiter, async (req: Request, res: Response) => {
    try {
      const parseResult = upsertBefiterIdSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ error: "Validation failed", details: parseResult.error.flatten() });
      }

      const { appUserId, ...profileData } = parseResult.data;
      const appName = req.appName!;
      const normalisedProfileData = profileData.phone
        ? { ...profileData, phone: normalisePhone(profileData.phone) }
        : profileData;

      const byAppUserId = await storage.lookupByAppUserId(appName, appUserId);
      if (byAppUserId) {
        if (Object.keys(normalisedProfileData).length > 0) {
          await storage.patchIdentity(byAppUserId.id, normalisedProfileData, appName);
        }
        const identity = await storage.getIdentity(byAppUserId.id);
        return res.json({ identity, matched_by: "appUserId" });
      }

      if (normalisedProfileData.email) {
        const byEmail = await storage.lookupByEmail(normalisedProfileData.email);
        if (byEmail) {
          await storage.ensureAppLink(byEmail.id, appName, appUserId);
          if (Object.keys(normalisedProfileData).length > 0) {
            await storage.patchIdentity(byEmail.id, normalisedProfileData, appName);
          }
          const identity = await storage.getIdentity(byEmail.id);
          return res.json({ identity, matched_by: "email" });
        }
      }

      if (normalisedProfileData.phone) {
        const byPhone = await storage.lookupByCurrentPhone(normalisedProfileData.phone);
        if (byPhone) {
          await storage.ensureAppLink(byPhone.id, appName, appUserId);
          if (Object.keys(normalisedProfileData).length > 0) {
            await storage.patchIdentity(byPhone.id, normalisedProfileData, appName);
          }
          const identity = await storage.getIdentity(byPhone.id);
          return res.json({ identity, matched_by: "phone" });
        }
      }

      const { fullName, phone: rawPhone, email, ...restProfile } = normalisedProfileData;
      if (!fullName || !rawPhone || !email) {
        return res.status(422).json({ error: "fullName, phone, and email are required to create a new identity" });
      }

      const result = await storage.createOrUpdateIdentity(
        { ...restProfile, fullName, email, currentPhone: normalisePhone(rawPhone) } as Parameters<typeof storage.createOrUpdateIdentity>[0],
        appName,
        appUserId,
      );
      const statusCode = result.created ? 201 : 200;
      const matchedBy = result.created ? "created" : "email";
      return res.status(statusCode).json({ identity: result.identity, matched_by: matchedBy });
    } catch (err) {
      if (err instanceof EmailTakenError || (err as { code?: string })?.code === "EMAIL_TAKEN") {
        return res.status(409).json({ error: "Email already in use" });
      }
      console.error(err);
      return res.status(500).json({ error: "Failed to upsert identity" });
    }
  });

  app.put("/api/identity/:befiterId", apiKeyAuth, writeRateLimiter, async (req: Request, res: Response) => {
    try {
      const existing = await storage.getIdentity(req.params.befiterId);
      if (!existing) return res.status(404).json({ error: "Identity not found" });

      const body = { ...req.body };
      delete body.currentPhone;
      delete body.previousPhones;
      delete body.phone;
      delete body.email;
      delete body.id;
      delete body.createdAt;
      delete body.identityTag;

      const parseResult = updateBefiterIdSchema.safeParse(body);
      if (!parseResult.success) {
        return res.status(400).json({ error: "Validation failed", details: parseResult.error.flatten() });
      }

      const updated = await storage.updateIdentity(req.params.befiterId, parseResult.data, req.appName!);
      return res.json({ identity: updated });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Failed to update identity" });
    }
  });

  app.patch("/api/identity/:id", apiKeyAuth, writeRateLimiter, async (req: Request, res: Response) => {
    try {
      const parseResult = patchBefiterIdSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ error: "Validation failed", details: parseResult.error.flatten() });
      }

      const data = { ...parseResult.data };
      if (data.phone) {
        data.phone = normalisePhone(data.phone);
      }

      const updated = await storage.patchIdentity(req.params.id, data, req.appName!);
      return res.json({ identity: updated });
    } catch (err) {
      if (err instanceof IdentityNotFoundError || (err as { code?: string })?.code === "IDENTITY_NOT_FOUND") {
        return res.status(404).json({ error: "Identity not found" });
      }
      if (err instanceof EmailTakenError || (err as { code?: string })?.code === "EMAIL_TAKEN") {
        return res.status(409).json({ error: "Email already in use" });
      }
      console.error(err);
      return res.status(500).json({ error: "Failed to patch identity" });
    }
  });

  app.post("/api/identity/:befiterId/link", apiKeyAuth, writeRateLimiter, async (req: Request, res: Response) => {
    try {
      const existing = await storage.getIdentity(req.params.befiterId);
      if (!existing) return res.status(404).json({ error: "Identity not found" });

      const { appUserId } = req.body;
      if (!appUserId) {
        return res.status(400).json({ error: "appUserId is required" });
      }

      const alreadyLinked = existing.appLinks.find(l => l.appName === req.appName);
      if (alreadyLinked) {
        return res.status(409).json({ error: "This app is already linked to this identity" });
      }

      await storage.linkApp(req.params.befiterId, req.appName!, appUserId);
      const identity = await storage.getIdentity(req.params.befiterId);
      return res.status(201).json({ identity });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Failed to link app" });
    }
  });

  app.get("/api/identity/:befiterId", apiKeyAuth, readRateLimiter, async (req: Request, res: Response) => {
    try {
      const identity = await storage.getIdentity(req.params.befiterId);
      if (!identity) return res.status(404).json({ error: "Identity not found" });
      return res.json({ identity });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Failed to fetch identity" });
    }
  });

  // ─── Leads API (public, api-key protected) ───────────────────────────────

  app.post("/api/leads", apiKeyAuth, writeRateLimiter, async (req: Request, res: Response) => {
    try {
      const parseResult = insertLeadSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ error: "Validation failed", details: parseResult.error.flatten() });
      }
      const data = { ...parseResult.data, phone: normalisePhone(parseResult.data.phone) };
      const lead = await storage.createLead(data);
      return res.status(201).json(lead);
    } catch (err: any) {
      if (err?.code === "23505") {
        return res.status(409).json({ error: "A lead with this storeLeadId already exists" });
      }
      console.error(err);
      return res.status(500).json({ error: "Failed to create lead" });
    }
  });

  app.patch("/api/leads/:id", apiKeyAuth, writeRateLimiter, async (req: Request, res: Response) => {
    try {
      const parseResult = patchLeadSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ error: "Validation failed", details: parseResult.error.flatten() });
      }
      const data = { ...parseResult.data };
      if (data.phone) {
        data.phone = normalisePhone(data.phone);
      }
      const lead = await storage.patchLead(req.params.id, data);
      return res.json(lead);
    } catch (err) {
      if (err instanceof LeadNotFoundError) {
        return res.status(404).json({ error: "Lead not found" });
      }
      console.error(err);
      return res.status(500).json({ error: "Failed to update lead" });
    }
  });

  app.get("/api/leads/lookup", apiKeyAuth, readRateLimiter, async (req: Request, res: Response) => {
    try {
      const storeLeadId = req.query.storeLeadId as string;
      if (!storeLeadId) return res.status(400).json({ error: "storeLeadId query param is required" });
      const lead = await storage.getLeadByStoreId(storeLeadId);
      if (!lead) return res.json({ found: false });
      return res.json({ found: true, lead });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Failed to lookup lead" });
    }
  });

  // ─── Leads Admin (dashboard) ──────────────────────────────────────────────

  // ─── Admin Webhook Events ────────────────────────────────────────────────

  app.get("/admin/webhooks", requireAdminSession, async (req: Request, res: Response, next) => {
    try {
      const status = typeof req.query.status === "string" ? req.query.status : undefined;
      const limit = Math.min(parseInt(String(req.query.limit ?? "100"), 10) || 100, 500);
      const events = await storage.listWebhookEvents(status, limit);
      res.json({
        events,
        channels: {
          com: { configured: isChannelConfigured("com") },
          store: { configured: isChannelConfigured("store") },
        },
      });
    } catch (err) { next(err); }
  });

  app.post("/admin/webhooks/:id/retry", requireAdminSession, async (req: Request, res: Response, next) => {
    try {
      await retryWebhookNow(req.params.id as string);
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  app.get("/admin/leads", requireAdminSession, async (req: Request, res: Response, next) => {
    if ((req.headers["accept"] || "").startsWith("text/html")) return next();
    try {
      const query = (req.query.q as string) || "";
      const status = (req.query.status as string) || "";
      const page = parseInt((req.query.page as string) || "1", 10);
      const limit = parseInt((req.query.limit as string) || "50", 10);
      const result = await storage.searchLeads(query, page, limit, status || undefined);
      return res.json(result);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Failed to fetch leads" });
    }
  });

  app.get("/admin/lead/:id", requireAdminSession, async (req: Request, res: Response, next) => {
    if ((req.headers["accept"] || "").startsWith("text/html")) return next();
    try {
      const lead = await storage.getLeadById(req.params.id as string);
      if (!lead) return res.status(404).json({ error: "Lead not found", code: "LEAD_NOT_FOUND" });
      return res.json(lead);
    } catch (err) { next(err); }
  });

  return httpServer;
}
