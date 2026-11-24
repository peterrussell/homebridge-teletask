# homebridge-teletask

Bridge a **TELETASK** DoIP home‑automation system into Apple **HomeKit** via
[Homebridge](https://homebridge.io) — lights, dimmers, blinds, fans, underfloor heating and
air‑conditioning, all controllable from the Home app and Siri.

> ⚠️ **Requires a TELETASK "DoIP Open Protocol" (TDS15132) licence** active on your central
> unit. Without it the plugin loads but can't control anything. A free 3‑day trial is
> available — see **[PROSOFT & licensing](docs/prosoft-and-licensing.md)**.

**Requirements:** Homebridge **1.6+** (Homebridge **2.x** for the native Matter
air‑conditioning), Node **18+**, and a TELETASK DoIP central unit on your LAN.

---

## Quick start

1. **Enable the DoIP Open Protocol** on your central unit (licence or 3‑day trial) →
   **[PROSOFT & licensing](docs/prosoft-and-licensing.md)**.
2. **Install** the plugin — in the Homebridge UI, search **`homebridge-teletask`** and click
   *Install* (or `sudo npm install -g homebridge-teletask`). More detail →
   **[Installation](docs/installation.md)**.
3. **Add the platform** to your Homebridge config (UI → *Config*, or `config.json`):
   ```json
   {
     "platform": "Teletask",
     "name": "Teletask",
     "host": "192.168.1.50",
     "port": 55957
   }
   ```
   Use your central unit's IP for `host`. That's the whole minimum config.
4. **Restart Homebridge.** Auto‑discovery is on by default, so every output on the unit
   appears in HomeKit automatically with generic names (`Light 1`, `Blind 3`, `Zone 4`…).
5. **Tidy up:** rename accessories, and set `"visible": false` on any you don't want. New
   outputs you add in PROSOFT later just appear at the bottom of your config next restart.

That's it. For anything beyond on/off — dimmer ranges, blinds, thermostats, pairing relays —
see the docs below.

---

## What it supports

| HomeKit | TELETASK | Notes |
|---|---|---|
| Lightbulb / Switch / Fan / Outlet | relay output | pick the `type` that suits |
| Lightbulb + brightness | dimmer | brightness‑range mapping; optional relay for a true off |
| Window Covering | motor | position + open/close |
| Thermostat | climate / sensor zone | heating **and** air‑conditioning, with setpoint & modes |
| Temperature Sensor | sensor zone | read‑only temperature |
| Switch (read‑only) | flag | expose a panel LED / logic flag so Home automations can react to it — HomeKit observes, never writes it back |
| Matter Room Air Conditioner | climate / sensor zone | AC zones can instead (or also) be exposed as a native **Matter** air‑conditioner — see **[Matter air‑conditioning](docs/matter.md)** |

---

## Documentation

- **[Installation & updates](docs/installation.md)** — install it and keep it updated.
- **[PROSOFT & licensing](docs/prosoft-and-licensing.md)** — the TDS15132 licence, the 3‑day
  trial, and how the DoIP ports work.
- **[Configuration reference](docs/configuration.md)** — every platform and accessory option.
- **[Accessory types](docs/accessory-types.md)** — lights, dimmers, blinds, thermostats and
  their options, with examples.
- **[Matter air‑conditioning](docs/matter.md)** — expose AC zones as a native Matter Room Air
  Conditioner (HomeKit and/or Matter, per zone).
- **[Auto‑discovery](docs/auto-discovery.md)** — how outputs appear automatically and how to
  ignore the ones you don't want.

---

## How it works (in one paragraph)

The plugin opens a TCP connection to your central unit and speaks TELETASK's **DoIP Open
Protocol** (the same protocol the official SDK uses). It reads device state, sends control
commands, and keeps the connection alive, mapping each TELETASK output onto a standard HomeKit
accessory. It needs no cloud — everything is local to your network.

## License

MIT. This is an independent, interoperability‑focused project and is not affiliated with or
endorsed by TELETASK.
