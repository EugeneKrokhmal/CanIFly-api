import { Hono } from "hono";
import { z } from "zod";
import { SPAIN_CENTER } from "@canifly/middleware";
import { weatherLabel } from "../lib/weather/codes";

export const weatherRoutes = new Hono();

const querySchema = z.object({
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
});

type OpenMeteoCurrent = {
  temperature_2m?: number;
  weather_code?: number;
  wind_speed_10m?: number;
  wind_direction_10m?: number;
  relative_humidity_2m?: number;
  time?: string;
};

weatherRoutes.get("/", async (c) => {
  const params = Object.fromEntries(new URL(c.req.url).searchParams.entries());
  const parsed = querySchema.safeParse(params);
  if (!parsed.success) {
    return c.json({ error: "Invalid query parameters" }, 400);
  }

  const lat = parsed.data.lat ?? SPAIN_CENTER[1];
  const lng = parsed.data.lng ?? SPAIN_CENTER[0];

  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", lat.toFixed(3));
  url.searchParams.set("longitude", lng.toFixed(3));
  url.searchParams.set(
    "current",
    [
      "temperature_2m",
      "relative_humidity_2m",
      "weather_code",
      "wind_speed_10m",
      "wind_direction_10m",
    ].join(","),
  );
  url.searchParams.set("wind_speed_unit", "kmh");
  url.searchParams.set("timezone", "auto");

  try {
    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      return c.json({ error: "weather_upstream", status: res.status }, 502);
    }

    const data = (await res.json()) as {
      current?: OpenMeteoCurrent;
      current_units?: Record<string, string>;
    };
    const current = data.current;
    if (
      !current ||
      current.temperature_2m == null ||
      current.weather_code == null
    ) {
      return c.json({ error: "weather_empty" }, 502);
    }

    const code = current.weather_code;
    return c.json({
      lat,
      lng,
      temperatureC: Math.round(current.temperature_2m),
      weatherCode: code,
      label: weatherLabel(code),
      windKmh:
        current.wind_speed_10m != null
          ? Math.round(current.wind_speed_10m)
          : null,
      windDirDeg: current.wind_direction_10m ?? null,
      humidityPct: current.relative_humidity_2m ?? null,
      observedAt: current.time ?? null,
      source: "open-meteo",
    });
  } catch {
    return c.json({ error: "weather_fetch_failed" }, 502);
  }
});
