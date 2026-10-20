# Cebu Island overview

The initial main map uses Leaflet `fitBounds()` with the coastline bounds of **Cebu Island**, not the administrative province.

## Geographic source

- OpenStreetMap [Cebu island relation 3604190](https://www.openstreetmap.org/relation/3604190), tagged `place=island`.
- Verified 2026-10-20 using [Nominatim's Cebu Island polygon response](https://nominatim.openstreetmap.org/search?q=Cebu%20Island%2C%20Philippines&format=jsonv2&polygon_geojson=1).
- The dominant polygon has 20,049 coastline coordinates. Its extrema are south **9.4128637**, north **11.2857272**, west **123.2963877**, east **124.0702215**. The other tiny polygon in the relation lies inside the same bounds. Bantayan, Malapascua, and Camotes are not included.
- Geographic data © OpenStreetMap contributors, [ODbL](https://www.openstreetmap.org/copyright). No geometry payload or additional geographic API request is needed at runtime.

## Lifecycle

`ResizeObserver` and explicit welcome/tab visibility hooks schedule a layout refresh on the next animation frame. A zero-size hidden container is ignored. Once visible, Leaflet invalidates the size, then fits the bounds with horizontal padding of 5% (capped at 32px) and 24px vertical padding. A 0.25 zoom snap uses the container height efficiently for the long north–south coastline.

The overview is fitted again on actual dimension changes only while it is still the initial overview. A user pan/zoom or an application location action permanently stops automatic overview fitting for that page load. Later tab changes only refresh Leaflet's dimensions; they do not reset the chosen view. GPS, search, report selection and the separate exact-location picker retain their own location behavior.
