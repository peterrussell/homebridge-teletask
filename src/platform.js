// CommonJS plugin. teletask-api is an ES module, so it's loaded lazily via dynamic
// import() inside _start() (which runs async on didFinishLaunching).
const { PLATFORM_NAME, PLUGIN_NAME } = require("./settings.js");

const RECONNECT_MS = 10000;

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
      .filter((a) => a && a.type && a.number !== undefined)
      .map((a) => {
        const type = String(a.type).trim().toLowerCase();
        const centralUnit = Number(a.centralUnit ?? defaultCU);
        const number = Number(a.number);
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
    if (!this.devices.length) {
      this.log.warn("No accessories configured — add some in the plugin settings.");
    }

    // teletask-api is ESM; load it here (async context) from this CommonJS module.
    const { TeletaskClient } = await import("teletask-api");

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
