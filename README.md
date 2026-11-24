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
| Switch | flag | expose a panel LED / logic flag: observe it, trigger Home automations off it, and (by default) set it — `writable: false` for read‑only |
| Button (Stateless Programmable Switch) | flag | fire a HomeKit "press" event when a flag changes — wire a panel button to a flag in PROSOFT and trigger Home automations off the press |
| Matter Room Air Conditioner | climate / sensor zone | AC zones can instead (or also) be exposed as a native **Matter** air‑conditioner — see **[Matter air‑conditioning](docs/matter.md)** |

---

## Flags — panel buttons & indicators as HomeKit switches

A TELETASK **flag** is a global on/off value the central unit holds (it always lives on central
unit 0). Flags light panel‑button LEDs and feed PROSOFT logic, and — unlike a relay — a flag can
be both **read and set** over the protocol. That makes a flag the natural bridge between TELETASK
and HomeKit: expose one as a switch and Home automations can both *react to it* and *drive it*.

### 1. Create the flag in PROSOFT

1. Open your project and find the **Flags** list in the left‑hand tree.
2. Add a flag, name it, and note its **number** (e.g. `FLG 01`) — that number is the `outputId`
   you'll use in Homebridge.
3. Give it something to do:
   - **Track a button** — add a *Toggle Flag* action to a panel button, so pressing it flips the
     flag (and its LED).
   - **Track state** — point a button LED at the flag, or have a mood / logic function set it.
4. **Compile and download the project to the central unit.** A flag that exists only in the
   project, and hasn't been sent to the unit, does nothing.

### 2. Expose it as a HomeKit switch

```json
{ "name": "Hall Button", "type": "flag", "outputId": 1 }
```

- `outputId` is the PROSOFT flag number. **Don't set `centralUnit`** — flags are always unit 0.
- Flags are **auto‑discoverable**, so they can also appear on their own (as `Flag 1`, …) — see
  **[Auto‑discovery](docs/auto-discovery.md)**.
- The switch is **writable by default** (HomeKit can read *and* set the flag). For a pure
  indicator you never want HomeKit to change, add `"writable": false` and the tile snaps back on
  any tap.
- Prefer a press event over an on/off tile? Use `type: "button"` → **[Accessory types](docs/accessory-types.md)**.

### 3. Link a flag to lights — both ways

The common goal: a wall button toggles a flag, HomeKit lights follow the flag, **and** the flag
follows the lights — so the panel LED always matches the lights and **one press always does the
right thing**. Keep the flag **writable** (the default) and add **four Home automations**:

| When… | …do |
|---|---|
| *flag switch* turns **On** | lights **On** |
| *flag switch* turns **Off** | lights **Off** |
| lights turn **On** | *flag switch* **On** |
| lights turn **Off** | *flag switch* **Off** |

The first pair makes the button drive the lights; the second pair keeps the flag (and its LED)
correct when the lights are changed from anywhere else — Siri, the Home app, another switch — so
the next button press is never "a press behind".

> **It won't loop.** HomeKit automations fire on a *change*, not on steady state:
> `light on → flag on → light on (already on) → stops`. Each round settles in one pass.

### Gotchas

- **A writable flag fires whatever it drives.** If the flag triggers a PROSOFT mood, relay or
  logic block, a HomeKit write — or an accidental tile tap — runs it. Keep `writable: true` only
  on *dedicated* indicator / bridge flags; set `"writable": false` on anything load‑bearing.
- **Toggle, don't set.** For a button or a two‑way link, the PROSOFT action must **toggle** the
  flag. A button that *sets* it on can never turn it back off, so HomeKit and the LED drift out of
  sync.
- **Renaming in `config.json` doesn't rename the Home tile.** The plugin preserves existing
  accessory names so your Home‑app renames survive restarts — so rename flags (and everything
  else) in the **Home app**, not just the config.
- **Changing an accessory's `type` re‑creates it.** A flag's identity is `type` + number, so
  switching a flag between `flag` and `button` drops and re‑adds the HomeKit accessory, losing its
  room and automations. Changing only `writable` or the name is safe.
- **Licence required.** Flag state only flows while the **TDS15132 DoIP licence** is active on the
  central unit.

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
