# Auto‑discovery

Auto‑discovery keeps your config in sync with the central unit. It's **on by default**; set
`"autoDiscover": false` in the platform config to turn it off.

## What it does on startup

1. **Probes** the unit for every relay, dimmer, motor and sensor output that responds.
2. **Appends new outputs** — anything found that isn't already in your config — to the bottom
   of `config.json`, with a generic name and a `_note`:
   ```json
   { "name": "Light 14", "type": "light", "outputId": 14, "_note": "auto-discovered 2026-10-23 — rename, or set \"visible\": false to ignore" }
   ```
   New outputs also appear in HomeKit **immediately**, no second restart needed.
3. **Flags** any accessory already in your config whose number **doesn't respond** with a
   `_discoveryNote` (cleared automatically if it shows up again later).

It never rewrites your existing entries — your names, rooms and options are preserved. It only
**adds** and **flags**.

## Ignoring outputs you don't want

Set `"visible": false` on any accessory:

```json
{ "name": "Light 15", "type": "light", "outputId": 15, "visible": false }
```

The entry stays in the config (so it's not re‑added on the next startup) but is **hidden from
HomeKit**. This is the intended workflow for the spare/unused outputs discovery turns up:
hide them once, and they stay hidden, while genuinely new outputs still surface.

## Typical first‑run workflow

1. Enable the plugin with just `host`/`port` and restart.
2. Everything on the unit appears as `Light 1`, `Blind 3`, `Zone 4`, …
3. **Rename** the ones you use; **`"visible": false`** the ones you don't.
4. Add the finer options where needed (`powerRelay`, `temperatureFrom`, `maxBrightness`,
   `invertPosition`) — see [Accessory types](accessory-types.md).

After any future change in PROSOFT, new outputs just appear at the bottom of your config.

## What it can and can't infer

| Can infer (from the protocol) | Can't infer (you add these) |
|---|---|
| Which outputs exist, and their number | Friendly names and rooms |
| Base type (relay / dimmer / motor / sensor) | Light vs fan vs heating‑relay |
| Blinds need `invertPosition` | `powerRelay` / `temperatureFrom` pairings |
| Heating zones (have a live temperature) vs AC zones (don't) | `maxBrightness` / dimmer range |

Names, rooms and wiring details live in PROSOFT (in the encrypted `.NBT`), not in the runtime
protocol — so those stay a human step.

## Notes

- Discovery adds a few seconds to startup.
- It **writes `config.json`** (your platform block only) when there are changes, re‑formatting
  it to 4‑space indentation. Re‑runs with no changes write nothing.
- If the unit isn't licensed/reachable, discovery finds nothing and leaves your config alone.
