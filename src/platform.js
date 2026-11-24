// CommonJS plugin. js-teletask-api is an ES module, so it's loaded lazily via dynamic
// import() inside _start() (which runs async on didFinishLaunching).
const { PLATFORM_NAME, PLUGIN_NAME } = require("./settings.js");
const { makeClimateControl } = require("./climate-core.js");
const { registerTeletaskMatterAircon } = require("./matter-aircon.js");

const RECONNECT_MS = 10000;

// TELETASK FLAG function code (TDS15132 §5). Flags are global (central unit 0) booleans
// that drive panel-button LEDs and PROSOFT logic. We expose them either as a read-only
// HomeKit switch ("flag" — observe the LED state) or as a HomeKit button / Stateless
// Programmable Switch ("button" — fire a press event on each flag change). Both are
// backed by the same FLAG function; HomeKit never writes the flag back.
const FUNCTION_FLAG = 15;

// Accessory types that are climate zones (can be a HomeKit Thermostat and/or a
// native Matter Room Air Conditioner).
const CLIMATE_TYPES = new Set(["thermostat", "heating"]);

// Normalise the per-accessory (or platform default) `expose` option.
// "homekit" (default) = HomeKit Thermostat; "matter" = native Matter Room AC.
// "default"/"none"/unset ⇒ defer to the platform default, then to "homekit".
// A zone is exposed to exactly ONE of HomeKit or Matter — exposing both at once
// put two controllers on the same zone and flooded the central unit, so the legacy
// "both" value is treated as unset (falls back to the default). Climate zones only.
function normalizeExpose(value, fallback) {
  const one = (x) => {
    const v = String(x ?? "").trim().toLowerCase();
    if (v === "matter" || v === "homekit") return v;
    if (v === "hap" || v === "homekit-only") return "homekit";
    return null; // "default", "none", "both" (legacy), "", unknown → use the fallback
  };
  return one(value) ?? one(fallback) ?? "homekit";
}
const exposesHomeKit = (e) => e === "homekit";
const exposesMatter = (e) => e === "matter";

// Teletask function codes <-> HomeKit type, for auto-discovery.
const FN_FOR_TYPE = { light: 1, switch: 1, fan: 1, outlet: 1, dimmer: 2, blind: 6, cover: 6, window: 6, shade: 6, thermostat: 20, heating: 20, sensor: 20, flag: 15, button: 15 };
const TYPE_FOR_FN = { 1: "light", 2: "dimmer", 6: "blind", 20: "thermostat", 15: "flag" };
const LABEL_FOR_FN = { 1: "Light", 2: "Dimmer", 6: "Blind", 20: "Zone", 15: "Flag" };

// PROSOFT-style reference prefix per accessory type. The central unit holds no readable
// names for its outputs (those live only in the encrypted PROSOFT project), but the
// TELETASK id — REL/DIM/MOT/SEN/FLG + number — is derivable from type + number, and is
// exactly what you look an accessory up by in PROSOFT. We fill it as a read-only hint.
const REF_PREFIX = {
  light: "REL", switch: "REL", fan: "REL", outlet: "REL",
  dimmer: "DIM",
  blind: "MOT", cover: "MOT", window: "MOT", shade: "MOT",
  thermostat: "SEN", heating: "SEN", sensor: "SEN", temperature: "SEN",
  flag: "FLG", button: "FLG"
};
function prosoftRefFor(type, number) {
  const p = REF_PREFIX[String(type ?? "").toLowerCase()];
  const n = Number(number);
  if (!p || !Number.isFinite(n)) return null;
  return `${p} ${String(n).padStart(2, "0")}`;
}

// Discovery-time "looks unused" heuristic. The DoIP state byte can't *prove* a load is
// wired — verified against a real unit: a switched-ON relay reads 0xFF, identical to an
// unused one, and an unused motor reads like a fully-closed blind. So we never auto-hide;
// we only add a note on NEW outputs whose state matches an unused fingerprint, so they're
// easy to spot and hide by hand (set "visible": false).
function likelyUnusedHint(functionCode, state) {
  if (functionCode === 1 && (state?.[0] ?? 0) !== 0) {
    return "reads ON at discovery — if this isn't a light you left on, it's likely unused";
  }
  if (functionCode === 6 && (state?.[0] ?? 0) === 2 && (state?.[3] ?? 0) === 100) {
    return "reads fully-closed/idle at discovery — if this isn't a blind you keep closed, it's likely unused";
  }
  return null;
}

// Dynamic Homebridge platform that bridges TELETASK DoIP devices into HomeKit.
class TeletaskPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config ?? {};
    this.api = api;
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    // uuid -> restored PlatformAccessory (from disk cache)
    this.cachedAccessories = new Map();
    // deviceId -> { accessory, device, update(state) }  (HomeKit/HAP accessories)
    this.handlers = new Map();
    // deviceId -> { uuid, device, push() }  (native Matter accessories)
    this.matterDevices = new Map();
    this.client = null;
    this.reconnectTimer = null;

    if (!this.config.host) {
      this.log.error('Missing "host" in config — the Teletask platform will not start.');
      return;
    }

    this.devices = this._buildDevices();

    this.api.on("didFinishLaunching", () => this._start());
    this.api.on("shutdown", () => this._shutdown());
  }

  // Homebridge calls this for each accessory restored from its cache.
  configureAccessory(accessory) {
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  _buildDevices() {
    const defaultCU = Number(this.config.centralUnit ?? 1);
    const list = Array.isArray(this.config.accessories) ? this.config.accessories : [];
    return list
      .filter((a) => a && a.type && (a.outputId ?? a.number) !== undefined && a.visible !== false)
      .map((a) => {
        const type = String(a.type).trim().toLowerCase();
        // "flag" (read-only switch) and "button" (programmable switch) are both backed
        // by a global FLAG.
        const isFlag = type === "flag" || type === "button";
        // Flags are global functions addressed on central unit 0; everything else
        // defaults to the configured central unit.
        const centralUnit = isFlag ? 0 : Number(a.centralUnit ?? defaultCU);
        const number = Number(a.outputId ?? a.number); // "number" accepted as a legacy alias
        const id = a.id ?? `${type}-cu${centralUnit}-n${number}`;
        // Climate zones are exposed to HomeKit or Matter (one only); everything else
        // is HomeKit. The legacy "both" is no longer supported (it double-drove the
        // zone) — warn and fall back to the default.
        if (CLIMATE_TYPES.has(type) && String(a.expose ?? "").trim().toLowerCase() === "both") {
          this.log.warn(
            `"${a.name ?? id}": expose "both" is no longer supported (it put two controllers on one zone and flooded the unit). ` +
              `Falling back to the default; set expose to "homekit" or "matter".`
          );
        }
        const expose = CLIMATE_TYPES.has(type)
          ? normalizeExpose(a.expose, this.config.defaultExpose)
          : "homekit";
        return {
          id,
          type,
          centralUnit,
          number,
          // The library maps most types to a function code, but not "flag"; pass it
          // explicitly so the client targets the FLAG function.
          functionCode: isFlag ? FUNCTION_FLAG : undefined,
          // Flag only: allow HomeKit to SET the flag (not just read it). Writable by
          // default; set "writable": false for a read-only flag. Does not affect the
          // device id/UUID, so toggling it never churns the accessory.
          writable: a.writable !== false,
          name: a.name ?? id,
          expose,
          invertPosition: Boolean(a.invertPosition),
          climate: a.climate ? String(a.climate).toLowerCase() : "auto",
          temperatureFrom: a.temperatureFrom != null ? Number(a.temperatureFrom) : null,
          powerRelay: a.powerRelay != null ? Number(a.powerRelay) : null,
          minBrightness: a.minBrightness != null ? Number(a.minBrightness) : null,
          maxBrightness: a.maxBrightness != null ? Number(a.maxBrightness) : null
        };
      });
  }

  async _start() {
    // js-teletask-api is ESM; load it here (async context) from this CommonJS module.
    // It's a pinned git dependency (see package.json), resolved from node_modules.
    const { TeletaskClient } = await import("js-teletask-api");

    // Probe the unit and merge any newly-found outputs into the config.
    //   true / "on"  (default) — probe every startup
    //   "once"                 — probe this startup only, then self-disable to false
    //   false / "off"          — never probe
    const adRaw = this.config.autoDiscover;
    const adMode =
      adRaw === false || String(adRaw).toLowerCase() === "off" ? "off"
      : String(adRaw).toLowerCase() === "once" ? "once"
      : "on";
    if (adMode !== "off") {
      // "once": flip the stored setting off now, so this run is the only one even if the
      // merge below finds nothing new to write. Use the string "off" so the value stays
      // valid against the schema's on/once/off dropdown.
      if (adMode === "once") this.config.autoDiscover = "off";
      try {
        await this._autoDiscoverMerge();
      } catch (e) {
        this.log.warn(`Auto-discover failed: ${e?.message ?? e}`);
      }
      if (adMode === "once") {
        this.log.info('Auto-discover "once" complete — turning auto-discovery off for future restarts.');
        this._writeConfig();
      }
    }

    // Fill/refresh the read-only TELETASK reference id on each accessory (REL 05, SEN 04,
    // MOT 03, …). Drops the old descriptive field. No-op once everything is in sync.
    this._syncProsoftRefs();

    if (!this.devices.length) {
      this.log.warn("No accessories configured — add some in the plugin settings.");
    }

    // Register the devices with the client so state reports carry deviceId.
    this.client = new TeletaskClient({
      host: this.config.host,
      port: Number(this.config.port ?? 55957),
      devices: this.devices.map(({ id, type, centralUnit, number, name, functionCode }) => ({
        id,
        type,
        centralUnit,
        number,
        name,
        // Only set for flags; undefined lets the library infer from `type`.
        ...(functionCode !== undefined ? { functionCode } : {})
      }))
    });

    this.client.on("stateChanged", (state) => this._onStateChanged(state));
    this.client.on("error", (err) => this.log.debug("Teletask client error:", err?.message ?? err));
    this.client.on("disconnected", () => {
      this.log.warn(`Disconnected from central unit; retrying in ${RECONNECT_MS / 1000}s.`);
      this._scheduleReconnect();
    });

    // Build/restore accessories regardless of connection state. Climate zones can be
    // exposed to HomeKit (HAP), Matter, or both; everything else is HomeKit only.
    for (const device of this.devices) {
      if (exposesHomeKit(device.expose)) this._ensureAccessory(device);
      // Matter registration self-retries until the bridge's Matter server is up, so
      // run it in the background rather than blocking HAP setup and the unit connect.
      if (exposesMatter(device.expose)) this._ensureMatterAccessory(device);
    }
    this._removeStaleAccessories();

    await this._connect();
  }

  async _connect() {
    try {
      await this.client.connect();
      this.log.info(`Connected to Teletask central unit at ${this.config.host}:${this.config.port ?? 55957}.`);
      // Prime HomeKit with current state (best effort — needs the TDS15132 license to reply).
      for (const device of this.devices) {
        try {
          await this.client.getState(device.id);
        } catch (err) {
          this.log.debug(`Initial getState for ${device.name} failed: ${err?.message ?? err}`);
        }
      }
      // Matter is push-only, so seed its clusters from the primed cache.
      for (const m of this.matterDevices.values()) {
        try {
          m.push();
        } catch (err) {
          this.log.debug(`Initial Matter push for ${m.device.name} failed: ${err?.message ?? err}`);
        }
      }
    } catch (err) {
      this.log.error(`Failed to connect: ${err?.message ?? err}`);
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      await this._connect();
    }, RECONNECT_MS);
  }

  _shutdown() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.client?.disconnect().catch(() => {});
  }

  // Probe the unit over DoIP and return a Map "fn:number" -> { fn, number, state }.
  async _discover() {
    const net = require("node:net");
    const { parseIncoming, encodeKeepAlive, encodeFunctionGet, encodeAck } = await import("js-teletask-api");
    const host = this.config.host;
    const port = Number(this.config.port ?? 55957);
    const cu = Number(this.config.centralUnit ?? 1);
    // [centralUnit, functionCode, maxNumber]. Relay/dimmer/motor/sensor live on the
    // configured central unit; flags are global and answer FunctionGet on central unit 0.
    const probes = [[cu, 1, 32], [cu, 2, 16], [cu, 6, 16], [cu, 20, 24], [0, 15, 32]];
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    return new Promise((resolve) => {
      const found = new Map();
      let buf = Buffer.alloc(0);
      let done = false;
      const s = net.createConnection({ host, port });
      const finish = () => { if (done) return; done = true; try { s.destroy(); } catch {} resolve(found); };
      s.on("data", (d) => {
        buf = Buffer.concat([buf, d]);
        const { frames, remaining } = parseIncoming(buf);
        buf = remaining;
        for (const f of frames) {
          if (f.type !== "frame") continue;
          try { s.write(encodeAck()); } catch {}
          if (f.command === 0x10) {
            const p = f.parameters;
            found.set(`${p[1]}:${(p[2] << 8) | p[3]}`, { fn: p[1], number: (p[2] << 8) | p[3], state: p.subarray(5) });
          }
        }
      });
      s.on("error", (e) => { this.log.debug(`discovery socket: ${e?.message ?? e}`); finish(); });
      s.on("close", finish);
      s.on("connect", async () => {
        try {
          s.write(encodeKeepAlive());
          await sleep(400);
          for (const [pcu, fn, max] of probes) {
            for (let n = 1; n <= max; n++) {
              s.write(encodeFunctionGet({ centralUnit: pcu, functionCode: fn, number: n }));
              await sleep(110);
            }
          }
          await sleep(1000);
        } catch {}
        try { s.end(); } catch {}
      });
      setTimeout(finish, 30000); // safety net
    });
  }

  // Discover outputs, append any new ones to the config, flag unrecognised ones, and
  // persist the merged config.json. Respects visible:false (kept, but skipped in HomeKit).
  async _autoDiscoverMerge() {
    this.log.info("Auto-discover: probing the central unit for outputs…");
    const found = await this._discover();
    if (!found.size) {
      this.log.warn("Auto-discover: nothing responded (needs the TDS15132 license on port 55957); leaving config as-is.");
      return;
    }

    if (!Array.isArray(this.config.accessories)) this.config.accessories = [];
    const accessories = this.config.accessories;
    const today = new Date().toISOString().slice(0, 10);
    const temp2 = (st) => (st.length < 2 ? null : ((st[0] << 8) | st[1]) / 10 - 273);

    // Everything already referenced by the config (accessory, powerRelay, temperatureFrom).
    const used = new Set();
    for (const a of accessories) {
      const fn = FN_FOR_TYPE[String(a.type ?? "").toLowerCase()];
      if (fn) used.add(`${fn}:${Number(a.outputId ?? a.number)}`);
      if (a.powerRelay != null) used.add(`1:${Number(a.powerRelay)}`);
      if (a.temperatureFrom != null) used.add(`20:${Number(a.temperatureFrom)}`);
    }

    // New outputs -> append at the bottom.
    let added = 0;
    for (const { fn, number, state } of [...found.values()].sort((a, b) => a.fn - b.fn || a.number - b.number)) {
      if (used.has(`${fn}:${number}`)) continue;
      const type = TYPE_FOR_FN[fn] ?? "switch";
      const entry = { name: `${LABEL_FOR_FN[fn] ?? "Device"} ${number}`, type, outputId: number };
      if (type === "blind") entry.invertPosition = true;
      if (type === "thermostat") {
        const t = temp2(state);
        entry.climate = t !== null && t > -50 && t < 80 ? "heat" : "auto";
      }
      const hint = likelyUnusedHint(fn, state);
      entry._note =
        `auto-discovered ${today} — rename, or set "visible": false to ignore` +
        (hint ? `. Likely UNUSED: ${hint}` : "");
      accessories.push(entry);
      added++;
      this.log.info(
        `Auto-discover: new ${type} (outputId ${number}) not in config — added as "${entry.name}".` +
          (hint
            ? ` Likely UNUSED — ${hint}; set "visible": false to hide.`
            : ` Rename it, or set "visible": false to ignore it.`)
      );
    }

    // Flag existing accessories discovery didn't recognise; clear the flag on ones it now sees.
    let flagged = 0;
    let cleared = 0;
    for (const a of accessories) {
      const fn = FN_FOR_TYPE[String(a.type ?? "").toLowerCase()];
      if (!fn) continue;
      // Flags ARE discoverable now (we probe FN 15 on CU 0 and add new ones above), but
      // only within the swept range. Don't warn that a configured flag is "not seen /
      // unconfigured" — it may simply sit above the probed range.
      if (fn === FUNCTION_FLAG) continue;
      const seen = found.has(`${fn}:${Number(a.outputId ?? a.number)}`);
      if (!seen && !a._discoveryNote && a._note == null) {
        a._discoveryNote = `not seen by discovery ${today} — this outputId may be unconfigured on the unit`;
        flagged++;
      } else if (seen && a._discoveryNote) {
        delete a._discoveryNote;
        cleared++;
      }
    }

    this.log.info(`Auto-discover: ${found.size} outputs seen; ${added} new added${flagged ? `, ${flagged} flagged` : ""}${cleared ? `, ${cleared} cleared` : ""}.`);
    if (added) {
      this.log.info(
        'Auto-discover is on. To stop it probing and adding outputs, turn off ' +
          '"Auto-discover outputs on startup" in the Teletask plugin config (autoDiscover: false).'
      );
    } else {
      this.log.info(
        'Auto-discover: no new outputs. You can turn off discovery in the plugin config ' +
          '("Auto-discover outputs on startup" / autoDiscover: false).'
      );
    }
    if (added || flagged || cleared) this._writeConfig();

    // Rebuild the active device list from the merged config (visible:false removed).
    this.devices = this._buildDevices();
  }

  // Give each accessory a read-only `prosoftRef` (REL 05, SEN 04, MOT 03, DIM 01, FLG 01)
  // derived from its type + number, and remove the old descriptive `prosoftName`. Writes
  // config.json only when something actually changed, so steady state is a no-op and a
  // freshly-added accessory just gets its ref filled on the next restart.
  _syncProsoftRefs() {
    const list = Array.isArray(this.config.accessories) ? this.config.accessories : [];
    let changed = false;
    for (const a of list) {
      if (!a || typeof a !== "object") continue;
      if ("prosoftName" in a) { delete a.prosoftName; changed = true; }
      const ref = prosoftRefFor(a.type, a.outputId ?? a.number);
      if (ref) {
        if (a.prosoftRef !== ref) { a.prosoftRef = ref; changed = true; }
      } else if ("prosoftRef" in a) {
        delete a.prosoftRef; changed = true;
      }
    }
    if (changed) {
      this.log.info("Updated TELETASK reference ids (prosoftRef) in config.json.");
      this._writeConfig();
    }
  }

  // Write the merged accessories back into config.json (our platform block only).
  _writeConfig() {
    try {
      const fs = require("node:fs");
      const configPath = this.api.user.configPath();
      const json = JSON.parse(fs.readFileSync(configPath, "utf8"));
      const platforms = Array.isArray(json.platforms) ? json.platforms : [];
      const block = platforms.find(
        (p) => p && p.platform === PLATFORM_NAME && (p.name ?? "Teletask") === (this.config.name ?? "Teletask")
      );
      if (!block) {
        this.log.warn("Auto-discover: could not find the Teletask platform in config.json; not saving.");
        return;
      }
      block.accessories = this.config.accessories;
      // Persist the autoDiscover setting too, so "once" can write back false after it runs.
      if (this.config.autoDiscover !== undefined) block.autoDiscover = this.config.autoDiscover;
      fs.writeFileSync(configPath, JSON.stringify(json, null, 4) + "\n");
      this.log.info("Auto-discover: config.json updated.");
    } catch (e) {
      this.log.warn(`Auto-discover: could not update config.json: ${e?.message ?? e}`);
    }
  }

  _ensureAccessory(device) {
    const uuid = this.api.hap.uuid.generate(`teletask:${device.id}`);
    let accessory = this.cachedAccessories.get(uuid);

    if (!accessory) {
      accessory = new this.api.platformAccessory(device.name, uuid);
      accessory.context.device = device;
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.log.info(`Added accessory: ${device.name} (${device.type} #${device.number})`);
    } else {
      accessory.context.device = device;
      this.cachedAccessories.delete(uuid); // mark as "still wanted"
    }

    this._setupInformation(accessory, device);
    this._setupService(accessory, device);
  }

  // Publish a climate zone as a native Matter Room Air Conditioner (opt-in via
  // `expose`). Matter accessories live outside the HAP bridge, so this does not
  // touch cachedAccessories / _removeStaleAccessories.
  async _ensureMatterAccessory(device) {
    try {
      const entry = await registerTeletaskMatterAircon(this, device);
      if (entry) {
        this.matterDevices.set(device.id, entry);
        try {
          entry.push(); // seed clusters from the (possibly already-primed) cache
        } catch (err) {
          this.log.debug(`Initial Matter push for ${device.name} failed: ${err?.message ?? err}`);
        }
      }
    } catch (err) {
      this.log.error(`[${device.name}] Failed to publish Matter air-conditioner: ${err?.message ?? err}`);
    }
  }

  _setupInformation(accessory, device) {
    const info =
      accessory.getService(this.Service.AccessoryInformation) ||
      accessory.addService(this.Service.AccessoryInformation);
    const ref = prosoftRefFor(device.type, device.number);
    info
      .setCharacteristic(this.Characteristic.Manufacturer, "TELETASK")
      // Model carries the TELETASK id (REL/DIM/MOT/SEN/FLG + number) so it shows in the
      // Home app's accessory details. Model is display-only — safe to change at any time
      // without HomeKit re-identifying the accessory.
      .setCharacteristic(this.Characteristic.Model, ref ? `TELETASK ${ref} (DoIP ${device.type})` : `DoIP ${device.type}`)
      // SerialNumber MUST stay stable: HomeKit uses it (with the UUID) to recognise an
      // accessory across restarts, so changing it makes Home treat it as new and lose its
      // room / name / favourite / automations. device.id = type-cu-number is unique and
      // immutable per output — do not swap in prosoftRef (it isn't guaranteed unique).
      .setCharacteristic(this.Characteristic.SerialNumber, device.id);
  }

  _setupService(accessory, device) {
    const C = this.Characteristic;
    const S = this.Service;
    const client = this.client;
    const cached = () => this.client.getCachedState(device.id)?.normalized ?? null;

    // Reuse the service HomeKit restored from cache rather than rebuilding it every
    // startup. Rebuilding (remove + re-add) changed service instance IDs on each boot,
    // which bumped HomeKit's configuration number and destabilised the Home app
    // (dropped rooms, "cannot change settings"). We only drop a service whose TYPE no
    // longer matches (i.e. the accessory's `type` was changed in config), and we keep
    // the existing service's name so a rename done in the Home app survives restarts.
    const useService = (ServiceType) => {
      for (const svc of [...accessory.services]) {
        if (svc.UUID !== S.AccessoryInformation.UUID && svc.UUID !== ServiceType.UUID) {
          accessory.removeService(svc);
        }
      }
      return accessory.getService(ServiceType) || accessory.addService(ServiceType, device.name);
    };

    let update;

    switch (device.type) {
      case "light":
      case "switch":
      case "fan":
      case "outlet": {
        const ServiceType =
          device.type === "fan" ? S.Fan : device.type === "outlet" ? S.Outlet : device.type === "switch" ? S.Switch : S.Lightbulb;
        const service = useService(ServiceType);
        service
          .getCharacteristic(C.On)
          .onGet(() => Boolean(cached()?.on))
          .onSet((value) => this._fire(device.name, () => client.setLightPower(device.id, Boolean(value))));
        update = (n) => service.updateCharacteristic(C.On, Boolean(n?.on));
        break;
      }

      case "dimmer": {
        const service = useService(S.Lightbulb);
        // A Teletask dimmer only takes a level (0 = off, >0 = on). There is no separate
        // on/off command, so map HomeKit On/Off to the level. Optionally, a powerRelay
        // can provide a hard on/off (light that needs a relay for power).
        const relayTarget = device.powerRelay != null
          ? { centralUnit: device.centralUnit, functionCode: 1, number: device.powerRelay }
          : null;
        // Map HomeKit 1-100% onto the dimmer's usable Teletask range [minBrightness,
        // maxBrightness] — e.g. a light that tops out at 75 and has a low-end floor.
        const bMin = device.minBrightness ?? 0;
        const bMax = device.maxBrightness ?? 100;
        const toLevel = (hk) => (hk <= 0 ? 0 : Math.round(bMin + (hk / 100) * (bMax - bMin)));
        const toHk = (lvl) =>
          lvl <= 0 ? 0 : Math.max(1, Math.min(100, Math.round(((lvl - bMin) / Math.max(1, bMax - bMin)) * 100)));
        let lastHk = 100; // last non-zero HomeKit brightness, to restore on "On"
        const isOn = () =>
          relayTarget ? Boolean(this.client.getCachedState(relayTarget)?.normalized?.on)
                      : Boolean(cached()?.on);
        service
          .getCharacteristic(C.On)
          .onGet(() => isOn())
          .onSet((value) => this._fire(device.name, async () => {
            if (relayTarget) {
              await client.setLightPower(relayTarget, Boolean(value));
              if (value) await client.setDimmerLevel(device.id, toLevel(lastHk || 100));
            } else {
              await client.setDimmerLevel(device.id, value ? toLevel(lastHk || 100) : 0);
            }
          }));
        service
          .getCharacteristic(C.Brightness)
          .onGet(() => toHk(Number(cached()?.level ?? 0)))
          .onSet((value) => this._fire(device.name, () => {
            const hk = Number(value);
            if (hk > 0) lastHk = hk;
            return client.setDimmerLevel(device.id, toLevel(hk));
          }));
        update = (n) => {
          service.updateCharacteristic(C.On, isOn());
          if (typeof n?.level === "number") {
            const hk = toHk(n.level);
            if (hk > 0) lastHk = hk;
            service.updateCharacteristic(C.Brightness, hk);
          }
        };
        break;
      }

      case "blind":
      case "cover":
      case "window":
      case "shade": {
        const service = useService(S.WindowCovering);
        const toHomeKit = (pos) => (device.invertPosition ? 100 - pos : pos);
        const fromHomeKit = (pos) => (device.invertPosition ? 100 - pos : pos);

        service.getCharacteristic(C.CurrentPosition).onGet(() => {
          const n = cached();
          return n && typeof n.position === "number" ? toHomeKit(n.position) : 0;
        });
        service.getCharacteristic(C.TargetPosition).onSet((value) =>
          this._fire(device.name, () => client.setBlindPosition(device.id, fromHomeKit(Number(value)))));
        service.getCharacteristic(C.PositionState).onGet(() => C.PositionState.STOPPED);

        update = (n) => {
          if (n && typeof n.position === "number") {
            const hkPos = toHomeKit(n.position);
            service.updateCharacteristic(C.CurrentPosition, hkPos);
            if (!n.moving) service.updateCharacteristic(C.TargetPosition, hkPos);
          }
          const state = !n?.moving
            ? C.PositionState.STOPPED
            : n.direction === 1
            ? C.PositionState.INCREASING
            : C.PositionState.DECREASING;
          service.updateCharacteristic(C.PositionState, state);
        };
        break;
      }

      case "thermostat":
      case "heating": {
        const service = useService(S.Thermostat);
        // Teletask setpoints can dip below HomeKit's default 10°C min (frost ≈ 5°C).
        service.getCharacteristic(C.TargetTemperature).setProps({ minValue: 5, maxValue: 35, minStep: 0.5 });

        // Restrict modes: climate:"heat" = radiators (off/heat), "cool" = AC (off/cool),
        // anything else = full off/heat/cool/auto.
        const T = C.TargetHeatingCoolingState;
        const valid =
          device.climate === "heat" ? [T.OFF, T.HEAT]
          : device.climate === "cool" ? [T.OFF, T.COOL]
          : [T.OFF, T.HEAT, T.COOL, T.AUTO];
        service.getCharacteristic(T).setProps({ validValues: valid });

        // Power / mode / target / temperature semantics are shared with the Matter
        // Room Air Conditioner front-end (climate-core.js), so the two never diverge.
        const ctl = makeClimateControl({ client, device });

        // CurrentHeatingCoolingState = what the zone is actually DOING right now (its relay/
        // valve demand). This legitimately reads the demand (relay or sensor power byte).
        const activeState = (n) =>
          !ctl.isOn() ? C.CurrentHeatingCoolingState.OFF
          : ctl.isCooling(n) ? C.CurrentHeatingCoolingState.COOL
          : C.CurrentHeatingCoolingState.HEAT;
        const modeToHK = (m) =>
          m === "cool" ? T.COOL : m === "auto" ? T.AUTO : m === "off" ? T.OFF : T.HEAT;

        // TargetHeatingCoolingState is the user's CHOSEN mode and must be "sticky". It must
        // NOT be recomputed from live activity: a zone's demand (and any `powerRelay` that
        // follows it) drops to off whenever the room has reached the setpoint, so deriving
        // the mode from it made the thermostat flip to Off the moment you set a target at or
        // below the current temperature — the reported bug. Seed it from the value HomeKit
        // restored (preserved across restarts by service reuse), fall back to the zone's
        // current mode, and thereafter change it only when the user does.
        let desired = service.getCharacteristic(T).value;
        if (desired === null || desired === undefined) desired = modeToHK(ctl.currentMode());

        service.getCharacteristic(C.CurrentTemperature).onGet(() => ctl.readTemp());
        service.getCharacteristic(C.TargetTemperature)
          .onGet(() => ctl.readTarget())
          .onSet((value) => this._fire(device.name, () => ctl.setTarget(Number(value))));
        service.getCharacteristic(T)
          .onGet(() => desired)
          .onSet((value) => {
            desired = value;
            this._fire(device.name, async () => {
              if (value === T.OFF) { await ctl.setPower(false); return; }
              await ctl.setPower(true);
              // For zone-controlled thermostats, also set the heat/cool/auto mode.
              const mode = { [T.HEAT]: "heat", [T.COOL]: "cool", [T.AUTO]: "auto" }[value] ?? "auto";
              await ctl.setMode(mode);
            });
          });
        service.getCharacteristic(C.CurrentHeatingCoolingState).onGet(() => activeState(cached()));

        update = (n) => {
          service.updateCharacteristic(C.CurrentTemperature, ctl.readTemp());
          if (typeof n?.targetCelsius === "number") service.updateCharacteristic(C.TargetTemperature, ctl.clamp(n.targetCelsius));
          // TargetHeatingCoolingState stays as the user set it (sticky) — only reflect live
          // heating/cooling activity here.
          service.updateCharacteristic(C.CurrentHeatingCoolingState, activeState(n));
        };
        break;
      }

      case "sensor":
      case "temperature": {
        const service = useService(S.TemperatureSensor);
        service.getCharacteristic(C.CurrentTemperature).onGet(() => Number(cached()?.valueCelsius ?? 0));
        update = (n) => {
          if (typeof n?.valueCelsius === "number") service.updateCharacteristic(C.CurrentTemperature, n.valueCelsius);
        };
        break;
      }

      case "flag": {
        // Switch backed by a TELETASK flag. By default READ-ONLY: HomeKit observes the
        // flag/LED state (and can trigger Home automations off it) but must not write it
        // back — writes are ignored and the tile snaps back to the real state.
        //
        // With "writable": true, HomeKit may also SET the flag (and so its panel LED),
        // e.g. to keep a dedicated indicator flag in sync with other HomeKit accessories
        // via automations. Only enable this on a flag that drives nothing else in PROSOFT.
        const service = useService(S.Switch);
        const isOn = () => Boolean(cached()?.on);
        const onChar = service.getCharacteristic(C.On).onGet(() => isOn());
        if (device.writable) {
          // setLightPower honours the device's registered functionCode (FLAG = 15), so this
          // sends a real FLAG ON/OFF set to the unit.
          onChar.onSet((value) =>
            this._fire(device.name, () => client.setLightPower(device.id, Boolean(value))));
        } else {
          onChar.onSet((value) => {
            if (Boolean(value) !== isOn()) {
              this.log.debug(`${device.name} is a read-only flag; ignoring HomeKit write.`);
              // Revert the optimistic change on the next tick so the tile reflects
              // the real flag state rather than the attempted value.
              setTimeout(() => service.updateCharacteristic(C.On, isOn()), 0);
            }
          });
        }
        update = (n) => service.updateCharacteristic(C.On, Boolean(n?.on));
        break;
      }

      case "button": {
        // A TELETASK flag exposed as a HomeKit *button* (Stateless Programmable Switch).
        // A physical panel-key press can't be observed directly (the DoIP TPKEY function
        // is write-only), so in PROSOFT wire the panel button to toggle a flag and point
        // this accessory at that flag: each flag change fires a single-press event, which
        // Home automations can trigger on ("When <name> is pressed…").
        const service = useService(S.StatelessProgrammableSwitch);
        const Event = C.ProgrammableSwitchEvent;
        // A flag carries a single bit, so we can't tell single/double/long apart — only
        // ever emit SINGLE_PRESS, and restrict the valid values so Home doesn't offer
        // press types that would never fire.
        service.getCharacteristic(Event).setProps({ validValues: [Event.SINGLE_PRESS] });
        // Every update here is driven by a real EVENT_REPORT from the unit (flags never
        // answer the startup GET, so there's no initial/seed callback to suppress). Fire a
        // press on each one. With a *toggle* flag that's exactly one press per physical
        // button press; a momentary/pulse flag fires twice (on, then off), so use a toggle
        // flag in PROSOFT if that matters.
        update = (n) => {
          service.updateCharacteristic(Event, Event.SINGLE_PRESS);
          this.log.info(`${device.name}: button pressed (flag #${device.number} → ${n?.on ? "on" : "off"}).`);
        };
        break;
      }

      default: {
        this.log.warn(`Unknown accessory type "${device.type}" for ${device.name}; defaulting to Switch.`);
        const service = useService(S.Switch);
        service
          .getCharacteristic(C.On)
          .onGet(() => Boolean(cached()?.on))
          .onSet((value) => this._fire(device.name, () => client.setLightPower(device.id, Boolean(value))));
        update = (n) => service.updateCharacteristic(C.On, Boolean(n?.on));
      }
    }

    this.handlers.set(device.id, { accessory, device, update });
  }

  // Run a set operation without blocking HomeKit on the state read-back. Some outputs
  // (e.g. the Ventax fans) don't reply to a Get, so the library's confirming getState
  // can time out; that must never hang or error the HomeKit write handler.
  _fire(label, fn) {
    Promise.resolve().then(fn).catch((e) => this.log.debug(`set ${label}: ${e?.message ?? e}`));
  }

  _onStateChanged(state) {
    let id = state.deviceId;
    // Flags report under a central unit (1 on the wire) that differs from the one used
    // to address them (0), so the library can't match a flag report to the cu-0 device
    // by address. Fall back to matching a configured flag by its number, ignoring the
    // central unit, so the read-only flag switch still tracks live changes.
    if (!id && Number(state.functionCode) === FUNCTION_FLAG) {
      const dev = this.devices.find(
        (d) => Number(d.functionCode) === FUNCTION_FLAG && Number(d.number) === Number(state.number)
      );
      if (dev) id = dev.id;
    }
    if (id) {
      const handler = this.handlers.get(id);
      if (handler) {
        try {
          handler.update(state.normalized);
        } catch (err) {
          this.log.debug(`Failed to update ${handler.device.name}: ${err?.message ?? err}`);
        }
      }
      const matterEntry = this.matterDevices.get(id);
      if (matterEntry) {
        try {
          matterEntry.push();
        } catch (err) {
          this.log.debug(`Failed to push Matter state for ${matterEntry.device.name}: ${err?.message ?? err}`);
        }
      }
    }
    // Matter is push-only: a zone that borrows its temperature from another zone has
    // to be refreshed on any change, since we can't always match the source's id.
    for (const [mid, m] of this.matterDevices) {
      if (mid === id || m.device.temperatureFrom == null) continue;
      try {
        m.push();
      } catch (err) {
        this.log.debug(`Failed to refresh Matter temp for ${m.device.name}: ${err?.message ?? err}`);
      }
    }
  }

  _removeStaleAccessories() {
    // Anything still left in cachedAccessories wasn't claimed by the current config.
    const stale = [...this.cachedAccessories.values()];
    if (stale.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      for (const acc of stale) this.log.info(`Removed stale accessory: ${acc.displayName}`);
    }
    this.cachedAccessories.clear();
  }
}

module.exports = { TeletaskPlatform };
