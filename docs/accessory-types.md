# Accessory types

Every accessory maps a TELETASK output onto a HomeKit service. Pick the `type` that matches
what the output actually drives.

## Lights, switches, fans, outlets — relay outputs

All four are the same relay under the hood; the `type` just changes how it looks in HomeKit.

```json
{ "name": "Kitchen Light", "type": "light",  "outputId": 13 }
{ "name": "Pump",          "type": "switch", "outputId": 24 }
{ "name": "Bathroom Fan",  "type": "fan",    "outputId": 4 }
{ "name": "Patio Socket",  "type": "outlet", "outputId": 7 }
```

The protocol can't tell a light from a fan from a pump — they're all relays — so choosing the
right `type` is up to you.

## Dimmers

A TELETASK dimmer takes a **level only** (0 = off, >0 = on); there's no separate on/off
command. The plugin handles that for you, and adds two refinements:

```json
{ "name": "Living Room Dimmer", "type": "dimmer", "outputId": 1, "minBrightness": 10, "maxBrightness": 75, "powerRelay": 16 }
```

- **`maxBrightness` / `minBrightness`** — map HomeKit's 1–100 % slider onto the lamp's real
  usable range. If your light stops getting brighter above 75 %, set `maxBrightness: 75` so
  HomeKit 100 % = level 75. If it won't go dim at the bottom, raise `minBrightness`.
- **`powerRelay`** — many TELETASK dimmers can't fully switch the lamp off at level 0. If a
  relay cuts the lamp's power, give its number here and HomeKit **off** will use the relay for
  a true off (and on restores the last level).

## Blinds / window coverings

```json
{ "name": "Living Room Blind", "type": "blind", "outputId": 5, "invertPosition": true }
```

- **`invertPosition`** — TELETASK motors usually treat 0 % as up/open and 100 % as
  down/closed, which is the opposite of HomeKit. Set `true` if open/closed is reversed.

## Thermostats — heating & air‑conditioning

A TELETASK **climate/sensor zone** becomes a HomeKit Thermostat with current temperature,
setpoint and mode.

```json
{ "name": "Living Room Heating", "type": "thermostat", "outputId": 3, "climate": "heat" }
{ "name": "Living Room Aircon",  "type": "thermostat", "outputId": 9, "climate": "auto", "temperatureFrom": 3 }
```

- **`climate`** — restricts the modes offered: `heat` (radiators/underfloor), `cool`
  (cooling only), or `auto` (heat + cool + auto, e.g. reverse‑cycle AC).
- **`expose`** — `homekit` (default, a HomeKit Thermostat) or `matter` (a native Matter Room Air
  Conditioner). One only. See **[Matter air‑conditioning](matter.md)**.
- **`temperatureFrom`** — some AC zones report no temperature of their own. Point this at a
  sensor zone in the same room (e.g. the radiator zone) and the thermostat borrows that
  reading.
- **`powerRelay`** — ⚠️ **normally leave this off for a climate zone.** On/off is handled by the
  zone itself (its `TEMP_ON_OFF`), which also makes the Target follow the Day preset — turning the
  zone on is what lets your setpoint take effect. Do **not** point `powerRelay` at the zone's own
  heating/cooling **output** relay: that relay only follows live demand (on while actually heating),
  so using it for on/off leaves the zone disabled and the Target stuck at the frost value. Only use
  `powerRelay` if you have a genuinely separate relay that cuts power to the whole zone independently.

### How setpoints and off work

Setpoints are applied via the zone's **Day preset** (the DoIP protocol has no absolute
"set target"). Off/on uses the zone's power toggle, or your `powerRelay` if set. Reading the
temperature is reliable; if a setpoint or mode change doesn't take on your firmware, use
`powerRelay` for on/off and adjust in PROSOFT.

## Temperature sensors

For a read‑only temperature reading (no control):

```json
{ "name": "Outside Temp", "type": "sensor", "outputId": 12 }
```

## Flags — switches (panel LEDs, logic flags)

A TELETASK **flag** is a global boolean that drives panel‑button LEDs and PROSOFT logic. Expose
one as a HomeKit switch so Home can observe its state, trigger automations off it, and (by
default) set it:

```json
{ "name": "Hall LED", "type": "flag", "outputId": 12 }
```

- `outputId` is the **flag number** from PROSOFT (not a relay/output number). Find it in PROSOFT
  under the **Flags** function list (or the Hierarchic List) — or let **[auto‑discovery](auto-discovery.md)**
  find your flags (it probes flags on central unit 0 and adds any it sees).
- Flags are global, so **don't** set `centralUnit` — they're always addressed on central unit 0.
- The switch is **writable by default** (see below). Set `"writable": false` to make it
  read‑only, so HomeKit can observe the flag but tapping the tile won't change it (the toggle
  snaps back) and PROSOFT keeps full control.

### Why this is useful

The flag becomes a single source of truth you can fan out from. Whatever sets the flag in
TELETASK (a wall‑panel button, a mood, PROSOFT logic) lights the LED **and** flips this HomeKit
switch, so a Home automation — *"When Hall LED turns on…"* — can drive any non‑TELETASK HomeKit
device (Hue lights, a speaker, a smart plug) alongside the PROSOFT‑configured actions.

> **Live state needs the flag to report.** The plugin subscribes to flags on connect, so a flag
> that changes in TELETASK updates the switch. Confirm the switch tracks the LED on your unit —
> if it doesn't move, check that the flag is configured to report (and that the TDS15132 licence
> is active so the unit pushes state).

### Two‑way sync — `writable`

The flag switch is **writable by default**, meaning HomeKit can **set** the flag (and its panel
LED) as well as read it. Set `"writable": false` for a read‑only flag:

```json
{ "name": "Bedroom Button 1", "type": "flag", "outputId": 1 }
{ "name": "Alarm State",      "type": "flag", "outputId": 20, "writable": false }
```

Writability lets you keep a **dedicated indicator flag** in sync with other HomeKit accessories.
Say a panel button toggles a flag that mirrors a light: if the flag can't be written, pressing
the button after the light was changed elsewhere leaves the flag stale, so the next press does
nothing (you have to press twice). With a writable flag you can add the *reverse* automations —

- **Light turns On → Bedroom Button 1 On**
- **Light turns Off → Bedroom Button 1 Off**

— so the flag (and its LED) always follows the light, and one press always does the right thing.
Apple Home won't loop: automations fire on a *change*, so `light on → flag on → light on`
(already on) settles after one pass.

- ⚠️ A writable flag that **drives PROSOFT logic** (a mood, relay or condition) will **actuate
  that logic** when HomeKit sets it — including a stray tile tap. For flags like that, set
  `"writable": false`. (Auto‑discovered flags are writable by default too, so review anything
  discovery adds that you don't recognise.)
- `writable` does not change the accessory's identity, so flipping it never re‑creates the
  accessory (your existing automations survive).

## Buttons — flag → a HomeKit "button" (press events)

Same underlying **flag**, but exposed as a HomeKit **button** (a *Stateless Programmable
Switch*) instead of a switch. Use this when you want the panel button to *trigger* Home
automations — in the Automation screen it reads **"When … is pressed"** rather than "Turns
On / Turns Off":

```json
{ "name": "Bedroom Button 1", "type": "button", "outputId": 1 }
```

- `outputId` is the **flag number** from PROSOFT (exactly as for `flag`). Auto-discovery adds
  flags as the `flag` switch type; to use one as a button instead, add it by hand (or change a
  discovered entry's `type` to `button`).
- Every change of the flag fires a **single-press** event. HomeKit buttons have no persistent
  state, so there's no on/off tile — only the press trigger.
- **Wire the panel button to *toggle* the flag** in PROSOFT. A toggle flag gives exactly one
  press event per physical press. A *momentary/pulse* flag (on then auto-off) fires **twice**
  per press (once for on, once for off), so prefer toggle unless you specifically want that.
- A flag reports only single-press (a flag is one bit, so single vs double vs long can't be
  distinguished).

**`flag` vs `button`:** use `flag` when you want to *read* the LED/flag state as an on/off
switch (and react to on **or** off separately); use `button` when you just want "the button
was pressed → run this". Both point at the same PROSOFT flag number.
