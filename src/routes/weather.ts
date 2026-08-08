import { Hono } from "hono";
import { z } from "zod";
import { SPAIN_CENTER } from "@canifly/middleware";
import {
  getWeatherCached,
  setWeatherCached,
  tripWeatherCooldown,
  weatherCacheKey,
  weatherCooldownActive,
  withWeatherInflight,
} from "../lib/weather/cache";
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

export type WeatherResponse = {
  lat: number;
  lng: number;
  temperatureC: number;
  weatherCode: number;
  label: string;
  windKmh: number | null;
  windDirDeg: number | null;
  humidityPct: number | null;
  observedAt: string | null;
  source: "open-meteo";
  cached?: boolean;
};

function toPayload(
  lat: number,
  lng: number,
  current: OpenMeteoCurrent,
): WeatherResponse | null {
  if (current.temperature_2m == null || current.weather_code == null) {
    return null;
  }
  const code = current.weather_code;
  return {
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
  };
}

async function fetchOpenMeteo(
  lat: number,
  lng: number,
): Promise<WeatherResponse> {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  // Match cache grid so upstream+cache share the same cell.
  url.searchParams.set("latitude", lat.toFixed(2));
  url.searchParams.set("longitude", lng.toFixed(2));
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

  const res = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "User-Agent": "CanIFly/1.0 (+https://canifly.org; weather via open-meteo)",
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) {
    const err = new Error(`upstream_${res.status}`) as Error & {
      status: number;
    };
    err.status = res.status;
    throw err;
  }

  const data = (await res.json()) as {
    current?: OpenMeteoCurrent;
  };
  const payload = data.current ? toPayload(lat, lng, data.current) : null;
  if (!payload) {
    throw new Error("weather_empty");
  }
  return payload;
}

weatherRoutes.get("/", async (c) => {
  const params = Object.fromEntries(new URL(c.req.url).searchParams.entries());
  const parsed = querySchema.safeParse(params);
  if (!parsed.success) {
    return c.json({ error: "Invalid query parameters" }, 400);
  }

  const lat = parsed.data.lat ?? SPAIN_CENTER[1];
  const lng = parsed.data.lng ?? SPAIN_CENTER[0];
  const key = weatherCacheKey(lat, lng);

  const cached = getWeatherCached<WeatherResponse>(key);
  if (cached?.fresh) {
    return c.json({ ...cached.value, cached: true });
  }

  if (weatherCooldownActive()) {
    if (cached) {
      return c.json({ ...cached.value, cached: true });
    }
    return c.json({ error: "weather_upstream", status: 429 }, 502);
  }

  try {
    const payload = await withWeatherInflight(key, async () => {
      const again = getWeatherCached<WeatherResponse>(key);
      if (again?.fresh) return again.value;
      const fresh = await fetchOpenMeteo(lat, lng);
      setWeatherCached(key, fresh);
      return fresh;
    });
    return c.json(payload);
  } catch (err) {
    const status =
      err && typeof err === "object" && "status" in err
        ? Number((err as { status: number }).status)
        : 0;
    if (status === 429) {
      tripWeatherCooldown();
    }
    if (cached) {
      return c.json({ ...cached.value, cached: true });
    }
    if (status > 0) {
      return c.json({ error: "weather_upstream", status }, 502);
    }
    if (err instanceof Error && err.message === "weather_empty") {
      return c.json({ error: "weather_empty" }, 502);
    }
    return c.json({ error: "weather_fetch_failed" }, 502);
  }
});
