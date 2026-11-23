// Shared TELETASK climate semantics for a single zone.
//
// Both front-ends — the HomeKit Thermostat (platform.js) and the native Matter
// Room Air Conditioner (matter-aircon.js) — drive a zone through this one module,
// so power / mode / target / temperature behave identically however the zone is
// exposed. It owns NO HomeKit or Matter types; it speaks only js-teletask-api.
//
// TELETASK facts encoded here (verified live against the unit — see the repo's
// heating notes): the zone mode byte is 94=Auto, 95=Heat, 96=Cool; power is a
// SET_TEMPONOFF toggle (so we only toggle when the cached state disagrees), or a
// dedicated relay when `powerRelay` is set; an AC zone with no sensor of its own
// borrows its temperature from another zone via `temperatureFrom`.

const MIN_C = 5;
const MAX_C = 35;

// Build the control helpers for one climate `device`, bound to a connected `client`.
function makeClimateControl({ client, device }) {
  const cached = () => client.getCachedState(device.id)?.normalized ?? null;

  // A dedicated relay gives a reliable hard on/off (underfloor / radiator). Without
  // one, on/off is the zone's own SET_TEMPONOFF toggle.
  const relayTarget =
    device.powerRelay != null
      ? { centralUnit: device.centralUnit, functionCode: 1, number: device.powerRelay }
      : null;

  // Temperature source: the zone itself, or a co-located sensor zone it borrows from.
  const tempSource =
    device.temperatureFrom != null
      ? () =>
          client.getCachedState({
            centralUnit: device.centralUnit,
            functionCode: 20,
            number: device.temperatureFrom
          })?.normalized ?? null
      : cached;

  const clamp = (t) => Math.max(MIN_C, Math.min(MAX_C, t));

  const isOn = () =>
    relayTarget
      ? Boolean(client.getCachedState(relayTarget)?.normalized?.on)
      : Boolean(cached()?.on);

  const setPower = async (on) => {
    if (relayTarget) {
      await client.setLightPower(relayTarget, on);
      return;
    }
    // TEMP_ON_OFF is a TOGGLE, not an absolute on/off, so we must know the zone's real
    // current state to toggle the right way. The cached state can be stale or missing
    // (e.g. an AC zone with no sensor of its own), which previously made "off" silently
    // no-op. Read the live state first, and only toggle when it disagrees.
    let current;
    try {
      const s = await client.getState(device.id);
      const n = s && s.normalized ? s.normalized : s;
      current = n && typeof n.on === "boolean" ? n.on : Boolean(cached()?.on);
    } catch {
      current = Boolean(cached()?.on);
    }
    if (current !== on) await client.toggleHeatingPower(device.id);
  };

  // mode: "heat" | "cool" | "auto". Relay-backed zones have no addressable zone mode.
  const setMode = async (mode) => {
    if (relayTarget) return;
    await client.setHeatingMode(device.id, mode);
  };

  const setTarget = (celsius) => client.setHeatingTargetTemperature(device.id, Number(celsius));

  // Is the zone currently cooling? mode 96 = Cool; a cool-only zone counts as cooling
  // unless it's explicitly reporting Heat.
  const isCooling = (n = cached()) => n?.mode === 96 || (device.climate === "cool" && n?.mode !== 95);

  const readTemp = () => {
    const v = tempSource()?.valueCelsius;
    return typeof v === "number" ? v : 20;
  };

  const readTarget = () => {
    const t = cached()?.targetCelsius;
    return typeof t === "number" ? clamp(t) : 20;
  };

  // The zone's effective mode as a string: "off" | "heat" | "cool" | "auto".
  const currentMode = (n = cached()) => {
    if (!isOn()) return "off";
    if (device.climate === "heat") return "heat";
    if (device.climate === "cool") return "cool";
    if (n?.mode === 94) return "auto";
    return n?.mode === 96 ? "cool" : "heat";
  };

  return {
    MIN_C,
    MAX_C,
    climate: device.climate,
    hasRelayPower: Boolean(relayTarget),
    cached,
    clamp,
    isOn,
    setPower,
    setMode,
    setTarget,
    isCooling,
    readTemp,
    readTarget,
    currentMode
  };
}

module.exports = { makeClimateControl, MIN_C, MAX_C };
