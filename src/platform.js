// CommonJS plugin. teletask-api is an ES module, so it's loaded lazily via dynamic
// import() inside _start() (which runs async on didFinishLaunching).
const { PLATFORM_NAME, PLUGIN_NAME } = require("./settings.js");

const RECONNECT_MS = 10000;

// Teletask function codes <-> HomeKit type, for auto-discovery.
const FN_FOR_TYPE = { light: 1, switch: 1, fan: 1, outlet: 1, dimmer: 2, blind: 6, cover: 6, window: 6, shade: 6, thermostat: 20, heating: 20, sensor: 20 };
const TYPE_FOR_FN = { 1: "light", 2: "dimmer", 6: "blind", 20: "thermostat" };
const LABEL_FOR_FN = { 1: "Light", 2: "Dimmer", 6: "Blind", 20: "Zone" };

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
    // deviceId -> { accessory, device, update(state) }
    this.handlers = new Map();
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
        const centralUnit = Number(a.centralUnit ?? defaultCU);
        const number = Number(a.outputId ?? a.number); // "number" accepted as a legacy alias
        const id = a.id ?? `${type}-cu${centralUnit}-n${number}`;
        return {
          id,
          type,
          centralUnit,
          number,
          name: a.name ?? id,
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
    // teletask-api is ESM; load it here (async context) from this CommonJS module.
    // The library is vendored into ./lib at build time (see scripts/bundle-lib.mjs).
    const { TeletaskClient } = await import("../lib/teletask-api/index.js");

    // Probe the unit and merge any newly-found outputs into the config. On by default;
    // disable by setting "autoDiscover": false.
    if (this.config.autoDiscover !== false) {
      try {
        await this._autoDiscoverMerge();
      } catch (e) {
        this.log.warn(`Auto-discover failed: ${e?.message ?? e}`);
      }
    }

    if (!this.devices.length) {
      this.log.warn("No accessories configured — add some in the plugin settings.");
    }

    // Register the devices with the client so state reports carry deviceId.
    this.client = new TeletaskClient({
      host: this.config.host,
      port: Number(this.config.port ?? 55957),
      devices: this.devices.map(({ id, type, centralUnit, number, name }) => ({
        id,
        type,
        centralUnit,
        number,
        name
      }))
    });

    this.client.on("stateChanged", (state) => this._onStateChanged(state));
    this.client.on("error", (err) => this.log.debug("Teletask client error:", err?.message ?? err));
    this.client.on("disconnected", () => {
      this.log.warn(`Disconnected from central unit; retrying in ${RECONNECT_MS / 1000}s.`);
      this._scheduleReconnect();
    });

    // Build/restore HomeKit accessories regardless of connection state.
    for (const device of this.devices) this._ensureAccessory(device);
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
    const { parseIncoming, encodeKeepAlive, encodeFunctionGet, encodeAck } = await import("../lib/teletask-api/index.js");
    const host = this.config.host;
    const port = Number(this.config.port ?? 55957);
    const cu = Number(this.config.centralUnit ?? 1);
    const probes = [[1, 32], [2, 16], [6, 16], [20, 24]]; // relay, dimmer, motor, sensor
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
          for (const [fn, max] of probes) {
            for (let n = 1; n <= max; n++) {
              s.write(encodeFunctionGet({ centralUnit: cu, functionCode: fn, number: n }));
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
      entry._note = `auto-discovered ${today} — rename, or set "visible": false to ignore`;
      accessories.push(entry);
      added++;
    }

    // Flag existing accessories discovery didn't recognise; clear the flag on ones it now sees.
    let flagged = 0;
    let cleared = 0;
    for (const a of accessories) {
      const fn = FN_FOR_TYPE[String(a.type ?? "").toLowerCase()];
      if (!fn) continue;
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
    if (added || flagged || cleared) this._writeConfig();

    // Rebuild the active device list from the merged config (visible:false removed).
    this.devices = this._buildDevices();
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

  _setupInformation(accessory, device) {
    const info =
      accessory.getService(this.Service.AccessoryInformation) ||
      accessory.addService(this.Service.AccessoryInformation);
    info
      .setCharacteristic(this.Characteristic.Manufacturer, "TELETASK")
      .setCharacteristic(this.Characteristic.Model, `DoIP ${device.type}`)
      .setCharacteristic(this.Characteristic.SerialNumber, device.id);
  }

  _setupService(accessory, device) {
    const C = this.Characteristic;
    const S = this.Service;
    const client = this.client;
    const cached = () => this.client.getCachedState(device.id)?.normalized ?? null;

    // Replace any existing non-information service so type changes take effect cleanly.
    for (const svc of [...accessory.services]) {
      if (svc.UUID !== S.AccessoryInformation.UUID) accessory.removeService(svc);
    }

    let update;

    switch (device.type) {
      case "light":
      case "switch":
      case "fan":
      case "outlet": {
        const ServiceType =
          device.type === "fan" ? S.Fan : device.type === "outlet" ? S.Outlet : device.type === "switch" ? S.Switch : S.Lightbulb;
        const service = accessory.addService(ServiceType, device.name);
        service
          .getCharacteristic(C.On)
          .onGet(() => Boolean(cached()?.on))
          .onSet((value) => this._fire(device.name, () => client.setLightPower(device.id, Boolean(value))));
        update = (n) => service.updateCharacteristic(C.On, Boolean(n?.on));
        break;
      }

      case "dimmer": {
        const service = accessory.addService(S.Lightbulb, device.name);
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
        const service = accessory.addService(S.WindowCovering, device.name);
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
        const service = accessory.addService(S.Thermostat, device.name);
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

        const clamp = (t) => Math.max(5, Math.min(35, t));
        // Power/on-off: by default via the zone's SET_TEMPONOFF toggle; if "powerRelay" is
        // set, use that relay output instead (reliable on/off for underfloor/radiator).
        const relayTarget = device.powerRelay != null
          ? { centralUnit: device.centralUnit, functionCode: 1, number: device.powerRelay }
          : null;
        const isOn = () =>
          relayTarget ? Boolean(this.client.getCachedState(relayTarget)?.normalized?.on)
                      : Boolean(cached()?.on);
        const setPower = async (on) => {
          if (relayTarget) { await client.setLightPower(relayTarget, on); return; }
          if (Boolean(cached()?.on) !== on) await client.toggleHeatingPower(device.id); // SET_TEMPONOFF toggle
        };
        // Teletask mode byte: 94=Auto, 95=Heat, 96=Cool. Derive the real heat/cool state.
        const cooling = (n) => n?.mode === 96 || (device.climate === "cool" && n?.mode !== 95);
        const activeState = (n) =>
          !isOn() ? C.CurrentHeatingCoolingState.OFF
          : cooling(n) ? C.CurrentHeatingCoolingState.COOL
          : C.CurrentHeatingCoolingState.HEAT;
        const targetState = (n) => {
          if (!isOn()) return T.OFF;
          if (device.climate === "heat") return T.HEAT;
          if (device.climate === "cool") return T.COOL;
          if (n?.mode === 94) return T.AUTO;
          return n?.mode === 96 ? T.COOL : T.HEAT;
        };

        // Some AC zones report no temperature of their own; borrow it from a co-located
        // sensor zone (same room) via "temperatureFrom".
        const tempSource = device.temperatureFrom
          ? () => this.client.getCachedState({ centralUnit: device.centralUnit, functionCode: 20, number: device.temperatureFrom })?.normalized ?? null
          : cached;
        const readTemp = () => { const v = tempSource()?.valueCelsius; return typeof v === "number" ? v : 20; };
        service.getCharacteristic(C.CurrentTemperature).onGet(readTemp);
        service.getCharacteristic(C.TargetTemperature)
          .onGet(() => { const t = cached()?.targetCelsius; return typeof t === "number" ? clamp(t) : 20; })
          .onSet((value) => this._fire(device.name, () => client.setHeatingTargetTemperature(device.id, Number(value))));
        service.getCharacteristic(T)
          .onGet(() => targetState(cached()))
          .onSet((value) => this._fire(device.name, async () => {
            if (value === T.OFF) { await setPower(false); return; }
            await setPower(true);
            // For zone-controlled (AC) thermostats, also set the heat/cool/auto mode.
            if (!relayTarget) {
              const mode = { [T.HEAT]: "heat", [T.COOL]: "cool", [T.AUTO]: "auto" }[value] ?? "auto";
              await client.setHeatingMode(device.id, mode);
            }
          }));
        service.getCharacteristic(C.CurrentHeatingCoolingState).onGet(() => activeState(cached()));

        update = (n) => {
          service.updateCharacteristic(C.CurrentTemperature, readTemp());
          if (typeof n?.targetCelsius === "number") service.updateCharacteristic(C.TargetTemperature, clamp(n.targetCelsius));
          service.updateCharacteristic(T, targetState(n));
          service.updateCharacteristic(C.CurrentHeatingCoolingState, activeState(n));
        };
        break;
      }

      case "sensor":
      case "temperature": {
        const service = accessory.addService(S.TemperatureSensor, device.name);
        service.getCharacteristic(C.CurrentTemperature).onGet(() => Number(cached()?.valueCelsius ?? 0));
        update = (n) => {
          if (typeof n?.valueCelsius === "number") service.updateCharacteristic(C.CurrentTemperature, n.valueCelsius);
        };
        break;
      }

      default: {
        this.log.warn(`Unknown accessory type "${device.type}" for ${device.name}; defaulting to Switch.`);
        const service = accessory.addService(S.Switch, device.name);
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
    const handler = state.deviceId ? this.handlers.get(state.deviceId) : null;
    if (!handler) return;
    try {
      handler.update(state.normalized);
    } catch (err) {
      this.log.debug(`Failed to update ${handler.device.name}: ${err?.message ?? err}`);
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
