import { TeletaskPlatform } from "./src/platform.js";
import { PLATFORM_NAME, PLUGIN_NAME } from "./src/settings.js";

// Homebridge entry point: register the dynamic platform.
export default (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, TeletaskPlatform);
};
