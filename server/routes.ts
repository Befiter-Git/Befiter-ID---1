import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import { storage, EmailTakenError, IdentityNotFoundError, LeadNotFoundError, extractMetadataBucket, isValidEmail, quarantineEmailFor } from "./storage";
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
      const rawPage = parseInt((req.query.page as string) || "1", 10);
      const rawLimit = parseInt((req.query.limit as string) || "50", 10);
      const page = Math.max(1, isNaN(rawPage) ? 1 : rawPage);
      const limit = Math.min(200, Math.max(1, isNaN(rawLimit) ? 50 : rawLimit));
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
      const adminUsername = req.session.adminUsername || "admin";
      const updated = await storage.adminUpdateIdentity(req.params.befiterId, req.body, adminUsername);
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
      const adminUsername = req.session.adminUsername || "admin";
      await storage.deleteIdentity(req.params.befiterId, adminUsername);
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
        const linked = await storage.isAppLinked(identity.id, req.appName!);
        if (!linked) {
          return res.json({ found: false });
        }
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
      const warnings: string[] = [];
      const incoming = { ...req.body };
      if (incoming.phone && !incoming.currentPhone) {
        incoming.currentPhone = incoming.phone;
      }
      delete incoming.phone;

      const { appUserId } = incoming;
      if (!appUserId) {
        return res.status(400).json({ error: "appUserId is required" });
      }
      delete incoming.appUserId;

      // Route fitnessGoals + unknown keys + provided metadata into per-app bucket
      const { cleaned, metadata } = extractMetadataBucket(incoming);

      // Lenient email: if missing or malformed but phone is valid, quarantine raw value
      let rejectedEmail: string | null = null;
      const rawEmail = typeof cleaned.email === "string" ? (cleaned.email as string).trim() : "";
      let normalisedPhone: string;
      try {
        normalisedPhone = normalisePhone(String(cleaned.currentPhone ?? ""));
      } catch (phoneErr: any) {
        return res.status(422).json({ error: "Invalid phone number", details: phoneErr.message });
      }
      cleaned.currentPhone = normalisedPhone;

      if (!isValidEmail(rawEmail)) {
        if (rawEmail) {
          rejectedEmail = rawEmail.slice(0, 254);
          warnings.push("email_quarantined");
        } else {
          warnings.push("email_missing");
        }
        cleaned.email = quarantineEmailFor(normalisedPhone);
      } else {
        cleaned.email = rawEmail;
      }

      const parseResult = insertBefiterIdSchema.safeParse(cleaned);
      if (!parseResult.success) {
        return res.status(400).json({ error: "Validation failed", details: parseResult.error.flatten() });
      }

      const result = await storage.createOrUpdateIdentity(
        parseResult.data, req.appName!, appUserId,
        { metadata, rejectedEmailAtIntake: rejectedEmail },
      );

      const status = result.created ? 201 : 200;
      return res.status(status).json({
        identity: result.identity,
        warnings: warnings.length > 0 ? warnings : undefined,
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Failed to create identity" });
    }
  });

  app.put("/api/identity/upsert", apiKeyAuth, writeRateLimiter, async (req: Request, res: Response) => {
    try {
      const warnings: string[] = [];
      const incoming = { ...req.body };
      const appUserId: string | undefined = incoming.appUserId;
      if (!appUserId || typeof appUserId !== "string") {
        return res.status(400).json({ error: "appUserId is required" });
      }
      delete incoming.appUserId;

      const { cleaned, metadata } = extractMetadataBucket(incoming);
      const appName = req.appName!;

      // Normalise phone if present
      if (cleaned.phone) {
        try {
          cleaned.phone = normalisePhone(String(cleaned.phone));
        } catch (phoneErr: any) {
          return res.status(422).json({ error: "Invalid phone number", details: phoneErr.message });
        }
      }

      // Sanitise email; if invalid and we have a phone, we'll quarantine on create
      const rawEmail = typeof cleaned.email === "string" ? (cleaned.email as string).trim() : "";
      const emailIsValid = isValidEmail(rawEmail);
      const profileForPatch: Record<string, unknown> = { ...cleaned };
      if (rawEmail && !emailIsValid) {
        // never PATCH email with a bad value
        delete profileForPatch.email;
        warnings.push("email_quarantined");
      } else if (emailIsValid) {
        profileForPatch.email = rawEmail;
      } else {
        delete profileForPatch.email;
      }

      const parseProfile = upsertBefiterIdSchema.omit({ appUserId: true }).safeParse(profileForPatch);
      if (!parseProfile.success) {
        return res.status(400).json({ error: "Validation failed", details: parseProfile.error.flatten() });
      }
      const normalisedProfileData = parseProfile.data as Record<string, unknown>;

      const byAppUserId = await storage.lookupByAppUserId(appName, appUserId);
      if (byAppUserId) {
        if (Object.keys(normalisedProfileData).length > 0 || Object.keys(metadata).length > 0) {
          await storage.patchIdentity(byAppUserId.id, normalisedProfileData as any, appName, { metadata });
        }
        const identity = await storage.getIdentity(byAppUserId.id);
        return res.json({ identity, matched_by: "appUserId", warnings: warnings.length > 0 ? warnings : undefined });
      }

      if (typeof normalisedProfileData.email === "string") {
        const byEmail = await storage.lookupByEmail(normalisedProfileData.email as string);
        if (byEmail) {
          const alreadyLinked = await storage.isAppLinked(byEmail.id, appName);
          if (!alreadyLinked) {
            return res.status(403).json({ error: "Forbidden - identity exists but is not linked to your application; use the link endpoint to establish a verified link" });
          }
          if (Object.keys(normalisedProfileData).length > 0 || Object.keys(metadata).length > 0) {
            await storage.patchIdentity(byEmail.id, normalisedProfileData as any, appName, { metadata });
          }
          const identity = await storage.getIdentity(byEmail.id);
          return res.json({ identity, matched_by: "email", warnings: warnings.length > 0 ? warnings : undefined });
        }
      }

      if (typeof normalisedProfileData.phone === "string") {
        const byPhone = await storage.lookupByCurrentPhone(normalisedProfileData.phone as string);
        if (byPhone) {
          const alreadyLinked = await storage.isAppLinked(byPhone.id, appName);
          if (!alreadyLinked) {
            return res.status(403).json({ error: "Forbidden - identity exists but is not linked to your application; use the link endpoint to establish a verified link" });
          }
          if (Object.keys(normalisedProfileData).length > 0 || Object.keys(metadata).length > 0) {
            await storage.patchIdentity(byPhone.id, normalisedProfileData as any, appName, { metadata });
          }
          const identity = await storage.getIdentity(byPhone.id);
          return res.json({ identity, matched_by: "phone", warnings: warnings.length > 0 ? warnings : undefined });
        }
      }

      const fullName = normalisedProfileData.fullName as string | undefined;
      const rawPhone = normalisedProfileData.phone as string | undefined;
      if (!fullName || !rawPhone) {
        return res.status(422).json({ error: "fullName and phone are required to create a new identity" });
      }
      const normalisedPhoneForCreate = normalisePhone(rawPhone);

      let createEmail: string;
      let rejectedEmail: string | null = null;
      if (emailIsValid) {
        createEmail = rawEmail.toLowerCase();
      } else {
        if (rawEmail) {
          rejectedEmail = rawEmail.slice(0, 254);
        } else {
          warnings.push("email_missing");
        }
        createEmail = quarantineEmailFor(normalisedPhoneForCreate);
      }

      const { phone: _p, email: _e, ...restProfile } = normalisedProfileData;
      const result = await storage.createOrUpdateIdentity(
        { ...restProfile, fullName, email: createEmail, currentPhone: normalisedPhoneForCreate } as Parameters<typeof storage.createOrUpdateIdentity>[0],
        appName,
        appUserId,
        { metadata, rejectedEmailAtIntake: rejectedEmail },
      );
      const statusCode = result.created ? 201 : 200;
      const matchedBy = result.created ? "created" : "email";
      return res.status(statusCode).json({
        identity: result.identity,
        matched_by: matchedBy,
        warnings: warnings.length > 0 ? warnings : undefined,
      });
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
      const linked = existing.appLinks.some(l => l.appName === req.appName);
      if (!linked) return res.status(403).json({ error: "Forbidden - identity not linked to your application" });

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
      const { cleaned, metadata } = extractMetadataBucket({ ...req.body });
      // Drop email if malformed - never let bad values overwrite a good email
      if (typeof cleaned.email === "string" && !isValidEmail((cleaned.email as string).trim())) {
        delete cleaned.email;
      }
      const parseResult = patchBefiterIdSchema.safeParse(cleaned);
      if (!parseResult.success) {
        return res.status(400).json({ error: "Validation failed", details: parseResult.error.flatten() });
      }
      const linked = await storage.isAppLinked(req.params.id, req.appName!);
      if (!linked) return res.status(403).json({ error: "Forbidden - identity not linked to your application" });

      const data = { ...parseResult.data };
      if (data.phone) {
        try {
          data.phone = normalisePhone(data.phone);
        } catch (phoneErr: any) {
          return res.status(422).json({ error: "Invalid phone number", details: phoneErr.message });
        }
      }

      const updated = await storage.patchIdentity(req.params.id, data, req.appName!, { metadata });
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

      const { appUserId, email, phone } = req.body;
      if (!appUserId) {
        return res.status(400).json({ error: "appUserId is required" });
      }
      if (!email || !phone) {
        return res.status(400).json({ error: "email and phone are required to verify identity ownership" });
      }
      if (!existing.email || email.toLowerCase() !== existing.email.toLowerCase()) {
        return res.status(403).json({ error: "Forbidden - provided credentials do not match identity record" });
      }
      let normalisedLinkPhone: string;
      try {
        normalisedLinkPhone = normalisePhone(phone);
      } catch {
        return res.status(422).json({ error: "Invalid phone number" });
      }
      if (normalisedLinkPhone !== existing.currentPhone) {
        return res.status(403).json({ error: "Forbidden - provided credentials do not match identity record" });
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
      const linked = identity.appLinks.some(l => l.appName === req.appName);
      if (!linked) return res.status(404).json({ error: "Identity not found" });
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
      let phone: string;
      try {
        phone = normalisePhone(parseResult.data.phone);
      } catch (phoneErr: any) {
        return res.status(422).json({ error: "Invalid phone number", details: phoneErr.message });
      }
      const data = { ...parseResult.data, phone };
      const lead = await storage.createLead(data, req.appName!);
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
        try {
          data.phone = normalisePhone(data.phone);
        } catch (phoneErr: any) {
          return res.status(422).json({ error: "Invalid phone number", details: phoneErr.message });
        }
      }
      const lead = await storage.patchLead(req.params.id, data, req.appName!);
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
      const lead = await storage.getLeadByStoreId(storeLeadId, req.appName!);
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
      const rawPage = parseInt((req.query.page as string) || "1", 10);
      const rawLimit = parseInt((req.query.limit as string) || "50", 10);
      const page = Math.max(1, isNaN(rawPage) ? 1 : rawPage);
      const limit = Math.min(200, Math.max(1, isNaN(rawLimit) ? 50 : rawLimit));
      const result = await storage.searchLeads(query, page, limit, status || undefined);
      return res.json(result);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Failed to fetch leads" });
    }
  });

  app.get("/admin/metrics", requireAdminSession, async (_req: Request, res: Response, next) => {
    try {
      const metrics = await storage.getMetrics();
      return res.json(metrics);
    } catch (err) { next(err); }
  });

  app.get("/admin/intake-issues", requireAdminSession, async (req: Request, res: Response, next) => {
    if ((req.headers["accept"] || "").startsWith("text/html")) return next();
    try {
      const rawPage = parseInt((req.query.page as string) || "1", 10);
      const rawLimit = parseInt((req.query.limit as string) || "50", 10);
      const page = Math.max(1, isNaN(rawPage) ? 1 : rawPage);
      const limit = Math.min(200, Math.max(1, isNaN(rawLimit) ? 50 : rawLimit));
      const result = await storage.searchIntakeIssues(page, limit);
      return res.json(result);
    } catch (err) { next(err); }
  });

  app.post("/admin/intake-issues/:id/fix-email", requireAdminSession, async (req: Request, res: Response) => {
    try {
      const { email } = req.body ?? {};
      if (!email || typeof email !== "string") return res.status(400).json({ error: "email is required" });
      const adminUsername = req.session.adminUsername || "admin";
      const identity = await storage.clearRejectedEmail(req.params.id as string, email, adminUsername);
      return res.json({ identity });
    } catch (err) {
      if (err instanceof IdentityNotFoundError) return res.status(404).json({ error: "Identity not found" });
      if (err instanceof EmailTakenError) return res.status(409).json({ error: "Email already in use" });
      const msg = err instanceof Error ? err.message : String(err);
      console.error(err);
      return res.status(400).json({ error: msg });
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
