import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { config } from "dotenv";

import { accountRoutes } from "./routes/account";
import { adminRoutes } from "./routes/admin";
import { airspaceRoutes } from "./routes/airspace";
import { authRoutes } from "./routes/auth";
import { contactRoutes } from "./routes/contact";
import { dronesRoutes } from "./routes/drones";
import { flightsRoutes } from "./routes/flights";
import { messagesRoutes } from "./routes/messages";
import { obstaclesRoutes } from "./routes/obstacles";
import { pilotsRoutes } from "./routes/pilots";
import { trafficRoutes } from "./routes/traffic";
import { weatherRoutes } from "./routes/weather";
import { zonesRoutes } from "./routes/zones";
import { isDatabaseAvailable } from "./lib/db/client";
import { memoryHealth } from "./lib/geo/memory-guard";
import { ensureSeedPilotsLoaded } from "./lib/seed/bootstrap";

config({ path: ".env" });

const app = new Hono();
const port = Number(process.env.PORT ?? 4000);

app.use(
  "*",
  cors({
    origin: (origin) => origin || "*",
    credentials: true,
  }),
);

app.get("/health", async (c) => {
  const db = await isDatabaseAvailable();
  return c.json({
    ok: true,
    service: "canifly-api",
    database: db ? "up" : "down",
    /** Whether Poland PANSA live queries can run (key present; not validated). */
    pansaConfigured: Boolean(process.env.PANSA_API_KEY?.trim()),
    memory: memoryHealth(),
  });
});

app.use(
  "/uploads/*",
  serveStatic({
    root: "./",
  }),
);

app.route("/api/airspace", airspaceRoutes);
app.route("/api/zones", zonesRoutes);
app.route("/api/obstacles", obstaclesRoutes);
app.route("/api/flights", flightsRoutes);
app.route("/api/messages", messagesRoutes);
app.route("/api/auth", authRoutes);
app.route("/api/account", accountRoutes);
app.route("/api/contact", contactRoutes);
app.route("/api/traffic", trafficRoutes);
app.route("/api/weather", weatherRoutes);
app.route("/api/drones", dronesRoutes);
app.route("/api/pilots", pilotsRoutes);
app.route("/api/admin", adminRoutes);

console.log(`CanIFly API listening on http://localhost:${port}`);

/** Demo pilots + fly spots (ES/CZ/PL) when DB has no seed users yet. */
void ensureSeedPilotsLoaded();

serve({
  fetch: app.fetch,
  port,
});

export default app;
