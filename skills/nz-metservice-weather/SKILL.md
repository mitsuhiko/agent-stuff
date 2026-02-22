---
name: nz-metservice-weather
description: Fetch accurate, current weather and multi-day forecasts for any NZ town or city using official MetService data. Provides temperature, wind, humidity, rainfall predictions, and condition forecasts. Use when other agents or the LLM need weather information to answer questions about NZ locations—e.g. "What's the weather in Wanaka?", "Should I go paddleboarding this weekend (no wind or rain)?", "What's the forecast for Friday?", "Will it rain in Wellington today?". Supports place names, Te Reo Māori location names, and postcodes via lookup.
---

# NZ MetService Weather Skill

Fetch current weather and forecasts from MetService (New Zealand's National Meteorological Service) for any NZ location.

## Quick Start

Run the weather client by location name:

```bash
# Search and fetch by location name (simplest)
npx tsx scripts/metservice-weather.ts wanaka
npx tsx scripts/metservice-weather.ts queenstown
npx tsx scripts/metservice-weather.ts gore
npx tsx scripts/metservice-weather.ts auckland
```

Or with explicit region/location path:

```bash
npx tsx scripts/metservice-weather.ts southern-lakes wanaka
npx tsx scripts/metservice-weather.ts northland whangarei
```

**Output**: JSON with current conditions, 48-hour hourly forecast, and 2-day daily forecast.

## Data Available

### Current Conditions
- **Temperature**: Current, feels-like, high, low
- **Wind**: Speed (km/h), direction (N/NE/E/etc.), gust speed
- **Humidity**: Relative humidity (%)
- **Rainfall**: Current amount (mm)
- **Pressure**: Sea level pressure (hPa) + trend

### Forecasts
- **Hourly (48h)**: Temperature, rainfall, rain/hour, wind direction/speed
- **Daily (2d)**: High/low temp, condition, sunrise/sunset, AM/afternoon/evening/overnight breakdown
- **Conditions**: fine, mostly-fine, cloudy, drizzle, rain, showers, windy, thunderstorm, etc.

## Location Search & Lookup

### Search by name (recommended)
Simply enter any NZ town or city name in lowercase:
```bash
npx tsx scripts/metservice-weather.ts wanaka
npx tsx scripts/metservice-weather.ts twizel
npx tsx scripts/metservice-weather.ts gore
```

The skill automatically searches MetService's location index and returns the first match. Works with 162+ NZ towns and rural locations.

### Direct lookup with region/location path
If you know the region and location path:
```bash
npx tsx scripts/metservice-weather.ts southern-lakes wanaka
npx tsx scripts/metservice-weather.ts west-coast christchurch
```

Supported regions: `northern-north-island`, `central-north-island`, `lower-north-island`, `northern-south-island`, `central-otago`, `southern-lakes`, `west-coast`, `southland`, `canterbury-high-country`, and others.

**Note**: Use lowercase English spellings when searching (e.g. `wanaka`, not `Wānaka`). The skill returns proper Te Reo spellings in results.

## API Details

MetService provides these public endpoints (no key required):
1. Location lookup: `GET /publicData/webdata/towns-cities/regions/{region}/locations/{location}`
2. Current conditions: `GET /publicData/webdata/module/currentConditions/{stationId}/{stationId}`
3. Hourly forecast: `GET /publicData/webdata/module/48hourGraph/{stationId}/{stationId}`
4. Daily forecast: `GET /publicData/webdata/module/twoDayForecast/{stationId}/{locationKey}`

Responses are in JSON format. Station IDs are extracted from location responses automatically.

See `references/api_reference.md` for full endpoint documentation and response schemas.

## Caching

Results are cached in-memory for 30 minutes to avoid hammering MetService's servers. Cache keys are `{region}/{location}`.

## Error Handling

The script handles:
- Network timeouts (10-second per-request timeout)
- Invalid locations (returns location-not-found error)
- API response parsing errors
- Missing station IDs

Errors are logged to stderr; exit code 1 on failure, 0 on success.

## Usage in OpenClaw

As a callable skill for other agents:

```bash
# Other skills/agents can call this
openclaw-skill-invoke nz-metservice-weather --region southern-lakes --location wanaka
```

Or programmatically import and use the TypeScript exports:

```typescript
import { getWeather } from './scripts/metservice-weather';

const weather = await getWeather('southern-lakes', 'wanaka');
console.log(`${weather.location}: ${weather.current.temperature}°C`);
```

## Notes

- **Data freshness**: MetService updates forecasts 4× daily (~6am, noon, 6pm, midnight NZT)
- **Time zones**: All timestamps in New Zealand time (NZDT +13:00 or NZST +12:00)
- **No strict rate limits**: Be respectful; cache results and avoid repeated queries within minutes
- **Attribution**: Observations credited to specific weather stations (e.g., "Wanaka Aero Automatic Weather Station")
