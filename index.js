const { TeletaskPlatform } = require("./src/platform.js");
const { PLATFORM_NAME, PLUGIN_NAME } = require("./src/settings.js");

// Homebridge entry point: register the dynamic platform (CommonJS for broad compatibility).
module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, TeletaskPlatform);
};
