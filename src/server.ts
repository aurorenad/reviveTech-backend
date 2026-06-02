import "./load-env.js";
import express from "express";
import type { Request, Response } from "express";
import cors from "cors";
import routes from "./routes/index.js";
import { isCloudinaryReady } from "./config/cloudinary.js";
import { prisma } from "./config/prisma.js";
import { getOpenApiSpec, swaggerHtml } from "./config/openapi.js";
import { errorHandler } from "./middlewares/errorHandler.js";
import { rateLimiter } from "./middlewares/rateLimiter.js";

const app = express();
const PORT = process.env["PORT"] || 5001;

app.set("trust proxy", 1);

// Enable CORS and JSON parsing
app.use(cors());
app.use(express.json());
app.use(rateLimiter());

// API route entry point
app.use("/api", routes);

app.get("/api-docs.json", (req: Request, res: Response) => {
  const forwardedProto = req.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedHost = req.get("x-forwarded-host")?.split(",")[0]?.trim();
  const protocol = forwardedProto || req.protocol;
  const host = forwardedHost || req.get("host") || `localhost:${PORT}`;
  const baseUrl = `${protocol}://${host}`;

  res.status(200).json(getOpenApiSpec(baseUrl));
});

app.get("/api-docs", (_req: Request, res: Response) => {
  res.type("html").send(swaggerHtml);
});

// System Health Check Endpoint
app.get("/health", async (req: Request, res: Response) => {
  try {
    // Ping database
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({
      status: "UP",
      timestamp: new Date(),
      services: {
        database: "CONNECTED",
        api: "HEALTHY",
        cloudinary: isCloudinaryReady() ? "CONFIGURED" : "NOT_CONFIGURED",
      },
    });
  } catch (error: any) {
    res.status(500).json({
      status: "DOWN",
      timestamp: new Date(),
      services: {
        database: "DISCONNECTED",
        api: "UNHEALTHY",
      },
      error: error.message,
    });
  }
});

// Root welcome message
app.get("/", (req: Request, res: Response) => {
  res.status(200).send("Welcome to the Secondhand Device Refurbishment & Financing Platform API");
});

// Global Error Handler
app.use(errorHandler);

// Boot the server
const server = app.listen(PORT, () => {
  console.log(`[Server] Running on http://localhost:${PORT}`);
  console.log(`[Cloudinary] ${isCloudinaryReady() ? "configured" : "NOT configured — set CLOUDINARY_* in .env"}`);
});

process.on("SIGINT", async () => {
  console.log("[Server] Shutting down, disconnecting database...");
  await prisma.$disconnect();
  server.close(() => {
    process.exit(0);
  });
});
