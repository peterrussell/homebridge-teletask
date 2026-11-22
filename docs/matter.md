# Matter air‑conditioning

A TELETASK climate zone can be exposed as a **native Matter Room Air Conditioner**
instead of (or as well as) the HomeKit Thermostat. Matter has a purpose‑built
air‑conditioner device type — on/off, a cooling (and/or heating) setpoint, the
current temperature and heat/cool/auto modes — which maps onto an AC zone far more
naturally than HomeKit's radiator‑shaped Thermostat.

This is **opt‑in per zone** and never replaces the HomeKit heating support. By
default every climate zone stays a HomeKit Thermostat exactly as before.

## Requirements

- **Homebridge 2.x with Matter enabled** on the bridge (or child bridge) that runs
  this plugin. In the Homebridge UI: the plugin's ⋮ menu → *Bridge Settings* →
  enable Matter (running the plugin in its **own child bridge** is recommended, so
  Matter is scoped to it).
- Everything the plugin normally needs: the TDS15132 licence and a reachable unit.

## Turning it on

Set `expose` on a climate accessory, or `defaultExpose` on the platform:

A zone is exposed to **one** of HomeKit or Matter — not both (two controllers on one
zone floods the central unit).

| Value       | Result |
|-------------|--------|
| `default`   | **Home Default** — follow the platform `defaultExpose` (this is also what leaving `expose` unset does). |
| `homekit`   | HomeKit Thermostat (the overall default — unchanged behaviour). |
| `matter`    | Native Matter Room Air Conditioner. |

```json
{
  "platform": "Teletask",
  "host": "192.168.1.113",
  "defaultExpose": "homekit",
  "accessories": [
    {
      "name": "Living Room AC",
      "type": "thermostat",
      "outputId": 9,
      "climate": "cool",
      "temperatureFrom": 3,
      "expose": "matter"
    }
  ]
}
```

- `climate` still controls which modes the AC offers: `cool` → cooling only,
  `heat` → heating only, `auto` → a heat **and** cool zone.
- `temperatureFrom` and `powerRelay` work exactly as they do for the HomeKit
  thermostat — the two front‑ends share one control core, so they behave identically.

> **No Auto mode on the Matter AC.** The Matter Room Air Conditioner exposes
> **Off / Heat / Cool** only. Matter's `RoomAirConditioner` can't carry the AutoMode
> feature through Homebridge's accessory cache (it errors on every restart), so a
> heat+cool (`auto`) zone is shown as whatever it's currently running. Use the **HomeKit**
> thermostat for that zone if you want an Auto mode.

## Pairing (important)

Matter accessories are **not** HAP accessories — they do **not** appear through the
plugin's normal HomeKit bridge. After enabling Matter and restarting:

1. Open the Homebridge UI → the (child) bridge's Matter section shows a **Matter
   pairing code / QR**.
2. In Apple Home (or Alexa, Google, …): *Add Accessory* → scan that Matter code.
3. The zone shows up as an air‑conditioner.

Each zone is HomeKit **or** Matter, so you won't get duplicate tiles. To switch a zone
from HomeKit to Matter (or back), change its `expose` and restart — the old tile is
removed and the new one appears (Matter ones need the pairing step above).

## What maps to what

| Matter (Room Air Conditioner) | TELETASK |
|---|---|
| On / Off | zone `SET_TEMPONOFF` toggle, or `powerRelay` if set |
| System mode Cool / Heat | zone mode (96 / 95) via `setHeatingMode` (no Auto — see note above) |
| Cooling / heating setpoint | `setHeatingTargetTemperature` (one target; both setpoints mirror it) |
| Local / measured temperature | the zone's sensor, or `temperatureFrom` |

TELETASK exposes no fan‑speed control for a climate zone, so the AC has no fan‑speed
slider (the Matter fan is left at automatic).
