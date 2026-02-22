# NZ MetService Weather Skill

A production-ready OpenClaw skill for fetching current weather and forecasts from MetService (New Zealand's National Meteorological Service).

## Features

✅ **Current Conditions**
- Temperature (current, feels-like, high, low)
- Wind (speed, direction, gust)
- Humidity & rainfall
- Pressure & trends
- Weather station attribution

✅ **Forecasts**
- 48-hour hourly: temperature, wind, rainfall predictions
- 2-day daily: highs/lows, conditions, sunrise/sunset
- Period breakdowns (morning/afternoon/evening/overnight)

✅ **Smart Features**
- Automatic station ID extraction
- In-memory caching (30-minute TTL)
- Proper Te Reo Māori location names
- Full error handling & logging
- No API key required (uses public endpoints)

## Installation

```bash
# Install dependencies
npm install

# Run weather query
npx tsx scripts/metservice-weather.ts <region> <location>
```

## Examples

```bash
# Wanaka weather
npx tsx scripts/metservice-weather.ts southern-lakes wanaka

# Wellington forecast
npx tsx scripts/metservice-weather.ts lower-north-island wellington

# Christchurch conditions
npx tsx scripts/metservice-weather.ts west-coast christchurch
```

**Output**: Structured JSON with all weather data, forecasts, and timestamps.

## Locations

Locations are organized by region. Common regions:
- `southern-lakes` - Wanaka, Queenstown, Arrowtown
- `west-coast` - Christchurch, Greymouth, Franz Josef
- `lower-north-island` - Wellington, Masterton
- `northern-north-island` - Auckland, Whangarei

See `references/nz_locations.md` for the complete list.

## API

The skill queries MetService's public APIs:
1. **Location lookup**: Extracts station IDs from location metadata
2. **Current conditions**: Real-time observations from automated weather stations
3. **48-hour forecast**: Hourly predictions
4. **Daily forecast**: 2-day summary with condition breakdowns

See `references/api_reference.md` for full API documentation.

## TypeScript Module

Use as a TypeScript module in other projects:

```typescript
import { getWeather } from './scripts/metservice-weather';

const weather = await getWeather('southern-lakes', 'wanaka');
console.log(`${weather.location}: ${weather.current.temperature}°C`);
console.log(`Wind: ${weather.current.wind.direction} ${weather.current.wind.speed} km/h`);
console.log(`Forecast: ${weather.dailyForecast[0].statement}`);
```

## Skill Design

- **SKILL.md**: Frontmatter + usage guide
- **scripts/metservice-weather.ts**: Main TypeScript client
- **references/api_reference.md**: MetService API documentation
- **references/nz_locations.md**: Location/region mapping
- **package.json**: TypeScript build configuration

## Notes

- All timestamps in New Zealand time (NZDT +13:00 or NZST +12:00)
- MetService updates forecasts 4× daily (~6am, noon, 6pm, midnight NZT)
- No strict rate limits, but caching is enabled to be respectful
- Data sourced from automated weather stations across NZ
