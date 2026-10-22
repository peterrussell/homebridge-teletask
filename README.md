# homebridge-teletask

A [Homebridge](https://homebridge.io) plugin that bridges **TELETASK DoIP** devices — relays
(lights/switches/fans/outlets), dimmers, blinds/motors and sensors — into Apple **HomeKit**,
using the local [`teletask-api`](../) library.

## ⚠️ Requires a TDS15132 license

Like any third-party TELETASK integration, this plugin talks to the central unit's **DoIP Open
Protocol on TCP port 55957**, which is **license-gated**: the unit ignores commands until a
`TDS15132` (DoIP Open Protocol) license is active (a 3-day trial opens after a PROSOFT config
download; permanent use needs the license `.act` imported in PROSOFT). The plugin will still
load and expose accessories without it, but switching anything won't take effect until the
license is active. See the [library README](../README.md#️-important-local-control-requires-a-tds15132-license)
for the full picture.

## Install

From the Homebridge UI, search for **Teletask** — or manually:

```bash
# in this repo (installs the local teletask-api dependency too)
cd homebridge-teletask
npm install
# then point Homebridge at this folder, or `npm link` it
```

## Configuration

Add a platform block to your Homebridge `config.json` (or use the settings UI, which reads
`config.schema.json`):

```json
{
  "platforms": [
    {
      "platform": "Teletask",
      "name": "Teletask",
      "host": "192.168.1.113",
      "port": 55957,
      "centralUnit": 1,
      "accessories": [
        { "name": "Main Hall",     "type": "light", "number": 1 },
        { "name": "Hall Bedroom",  "type": "light", "number": 2 },
        { "name": "Bathroom",      "type": "light", "number": 3 },
        { "name": "Bathroom Fan",  "type": "fan",   "number": 4 },
        { "name": "Master Suite",  "type": "light", "number": 5 },
        { "name": "Master Bath",   "type": "light", "number": 6 },
        { "name": "Master Fan",    "type": "fan",   "number": 7 },
        { "name": "Back Bedroom",  "type": "light", "number": 8 }
      ]
    }
  ]
}
```

The example above mirrors the 8 built-in relay outputs of a PICOS as defined in PROSOFT
(outputs 4 and 7 are "Ventax" ventilation fans, so they're mapped as `fan`). Use your own
project's **Define Output** screen to read the output numbers.

### Accessory options

| Field | Required | Notes |
|-------|----------|-------|
| `name` | yes | HomeKit name |
| `type` | yes | `light`, `switch`, `fan`, `outlet`, `dimmer`, `blind`, `thermostat`, `sensor` |
| `number` | yes | output/function number from PROSOFT |
| `centralUnit` | no | overrides the platform default (1) |
| `invertPosition` | no | blinds only — flip if open/closed is reversed |

### Type → HomeKit mapping

| `type` | TELETASK function | HomeKit service |
|--------|-------------------|-----------------|
| `light` | relay | Lightbulb |
| `switch` | relay | Switch |
| `fan` | relay | Fan |
| `outlet` | relay | Outlet |
| `dimmer` | dimmer | Lightbulb + Brightness |
| `blind` | motor | Window Covering |
| `thermostat` | sensor/climate | Thermostat *(experimental)* |
| `sensor` | sensor | Temperature Sensor |

## How it works

On launch the plugin connects to the central unit with `teletask-api`, registers one HomeKit
accessory per configured device, and subscribes to state changes. HomeKit actions (on/off,
brightness, blind position, setpoint) are translated to DoIP `Device Set` commands; pushed
state reports update the matching HomeKit characteristics in real time. It keeps the socket
alive and reconnects automatically if the connection drops.

## Caveats

- **Blinds** use position passthrough by default; if open/closed looks reversed, set
  `invertPosition: true`. Motors without position feedback report limited state.
- **Thermostat/sensor** support is experimental — the sensor/climate value format differs
  between protocol generations (2-byte legacy vs IEEE-754 float). Verify against your unit.
- Well-exercised paths are lights, switches, fans, outlets and dimmers (relay/dimmer).

MIT.
