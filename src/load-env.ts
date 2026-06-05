import { config } from "dotenv";
import { resolve } from "node:path";

// Load before any module that reads process.env (Cloudinary, Prisma, etc.)
config({ path: resolve(process.cwd(), ".env") });
// src/.env overrides for local dev (e.g. localhost DATABASE_URL)
config({ path: resolve(process.cwd(), "src/.env"), override: true });
