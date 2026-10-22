import { TeletaskClient } from "teletask-api";
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings.js";

const RECONNECT_MS = 10000;

// Dynamic Homebridge platform that bridges TELETASK DoIP devices into HomeKit.
export class TeletaskPlatform {
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
          invertPosition: Boolean(a.invertPosition)
        };
      });
  }

  async _start() {
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
          .onSet(async (value) => {
            await client.setLightPower(device.id, Boolean(value));
          });
        update = (n) => service.updateCharacteristic(C.On, Boolean(n?.on));
        break;
      }

      case "dimmer": {
        const service = accessory.addService(S.Lightbulb, device.name);
        service
          .getCharacteristic(C.On)
          .onGet(() => Boolean(cached()?.on))
          .onSet(async (value) => {
            await client.setLightPower(device.id, Boolean(value));
          });
        service
          .getCharacteristic(C.Brightness)
          .onGet(() => Number(cached()?.level ?? 0))
          .onSet(async (value) => {
            await client.setDimmerLevel(device.id, Number(value));
          });
        update = (n) => {
          service.updateCharacteristic(C.On, Boolean(n?.on));
          if (typeof n?.level === "number") service.updateCharacteristic(C.Brightness, n.level);
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
        service.getCharacteristic(C.TargetPosition).onSet(async (value) => {
          await client.setBlindPosition(device.id, fromHomeKit(Number(value)));
        });
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
        // Experimental — the sensor/climate decode has two protocol generations;
        // verify against your unit (see teletask-api README).
        const service = accessory.addService(S.Thermostat, device.name);
        service.getCharacteristic(C.CurrentTemperature).onGet(() => Number(cached()?.valueCelsius ?? 20));
        service
          .getCharacteristic(C.TargetTemperature)
          .onGet(() => Number(cached()?.targetCelsius ?? 20))
          .onSet(async (value) => {
            await client.setHeatingTargetTemperature(device.id, Number(value));
          });
        service
          .getCharacteristic(C.TargetHeatingCoolingState)
          .onSet(async (value) => {
            const mode = { 0: "stop", 1: "heat", 2: "cool", 3: "auto" }[value] ?? "auto";
            await client.setHeatingMode(device.id, mode);
          });
        update = (n) => {
          if (typeof n?.valueCelsius === "number") service.updateCharacteristic(C.CurrentTemperature, n.valueCelsius);
          if (typeof n?.targetCelsius === "number") service.updateCharacteristic(C.TargetTemperature, n.targetCelsius);
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
          .onSet(async (value) => client.setLightPower(device.id, Boolean(value)));
        update = (n) => service.updateCharacteristic(C.On, Boolean(n?.on));
      }
    }

    this.handlers.set(device.id, { accessory, device, update });
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
