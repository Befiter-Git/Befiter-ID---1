import type { Request, Response, NextFunction } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { pool } from "./db";

const PgSession = connectPgSimple(session);

export const sessionMiddleware = session({
  store: new PgSession({
    pool,
    tableName: "session",
    createTableIfMissing: true,
  }),
  secret: process.env.SESSION_SECRET || "befiter-admin-secret-change-in-production",
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
  },
});

declare module "express-session" {
  interface SessionData {
    adminLoggedIn?: boolean;
    adminUsername?: string;
  }
}

export function requireAdminSession(req: Request, res: Response, next: NextFunction) {
  if (req.session?.adminLoggedIn) {
    return next();
  }
  return res.status(401).json({ error: "Unauthorized - Admin login required" });
}
