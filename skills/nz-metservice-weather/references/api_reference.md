# MetService NZ Weather API Reference

## Overview

This skill fetches current weather and forecasts from MetService's public API endpoints. Data includes:
- **Current conditions**: Temperature, humidity, wind, rainfall, pressure
- **Hourly forecast**: 48-hour outlook with temperature, wind, rainfall
- **Daily forecast**: Multiple-day summary with highs/lows and conditions
- **UV index**: Available in some responses (parsed when present)

## API Endpoints

### Location Data
**Request**: `GET /publicData/webdata/towns-cities/regions/{region}/locations/{location}`

Returns location metadata including station IDs embedded in module URLs.

**Example**: `https://www.metservice.com/publicData/webdata/towns-cities/regions/southern-lakes/locations/wanaka`

### Current Conditions
**Request**: `GET /publicData/webdata/module/currentConditions/{stationId}/{stationId}?pagetype=48hr`

Returns current temperature, humidity, wind, rainfall, pressure.

**Response fields**:
```json
{
  "observations": {
    "temperature": [{ "current": 13.1, "feelsLike": 13, "high": 22, "low": 7 }],
    "wind": [{ "averageSpeed": 7, "direction": "SE", "gustSpeed": 9 }],
    "rain": [{ "relativeHumidity": 53, "rainfall": 0.0 }],
    "pressure": [{ "atSeaLevel": 1013, "trend": "rising" }]
  },
  "source": "Wanaka Aero Automatic Weather Station (93729)",
  "asAt": "2026-02-22T23:00:00+13:00"
}
```

### 48-Hour Hourly Forecast
**Request**: `GET /publicData/webdata/module/48hourGraph/{stationId}/{stationId}`

Hourly temperature, wind, rainfall predictions for 48 hours.

**Response structure**:
```json
{
  "graph": {
    "columns": [
      {
        "date": "2026-02-22T01:00:00+13:00",
        "temperature": "10.7",
        "rainfall": 0.0,
        "rainFallPerHour": "0.0",
        "wind": { "direction": "W", "speed": "13" }
      }
    ]
  }
}
```

### Daily Forecast (2 Days)
**Request**: `GET /publicData/webdata/module/twoDayForecast/{stationId}/{locationKey}`

Multiple-day forecast with condition breakdown (morning/afternoon/evening/overnight).

**Response structure**:
```json
{
  "days": [
    {
      "date": "2026-02-22T12:00:00+13:00",
      "condition": "fine",
      "forecasts": [{
        "statement": "Fine. Westerlies.",
        "highTemp": "22",
        "lowTemp": "7",
        "sunrise": "2026-02-22T07:06:00+13:00",
        "sunset": "2026-02-22T20:46:00+13:00"
      }],
      "breakdown": {
        "morning": { "condition": "fine" },
        "afternoon": { "condition": "fine" },
        "evening": { "condition": "fine" },
        "overnight": { "condition": "few-showers" }
      }
    }
  ]
}
```

## Weather Conditions

Common condition values in forecasts:
- `fine` - Clear skies
- `mostly-fine` - Mostly clear
- `partly-cloudy` - Some clouds
- `cloudy` - Overcast
- `drizzle` - Light rain
- `rain` - Rain
- `heavy-rain` - Heavy rain
- `showers` - Intermittent showers
- `few-showers` - Scattered showers
- `windy` - Windy conditions
- `thunderstorm` - Severe weather

## Wind Directions

Compass directions used in API responses:
- N, NNE, NE, ENE (North quadrant)
- E, ESE, SE, SSE (East quadrant)
- S, SSW, SW, WSW (South quadrant)
- W, WNW, NW, NNW (West quadrant)

## Time Zones

All timestamps are in New Zealand time (NZDT +13:00 or NZST +12:00).

## Rate Limiting & Caching

- No explicit rate limits documented, but respect the API by caching results
- Default cache TTL: 30 minutes (results refresh ~4x daily with MetService model updates)
- Always include user-agent and handle connection errors gracefully

## Limitations

- **Search API not available**: Must use explicit region/location paths
- **5-day forecast limited**: Script currently fetches 2-day detailed forecast
- **Station IDs required**: Must extract from location response first
- **No HTTPS certificate pinning**: Standard HTTPS verification
