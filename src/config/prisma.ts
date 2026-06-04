import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

const normalizeDatabaseUrl = (url: string | undefined): string => {
  const value = (url || "").trim();

  return value
    .replace(/^DATABASE_URL=/, "")
    .replace(/^['"]|['"]$/g, "");
};

const connectionString = normalizeDatabaseUrl(process.env["DATABASE_URL"]);

const shouldUseSsl = (url: string): boolean => {
  if (!url || process.env["DATABASE_SSL"] === "false") {
    return false;
  }

  if (process.env["DATABASE_SSL"] === "true") {
    return true;
  }

  try {
    const { hostname } = new URL(url);
    return hostname !== "localhost" && hostname !== "127.0.0.1";
  } catch {
    return process.env["NODE_ENV"] === "production";
  }
};

const pool = new pg.Pool({
  connectionString,
  connectionTimeoutMillis: 15_000,
  ...(shouldUseSsl(connectionString) ? { ssl: { rejectUnauthorized: false } } : {}),
});
const adapter = new PrismaPg(pool);

export const prisma = new PrismaClient({ adapter });
