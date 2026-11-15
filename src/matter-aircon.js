// Publishes a TELETASK climate zone as a NATIVE Matter Room Air Conditioner
// (Matter device type 0x0072) via the Homebridge 2.x `api.matter` API — the same
// mechanism homebridge-eufy-robovac-matter uses for its vacuum.
//
// Why Matter and not just the HomeKit Thermostat? HomeKit's Thermostat is a decent
// fit for radiators but a poor one for air-conditioning; Matter has a purpose-built
// Room Air Conditioner device type (OnOff + Thermostat + TemperatureMeasurement).
// This module is OPT-IN per zone via the `expose` config option and never replaces
// the HomeKit thermostat — see platform.js.
//
// IMPORTANT: Matter accessories are NOT HAP accessories. They do not appear through
// the plugin's normal HomeKit bridge; Matter must be enabled on the (child) bridge
// running this plugin, and the device is paired separately with a Matter code. See
// docs/matter.md.

const { makeClimateControl } = require("./climate-core.js");
const { PLUGIN_NAME, PLATFORM_NAME } = require("./settings.js");

// Matter Thermostat SystemMode enum (matter-spec Thermostat cluster).
const SYS_OFF = 0;
const SYS_AUTO = 1;
const SYS_COOL = 3;
const SYS_HEAT = 4;

// Matter Thermostat ControlSequenceOfOperation enum.
const CSO_COOLING_ONLY = 0;
const CSO_HEATING_ONLY = 2;
const CSO_COOLING_AND_HEATING = 4;

// Matter encodes temperatures as signed centi-degrees Celsius (°C * 100).
const toCenti = (c) => Math.round(c * 100);
const fromCenti = (v) => v / 100;

function matterAvailable(api) {
  return Boolean(api && api.matter && typeof api.isMatterEnabled === "function" && api.isMatterEnabled());
}

// A RoomAirConditioner is a *bridged* Matter accessory, so it can only be
// registered once this bridge's Matter server has finished starting — which
// happens a moment AFTER didFinishLaunching fires. Homebridge rejects an early
// call with a transient "server is still starting" error, so retry on that (and
// only that) with backoff; any other error is real and rethrown immediately.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isTransientMatterError = (err) =>
  /still starting|not started|finished launching/i.test(String(err?.message ?? err));

async function registerWithRetry(matter, accessory, log, name) {
  const delays = [500, 1000, 2000, 3000, 5000, 5000, 8000, 10000]; // ~35s of attempts
  for (let attempt = 0; ; attempt++) {
    try {
      await matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      return;
    } catch (err) {
      if (!isTransientMatterError(err) || attempt >= delays.length) throw err;
      log.debug(`[${name}] Matter server still starting; retrying in ${delays[attempt]}ms…`);
      await sleep(delays[attempt]);
    }
  }
}

// Register one zone as a Matter Room Air Conditioner.
//   platform : the TeletaskPlatform instance (for api, log, client, _fire)
//   device   : the normalised device definition
// Returns { uuid, device, push() } so the platform can route state updates, or null
// if Matter isn't available on this bridge.
async function registerTeletaskMatterAircon(platform, device) {
  const { api, log, client } = platform;

  if (!matterAvailable(api)) {
    log.warn(
      `[${device.name}] Matter is not enabled on this bridge, so the Matter air-conditioner for this zone won't be published. ` +
        "Enable Matter for the (child) bridge running this plugin, then pair it in your Matter app (Apple Home, Alexa, ...)."
    );
    return null;
  }

  const matter = api.matter;
  const uuid = matter.uuid.generate(`teletask-matter:${device.id}`);
  const ctl = makeClimateControl({ client, device });

  const canHeat = device.climate === "heat" || device.climate === "auto";
  const canCool = device.climate === "cool" || device.climate === "auto";
  const cso =
    device.climate === "auto"
      ? CSO_COOLING_AND_HEATING
      : device.climate === "heat"
      ? CSO_HEATING_ONLY
      : CSO_COOLING_ONLY;

  // A heat+cool ("auto") zone also gets Matter's AutoMode feature, so the Home app can
  // offer Off/Heat/Cool/Auto like the HomeKit thermostat. The default RoomAirConditioner
  // composition is Heating+Cooling only, so compose the thermostat with AutoMode here.
  // (AutoMode also makes minSetpointDeadBand a legal attribute — it's a conformance error
  // without it.) Cool-only / heat-only zones keep the default single-feature composition.
  const autoZone = canHeat && canCool;
  let deviceType = matter.deviceTypes.RoomAirConditioner;
  if (autoZone) {
    const ts = matter.deviceRequirements?.RoomAirConditioner?.ThermostatServer;
    if (ts && typeof ts.with === "function") {
      try {
        deviceType = matter.deviceTypes.RoomAirConditioner.with(ts.with("Heating", "Cooling", "AutoMode"));
      } catch (err) {
        log.debug(`[${device.name}] could not add Matter AutoMode: ${err?.message ?? err}; using Heating/Cooling only`);
      }
    }
  }

  // Default "on" system mode for this zone (what to show/select when powered on).
  const onSystemMode = autoZone ? SYS_AUTO : canCool ? SYS_COOL : SYS_HEAT;

  // systemMode must only use features the composed thermostat actually has: Off/Cool/Heat
  // always, plus Auto only on an auto zone. A TELETASK auto zone reports Auto when idle in
  // auto (mode 94), else the mode it's actively running.
  const systemModeNow = () => {
    if (!ctl.isOn()) return SYS_OFF;
    if (autoZone) {
      const m = ctl.currentMode();
      if (m === "auto") return SYS_AUTO;
      return m === "cool" ? SYS_COOL : SYS_HEAT;
    }
    if (canCool && ctl.isCooling()) return SYS_COOL;
    return SYS_HEAT;
  };

  // The thermostat-cluster attributes that track live state. TELETASK exposes a
  // single target temperature, so both setpoints mirror it where the mode exists.
  const thermostatState = () => {
    const target = toCenti(ctl.readTarget());
    const state = {
      localTemperature: toCenti(ctl.readTemp()),
      systemMode: systemModeNow(),
      controlSequenceOfOperation: cso
    };
    if (canCool) state.occupiedCoolingSetpoint = target;
    if (canHeat) state.occupiedHeatingSetpoint = target;
    return state;
  };

  const safeUpdate = (cluster, attributes) =>
    matter.updateAccessoryState(uuid, cluster, attributes).catch((err) => {
      log.debug(`[${device.name}] Matter ${cluster} update failed: ${err?.message ?? err}`);
    });

  // Push current TELETASK state out to the Matter clusters. Current temperature is
  // reported via thermostat.localTemperature — this device type has no separate
  // TemperatureMeasurement behavior (Homebridge composes only onOff + thermostat).
  const push = () => {
    safeUpdate("onOff", { onOff: ctl.isOn() });
    safeUpdate("thermostat", thermostatState());
  };

  // Fire a control command without blocking the Matter handler on the library's
  // confirming read-back (some outputs never reply). Mirrors platform._fire.
  const fire = (desc, fn) => platform._fire(desc, fn);

  // When a zone is exposed as BOTH, a HomeKit thermostat and this Matter AC share a
  // name — suffix the Matter one so they're distinguishable in the Home app.
  const displayName = device.expose === "both" ? `${device.name} xMatter` : device.name;

  const accessory = {
    UUID: uuid,
    displayName,
    deviceType,
    serialNumber: String(device.id),
    manufacturer: "TELETASK",
    model: `DoIP AC zone ${device.number}`,
    context: { deviceId: device.id },
    clusters: {
      onOff: { onOff: ctl.isOn() },
      thermostat: {
        ...thermostatState(),
        // Setpoint limits (centi-°C) span the same 5–35 °C range the control core
        // clamps to, so every target TELETASK reports is a valid setpoint on BOTH
        // the heating and cooling sides (a single TELETASK target drives both). A
        // tighter cooling floor here would reject low targets and spam rollbacks.
        minCoolSetpointLimit: toCenti(ctl.MIN_C),
        maxCoolSetpointLimit: toCenti(ctl.MAX_C),
        absMinCoolSetpointLimit: toCenti(ctl.MIN_C),
        absMaxCoolSetpointLimit: toCenti(ctl.MAX_C),
        minHeatSetpointLimit: toCenti(ctl.MIN_C),
        maxHeatSetpointLimit: toCenti(ctl.MAX_C),
        absMinHeatSetpointLimit: toCenti(ctl.MIN_C),
        absMaxHeatSetpointLimit: toCenti(ctl.MAX_C),
        // Only legal with the AutoMode feature (auto zones). 0 lets the heating and cooling
        // setpoints be equal, which they are — a single TELETASK target drives both. Setting
        // it on a non-AutoMode thermostat is a conformance error that blocks registration.
        ...(autoZone ? { minSetpointDeadBand: 0 } : {})
      }
    },
    handlers: {
      onOff: {
        on: async () => {
          fire(`${device.name} on (matter)`, () => ctl.setPower(true));
          await safeUpdate("onOff", { onOff: true });
          await safeUpdate("thermostat", { systemMode: onSystemMode });
        },
        off: async () => {
          fire(`${device.name} off (matter)`, () => ctl.setPower(false));
          await safeUpdate("onOff", { onOff: false });
          await safeUpdate("thermostat", { systemMode: SYS_OFF });
        }
      },
      thermostat: {
        systemModeChange: async ({ systemMode }) => {
          if (systemMode === SYS_OFF) {
            fire(`${device.name} off (matter)`, () => ctl.setPower(false));
            await safeUpdate("onOff", { onOff: false });
            return;
          }
          const mode = systemMode === SYS_COOL ? "cool" : systemMode === SYS_HEAT ? "heat" : "auto";
          fire(`${device.name} ${mode} (matter)`, async () => {
            await ctl.setPower(true);
            await ctl.setMode(mode);
          });
          await safeUpdate("onOff", { onOff: true });
          await safeUpdate("thermostat", { systemMode });
        },
        occupiedCoolingSetpointChange: async ({ occupiedCoolingSetpoint }) => {
          const c = ctl.clamp(fromCenti(occupiedCoolingSetpoint));
          fire(`${device.name} cool setpoint ${c}°C (matter)`, () => ctl.setTarget(c));
          await safeUpdate("thermostat", { occupiedCoolingSetpoint: toCenti(c) });
        },
        occupiedHeatingSetpointChange: async ({ occupiedHeatingSetpoint }) => {
          const c = ctl.clamp(fromCenti(occupiedHeatingSetpoint));
          fire(`${device.name} heat setpoint ${c}°C (matter)`, () => ctl.setTarget(c));
          await safeUpdate("thermostat", { occupiedHeatingSetpoint: toCenti(c) });
        }
      }
    }
  };

  await registerWithRetry(matter, accessory, log, device.name);
  log.info(`[${device.name}] Published native Matter Room Air Conditioner (zone ${device.number}).`);

  return { uuid, device, push };
}

module.exports = { registerTeletaskMatterAircon, matterAvailable };
