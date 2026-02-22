#!/usr/bin/env node

/**
 * MetService NZ Weather Client
 * Fetches current weather and forecasts from MetService for NZ locations
 */

import * as https from "https";
import * as fs from "fs";
import * as path from "path";

interface CurrentWeather {
  temperature: number;
  feelsLike: number;
  humidity: number;
  wind: {
    speed: number;
    direction: string;
    gust: number;
  };
  rainfall: number;
  pressure: number;
  source: string;
  asAt: string;
}

interface HourlyForecast {
  timestamp: string;
  temperature: number;
  rainfall: number;
  rainPerHour: number;
  wind: {
    speed: number;
    direction: string;
  };
}

interface DayForecast {
  date: string;
  condition: string;
  statement: string;
  highTemp: number;
  lowTemp: number;
  sunrise: string;
  sunset: string;
  breakdown: {
    morning: string;
    afternoon: string;
    evening: string;
    overnight: string;
  };
}

interface WeatherData {
  location: string;
  region: string;
  current: CurrentWeather | null;
  next48Hours: HourlyForecast[];
  dailyForecast: DayForecast[];
  fetchedAt: string;
}

// Cache in-memory (simple cache, expires after 30 minutes)
const cache: { [key: string]: { data: WeatherData; expires: number } } = {};
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Location index cache
let locationIndex: { [key: string]: { region: string; location: string; label: string } } = {};
let locationIndexFetched = false;

async function fetchJSON(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    https
      .get(url, { timeout: 10000 }, (res) => {
        // Check for HTTP errors
        if (res.statusCode && res.statusCode >= 400) {
          reject(
            new Error(`HTTP ${res.statusCode} from ${url}`)
          );
          return;
        }

        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Failed to parse JSON from ${url}: ${e}`));
          }
        });
      })
      .on("error", (e) => {
        reject(
          new Error(`Failed to fetch ${url}: ${e.message || String(e)}`)
        );
      });
  });
}

async function buildLocationIndex(): Promise<void> {
  if (locationIndexFetched) return;

  try {
    console.error(`[index] Building location index...`);
    const data = await fetchJSON(
      "https://www.metservice.com/publicData/webdata/towns-cities"
    );

    const searchLocations = data?.layout?.search?.searchLocations || [];

    // Parse all search location groups (towns-cities, rural, etc.)
    for (const searchGroup of searchLocations) {
      const items = searchGroup.items || [];

      for (const region of items) {
        const regionHeading = region.heading?.label || "";
        const regionUrl = region.heading?.url || "";

        // Extract region path from URL like /towns-cities/regions/northern-north-island or /rural/regions/...
        const regionMatch = regionUrl.match(/regions\/([^/]+)/);
        const regionKey = regionMatch ? regionMatch[1] : null;

        if (!regionKey) continue;

        for (const location of region.children || []) {
          const label = location.label || "";
          const url = location.url || "";

          // Extract location path from URL
          const locationMatch = url.match(/locations\/([^/]+)/);
          const locationKey = locationMatch ? locationMatch[1] : null;

          if (!locationKey) continue;

          // Index by lowercase label for searching
          const searchKey = label.toLowerCase();
          if (!locationIndex[searchKey]) {
            locationIndex[searchKey] = {
              region: regionKey,
              location: locationKey,
              label: label,
            };
          }
        }
      }
    }

    locationIndexFetched = true;
    console.error(
      `[index] Built index with ${Object.keys(locationIndex).length} locations`
    );
  } catch (e) {
    console.error(`[index] Failed to build location index: ${e}`);
    locationIndexFetched = true; // Don't retry
  }
}

async function searchLocation(
  query: string
): Promise<{ region: string; location: string; label: string } | null> {
  await buildLocationIndex();

  const searchKey = query.toLowerCase().trim();

  // Exact match
  if (locationIndex[searchKey]) {
    return locationIndex[searchKey];
  }

  // Fuzzy match (substring search)
  const matches = Object.entries(locationIndex)
    .filter(([key]) => key.includes(searchKey) || searchKey.includes(key))
    .slice(0, 5);

  if (matches.length > 0) {
    console.error(
      `[search] No exact match for "${query}". Found similar: ${matches.map(([_, v]) => v.label).join(", ")}`
    );
    return matches[0][1];
  }

  return null;
}

async function getLocationData(
  region: string,
  location: string
): Promise<{ stationId: string; locationLabel: string }> {
  // Try towns-cities first, then rural
  const endpoints = [
    `https://www.metservice.com/publicData/webdata/towns-cities/regions/${region}/locations/${location}`,
    `https://www.metservice.com/publicData/webdata/rural/regions/${region}/locations/${location}`,
  ];

  let lastError: Error | null = null;

  for (const url of endpoints) {
    try {
      const data = await fetchJSON(url);

      // Extract station ID from the module URLs
      const modules = data?.layout?.primary?.slots?.main?.modules || [];

      // Look for a module with a numeric station ID (prefer 48hourGraph)
      let stationId: string | null = null;
      for (const module of modules) {
        if (!module.dataUrl || !module.dataUrl.includes("/publicData/webdata/module/")) {
          continue;
        }

        // Try to extract station ID: /module/XXX/(\d+)/
        const match = module.dataUrl.match(/\/module\/[^/]+\/(\d+)\//);
        if (match && match[1]) {
          stationId = match[1];
          break;
        }
      }

      if (!stationId) {
        continue; // Try next endpoint
      }

      const locationLabel = data?.location?.label || location;
      return { stationId, locationLabel };
    } catch (e) {
      lastError = new Error(String(e));
      continue; // Try next endpoint
    }
  }

  throw new Error(
    `Location lookup failed for ${region}/${location}: ${lastError?.message || "Not found"}`
  );
}

async function getCurrentConditions(
  stationId: string
): Promise<CurrentWeather> {
  const url = `https://www.metservice.com/publicData/webdata/module/currentConditions/${stationId}/${stationId}?pagetype=48hr`;

  try {
    const data = await fetchJSON(url);
    const obs = data?.observations || {};

    return {
      temperature: obs?.temperature?.[0]?.current ?? 0,
      feelsLike: obs?.temperature?.[0]?.feelsLike ?? 0,
      humidity: obs?.rain?.[0]?.relativeHumidity ?? 0,
      wind: {
        speed: obs?.wind?.[0]?.averageSpeed ?? 0,
        direction: obs?.wind?.[0]?.direction ?? "N/A",
        gust: obs?.wind?.[0]?.gustSpeed ?? 0,
      },
      rainfall: obs?.rain?.[0]?.rainfall ?? 0,
      pressure: obs?.pressure?.[0]?.atSeaLevel ?? 0,
      source: data?.source || "MetService",
      asAt: data?.asAt || new Date().toISOString(),
    };
  } catch (e) {
    console.error(`Failed to get current conditions: ${e}`);
    return null!;
  }
}

async function get48HourForecast(stationId: string): Promise<HourlyForecast[]> {
  const url = `https://www.metservice.com/publicData/webdata/module/48hourGraph/${stationId}/${stationId}`;

  try {
    const data = await fetchJSON(url);
    const columns = data?.graph?.columns || [];

    return columns.slice(0, 48).map((col: any) => ({
      timestamp: col.date,
      temperature: parseFloat(col.temperature),
      rainfall: parseFloat(col.rainfall),
      rainPerHour: parseFloat(col.rainFallPerHour),
      wind: {
        speed: parseInt(col.wind?.speed || "0"),
        direction: col.wind?.direction || "N/A",
      },
    }));
  } catch (e) {
    console.error(`Failed to get 48-hour forecast: ${e}`);
    return [];
  }
}

async function getDailyForecast(
  stationId: string,
  locationKey: string
): Promise<DayForecast[]> {
  const url = `https://www.metservice.com/publicData/webdata/module/twoDayForecast/${stationId}/${locationKey}`;

  try {
    const data = await fetchJSON(url);
    const days = data?.days || [];

    return days.map((day: any) => ({
      date: day.date,
      condition: day.condition || "N/A",
      statement: day.forecasts?.[0]?.statement || "",
      highTemp: parseInt(day.highTemp || "0"),
      lowTemp: parseInt(day.lowTemp || "0"),
      sunrise: day.forecasts?.[0]?.sunrise || "",
      sunset: day.forecasts?.[0]?.sunset || "",
      breakdown: {
        morning: day.breakdown?.morning?.condition || "",
        afternoon: day.breakdown?.afternoon?.condition || "",
        evening: day.breakdown?.evening?.condition || "",
        overnight: day.breakdown?.overnight?.condition || "",
      },
    }));
  } catch (e) {
    console.error(`Failed to get daily forecast: ${e}`);
    return [];
  }
}

async function getWeather(
  region: string,
  location: string
): Promise<WeatherData> {
  const cacheKey = `${region}/${location}`;
  const now = Date.now();

  // Check cache
  if (cache[cacheKey] && cache[cacheKey].expires > now) {
    console.error(`[cache] Using cached data for ${cacheKey}`);
    return cache[cacheKey].data;
  }

  try {
    console.error(`[fetch] Getting location data for ${region}/${location}`);
    const { stationId, locationLabel } = await getLocationData(region, location);

    console.error(`[fetch] Station ID: ${stationId}`);

    const [current, next48Hours, dailyForecast] = await Promise.all([
      getCurrentConditions(stationId),
      get48HourForecast(stationId),
      getDailyForecast(stationId, `${location}_${location}`),
    ]);

    const weatherData: WeatherData = {
      location: locationLabel,
      region,
      current,
      next48Hours,
      dailyForecast,
      fetchedAt: new Date().toISOString(),
    };

    // Cache result
    cache[cacheKey] = {
      data: weatherData,
      expires: now + CACHE_TTL_MS,
    };

    return weatherData;
  } catch (e) {
    throw new Error(`Failed to fetch weather for ${region}/${location}: ${e}`);
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log("Usage: metservice-weather.ts <location-name>");
    console.log("   or: metservice-weather.ts <region> <location-path>");
    console.log("");
    console.log("Examples:");
    console.log("  metservice-weather.ts wanaka              # Search by name");
    console.log("  metservice-weather.ts queenstown          # Search by name");
    console.log("  metservice-weather.ts gore                # Search by name");
    console.log("  metservice-weather.ts auckland            # Search by name");
    console.log("");
    console.log("  metservice-weather.ts southern-lakes wanaka  # Direct lookup");
    process.exit(1);
  }

  try {
    let region: string;
    let location: string;

    if (args.length === 1) {
      // Search by location name
      const query = args[0];
      const found = await searchLocation(query);

      if (!found) {
        console.error(`Error: Location "${query}" not found`);
        console.error(`Try searching for a different location name`);
        process.exit(1);
      }

      region = found.region;
      location = found.location;
      console.error(`[found] ${found.label} (${region}/${location})`);
    } else {
      // Direct lookup with region and location
      region = args[0];
      location = args[1];
    }

    const weather = await getWeather(region, location);
    console.log(JSON.stringify(weather, null, 2));
  } catch (e) {
    console.error(`Error: ${e}`);
    process.exit(1);
  }
}

// Export for use as module
export { getWeather, WeatherData, CurrentWeather, DayForecast };

main();
