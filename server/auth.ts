import type { Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import { storage } from "./storage";

declare global {
  namespace Express {
    interface Request {
      appName?: string;
    }
  }
}

export async function apiKeyAuth(req: Request, res: Response, next: NextFunction) {
  const rawKey = req.headers["x-api-key"];

  if (!rawKey || typeof rawKey !== "string") {
    return res.status(401).json({ error: "Unauthorized - Missing API key" });
  }

  const prefix = rawKey.slice(0, 10);

  try {
    const keyRecord = await storage.getApiKeyByPrefix(prefix);

    if (!keyRecord) {
      return res.status(401).json({ error: "Unauthorized - Invalid API key" });
    }

    if (!keyRecord.isActive) {
      return res.status(401).json({ error: "Unauthorized - API key is inactive" });
    }

    const valid = await bcrypt.compare(rawKey, keyRecord.keyHash);

    if (!valid) {
      return res.status(401).json({ error: "Unauthorized - Invalid API key" });
    }

    req.appName = keyRecord.appName;
    next();
  } catch (err) {
    console.error("API key auth error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
