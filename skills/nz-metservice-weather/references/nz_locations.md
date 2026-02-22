# NZ MetService Locations

MetService organizes locations by region. Use format `region/location` when querying the API.

## How to Query

Query format: `metservice-weather.ts <region> <location>`

Example: `metservice-weather.ts southern-lakes wanaka`

## Location List

### Southern Lakes
- **wanaka** - Wānaka (Station 93729)
- **queenstown** - Queenstown
- **arrowtown** - Arrowtown
- **glenorchy** - Glenorchy

### West Coast
- **christchurch** - Christchurch
- **greymouth** - Greymouth
- **franz-josef** - Franz Josef
- **haast** - Haast

### Central Otago
- **alexandra** - Alexandra
- **clyde** - Clyde
- **bannockburn** - Bannockburn

### Southland
- **southland-invercargill** - Invercargill
- **te-anau** - Te Anau
- **milford-sound** - Milford Sound

### Northern South Island
- **nelson** - Nelson
- **blenheim** - Blenheim
- **picton** - Picton
- **westport** - Westport

### Wellington Region
- **wellington** - Wellington
- **masterton** - Masterton
- **lower-hutt** - Lower Hutt
- **upper-hutt** - Upper Hutt

### Manawatu
- **palmerston-north** - Palmerston North
- **dannevirke** - Dannevirke
- **feilding** - Feilding

### Taranaki
- **new-plymouth** - New Plymouth
- **stratford** - Stratford
- **opunake** - Opunake

### Waikato
- **hamilton** - Hamilton
- **cambridge** - Cambridge
- **matamata** - Matamata
- **tirau** - Tirau

### Bay of Plenty
- **tauranga** - Tauranga
- **rotorua** - Rotorua
- **whakatane** - Whakatane
- **kawerau** - Kawerau

### Hawkes Bay
- **napier** - Napier
- **hastings** - Hastings
- **wairoa** - Wairoa
- **havelock-north** - Havelock North

### Gisborne
- **gisborne** - Gisborne
- **tikitiki** - Tikitiki

### Manawatu / Rangitikei
- **rangitikei** - Rangitikei area
- **ohakea** - Ōhakea

### Auckland Region
- **auckland** - Auckland
- **north-shore-auckland** - North Shore
- **manukau** - Manukau
- **waitemata** - Waitemata
- **waitakere** - Waitakere

### Northland
- **whangarei** - Whangārei
- **kaitaia** - Kaitaia
- **dargaville** - Dargaville
- **kerikeri** - Kerikeri

### Rest of North Island
- **cambridge** - Cambridge
- **te-awamutu** - Te Awamutu
- **tirau** - Tirau

## Te Reo Māori Names

MetService uses proper Te Reo spellings in their API responses:
- Wānaka (not Wanaka)
- Ōhakea (not Ohakea)
- Whangārei (not Whangarei)
- Tauranga (uses macron when displayed)

When entering location searches, use lowercase English spellings (wanaka, not wānaka). The API will return the proper Te Reo spelling in the `location.label` field.

## Finding Your Location

If you don't know the exact region/location code:

1. Visit https://www.metservice.com/towns-cities
2. Use the search/browse interface to find your location
3. Note the URL structure: `.../regions/{region}/locations/{location}`
4. Use the last two path segments in your query

Example: If the URL is:
```
https://www.metservice.com/towns-cities/regions/southern-lakes/locations/wanaka
```

Use: `metservice-weather.ts southern-lakes wanaka`

## Regional Groupings

**North Island**:
- northern-north-island (Auckland, Northland, etc.)
- central-north-island (Waikato, Bay of Plenty, etc.)
- lower-north-island (Wellington, Manawatu, etc.)

**South Island**:
- northern-south-island (Nelson, Marlborough, etc.)
- central-otago (Alexandra, Clyde, etc.)
- southern-lakes (Wānaka, Queenstown, etc.)
- west-coast (Christchurch, Greymouth, etc.)
- southland (Invercargill, Te Anau, etc.)

## Missing Locations?

Not all NZ towns/suburbs are in the MetService towns-cities index. For smaller locations, find the nearest city and use that. Larger automated weather stations may have separate location entries.
