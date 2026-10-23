# Configuration reference

Configuration is a single **platform** block with a list of **accessories**. You can edit it
in the Homebridge UI (*Config*) or in `config.json`.

```json
{
  "platform": "Teletask",
  "name": "Teletask",
  "host": "192.168.1.50",
  "port": 55957,
  "centralUnit": 1,
  "autoDiscover": true,
  "accessories": [
    { "name": "Kitchen Light", "type": "light", "number": 13 },
    { "name": "Living Room Dimmer", "type": "dimmer", "number": 1, "maxBrightness": 75, "powerRelay": 16 },
    { "name": "Living Room Blind", "type": "blind", "number": 5, "invertPosition": true },
    { "name": "Living Room Heating", "type": "thermostat", "number": 3, "climate": "heat", "powerRelay": 17 },
    { "name": "Living Room Aircon", "type": "thermostat", "number": 9, "climate": "auto", "temperatureFrom": 3 }
  ]
}
```

## Platform options

| Option | Type | Default | Description |
|---|---|---|---|
| `platform` | string | — | Must be `"Teletask"`. |
| `name` | string | `"Teletask"` | Platform name shown in logs. |
| `host` | string | — | **Required.** Central unit IP address. |
| `port` | number | `55957` | DoIP Open Protocol port. Leave as default. |
| `centralUnit` | number | `1` | Central unit index (1 = "A"). Overridable per accessory. |
| `autoDiscover` | boolean | `true` | Probe the unit on startup and add new outputs automatically. Set `false` to disable. See [Auto‑discovery](auto-discovery.md). |
| `accessories` | array | `[]` | Your devices (below). |

## Accessory options

Every accessory needs at least `name`, `type` and `number`.

| Option | Applies to | Description |
|---|---|---|
| `name` | all | HomeKit name. |
| `type` | all | `light`, `switch`, `fan`, `outlet`, `dimmer`, `blind`, `thermostat` (alias `heating`), `sensor`. |
| `number` | all | The output number from PROSOFT (GUISOFT → *Define Output*). |
| `centralUnit` | all | Overrides the platform default for this accessory. |
| `visible` | all | `false` keeps the entry in the config but hides it from HomeKit. |
| `invertPosition` | blind | Flip if open/closed is reversed (TELETASK blinds are usually inverted → `true`). |
| `minBrightness` / `maxBrightness` | dimmer | Map HomeKit 1–100 % onto the lamp's real usable range. |
| `powerRelay` | dimmer, thermostat | A relay output number used for true on/off. |
| `climate` | thermostat | `heat`, `cool`, or `auto` (both + auto). |
| `temperatureFrom` | thermostat | Read the current temperature from another zone's sensor (for AC zones without their own). |

See **[Accessory types](accessory-types.md)** for what each type does and worked examples.

## Finding output numbers

Numbers come from your PROSOFT project (GUISOFT → *Define Output*). Each function type
(relay, dimmer, motor, sensor) has its **own** numbering, so relay 1, dimmer 1 and motor 1 are
three different devices — the plugin picks the right one from the accessory's `type`.

Tip: with `autoDiscover` on (the default), you don't have to look these up by hand — the
plugin lists everything it finds and you just rename and tidy.

## A note on `_note` / `_discoveryNote`

Auto‑discovery may add `_note` or `_discoveryNote` keys to entries. These are informational
only — the plugin ignores them, and you can delete them freely.
