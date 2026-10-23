# Accessory types

Every accessory maps a TELETASK output onto a HomeKit service. Pick the `type` that matches
what the output actually drives.

## Lights, switches, fans, outlets — relay outputs

All four are the same relay under the hood; the `type` just changes how it looks in HomeKit.

```json
{ "name": "Kitchen Light", "type": "light",  "number": 13 }
{ "name": "Pump",          "type": "switch", "number": 24 }
{ "name": "Bathroom Fan",  "type": "fan",    "number": 4 }
{ "name": "Patio Socket",  "type": "outlet", "number": 7 }
```

The protocol can't tell a light from a fan from a pump — they're all relays — so choosing the
right `type` is up to you.

## Dimmers

A TELETASK dimmer takes a **level only** (0 = off, >0 = on); there's no separate on/off
command. The plugin handles that for you, and adds two refinements:

```json
{ "name": "Living Room Dimmer", "type": "dimmer", "number": 1, "minBrightness": 10, "maxBrightness": 75, "powerRelay": 16 }
```

- **`maxBrightness` / `minBrightness`** — map HomeKit's 1–100 % slider onto the lamp's real
  usable range. If your light stops getting brighter above 75 %, set `maxBrightness: 75` so
  HomeKit 100 % = level 75. If it won't go dim at the bottom, raise `minBrightness`.
- **`powerRelay`** — many TELETASK dimmers can't fully switch the lamp off at level 0. If a
  relay cuts the lamp's power, give its number here and HomeKit **off** will use the relay for
  a true off (and on restores the last level).

## Blinds / window coverings

```json
{ "name": "Living Room Blind", "type": "blind", "number": 5, "invertPosition": true }
```

- **`invertPosition`** — TELETASK motors usually treat 0 % as up/open and 100 % as
  down/closed, which is the opposite of HomeKit. Set `true` if open/closed is reversed.

## Thermostats — heating & air‑conditioning

A TELETASK **climate/sensor zone** becomes a HomeKit Thermostat with current temperature,
setpoint and mode.

```json
{ "name": "Living Room Heating", "type": "thermostat", "number": 3, "climate": "heat", "powerRelay": 17 }
{ "name": "Living Room Aircon",  "type": "thermostat", "number": 9, "climate": "auto", "temperatureFrom": 3 }
```

- **`climate`** — restricts the modes HomeKit offers: `heat` (radiators/underfloor), `cool`
  (cooling only), or `auto` (heat + cool + auto, e.g. reverse‑cycle AC).
- **`temperatureFrom`** — some AC zones report no temperature of their own. Point this at a
  sensor zone in the same room (e.g. the radiator zone) and the thermostat borrows that
  reading.
- **`powerRelay`** — drive the zone's on/off from a relay (e.g. an underfloor‑heating circuit)
  instead of the zone's own power toggle.

### How setpoints and off work

Setpoints are applied via the zone's **Day preset** (the DoIP protocol has no absolute
"set target"). Off/on uses the zone's power toggle, or your `powerRelay` if set. Reading the
temperature is reliable; if a setpoint or mode change doesn't take on your firmware, use
`powerRelay` for on/off and adjust in PROSOFT.

## Temperature sensors

For a read‑only temperature reading (no control):

```json
{ "name": "Outside Temp", "type": "sensor", "number": 12 }
```
