import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { Request } from "express";

export const apiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const apiKey = req.headers["x-api-key"];
    if (typeof apiKey === "string" && apiKey) {
      return apiKey;
    }
    return ipKeyGenerator(req);
  },
  message: {
    error: "Rate limit exceeded. Maximum 100 requests per minute per API key.",
  },
  statusCode: 429,
});
