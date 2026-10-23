# Installation & updates

## Requirements

- Homebridge **1.6+** (including Homebridge 2.x) and Node **18+**.
- A TELETASK DoIP central unit reachable on your network, with the **TDS15132** licence or
  trial active — see [PROSOFT & licensing](prosoft-and-licensing.md).

## Install (Homebridge UI)

If the plugin is published to npm, search for **Teletask** in the Homebridge UI's *Plugins*
tab and install it, then add the platform config (see [Configuration](configuration.md)).

## Install from source (self‑contained, no npm registry)

The plugin bundles its library at build time, so it installs as a single self‑contained
package and **survives Homebridge upgrades** (it's a tracked dependency, not a hand‑copied
folder).

```bash
# 1. get the code
git clone <your-repo-url> teletask && cd teletask

# 2. build the self-contained plugin (vendors the library into ./lib)
cd homebridge-teletask && npm run bundle

# 3. install it into Homebridge as a tracked dependency (copies, doesn't symlink)
cd /var/lib/homebridge
echo "install-links=true" | sudo tee -a .npmrc            # so upgrades keep copying it
sudo npm install --install-links ~/teletask/homebridge-teletask
sudo chown -R --reference=/var/lib/homebridge/node_modules/homebridge \
  /var/lib/homebridge/node_modules/homebridge-teletask
sudo hb-service restart
```

> Paths assume the official Homebridge image (storage at `/var/lib/homebridge`). Adjust for
> your setup. The key is installing into the folder Homebridge actually scans for plugins —
> check its startup log for the `-P <path>` flag if unsure.

## Updating

`npm install` can report *"up to date"* and **skip re-copying** a local package whose
version number hasn't changed — leaving the old build in place. So either bump the
plugin's `version` in `package.json` each release, or uninstall first to force a clean
re-copy:

```bash
cd ~/teletask && git pull
cd homebridge-teletask && npm run bundle
cd /var/lib/homebridge
sudo npm uninstall homebridge-teletask
sudo npm install --install-links ~/teletask/homebridge-teletask
sudo hb-service restart
```

Confirm the new build loaded — the version in the log should match `package.json`:

```bash
sudo hb-service logs | grep -i "loaded plugin: homebridge-teletask"
```

## Verify it loaded

```bash
sudo hb-service logs | grep -iE "loaded plugin: homebridge-teletask|connected to teletask"
```
You should see the plugin load and (once configured) `Connected to Teletask central unit…`.
