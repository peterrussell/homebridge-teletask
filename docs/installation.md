# Installation & updates

## Requirements

- Homebridge **1.6+** (including Homebridge 2.x; the native **Matter** air-conditioning
  support needs Homebridge **2.x**) and Node **18+**.
- A TELETASK DoIP central unit reachable on your network, with the **TDS15132** licence or
  trial active — see [PROSOFT & licensing](prosoft-and-licensing.md).

The plugin builds on the separate [`js-teletask-api`](https://github.com/peterrussell/js-teletask-api)
library, which is published on npm and installed automatically as a normal dependency — you
don't need to fetch or configure anything extra.

## Install (Homebridge UI — recommended)

1. In the Homebridge UI, open **Plugins** and search for **`homebridge-teletask`**.
2. Click **Install**.
3. Configure it (Plugins → *Homebridge Teletask* → *Settings*, or edit `config.json`) — see
   [Configuration](configuration.md). The minimum is your central unit's `host`.
4. **Restart Homebridge.**

## Install (command line)

```bash
sudo npm install -g homebridge-teletask
sudo hb-service restart
```

Then configure it in the UI or `config.json` (see [Configuration](configuration.md)).

## Install from source (development)

For hacking on the plugin itself:

```bash
git clone https://github.com/peterrussell/homebridge-teletask.git
cd homebridge-teletask
npm install            # pulls js-teletask-api from npm
```

Then install it into your Homebridge instance as a local package (copies, doesn't symlink, so
Homebridge resolves it like a normal plugin):

```bash
cd /var/lib/homebridge
grep -q install-links .npmrc 2>/dev/null || echo "install-links=true" | sudo tee -a .npmrc
sudo npm install --install-links ~/homebridge-teletask
sudo hb-service restart
```

> Paths assume the official Homebridge image (storage at `/var/lib/homebridge`). The key is
> installing into the folder Homebridge actually scans for plugins — check its startup log for
> the `-P <path>` flag if unsure.

## Updating

**Homebridge UI / npm:** update from the UI's *Plugins* page, or:

```bash
sudo npm update -g homebridge-teletask
sudo hb-service restart
```

**From a source install,** `npm install` can report *"up to date"* and **skip re-copying** a
local package whose version number hasn't changed — leaving the old build in place. So bump the
plugin's `version` in `package.json` each change (or uninstall first) to force a clean re-copy:

```bash
cd ~/homebridge-teletask && git pull && npm install
cd /var/lib/homebridge
sudo npm uninstall homebridge-teletask
sudo npm install --install-links ~/homebridge-teletask
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

## Troubleshooting

**HomeKit keeps losing rooms / names, or the Home app says "Cannot change settings".**
This is almost always a Homebridge *bridge* problem, not the plugin. The cause is the bridge
advertising HomeKit over mDNS on an interface your home hub can't reach — typically a VPN
interface like `tailscale0` — so the hub is handed an unreachable address, drops accessories
and refuses writes. Fix it with **both** of these in the bridge config:

```json
"bridge": { "advertiser": "ciao", "bind": ["eth0"] }
```

- `bind: ["eth0"]` — advertise on the LAN interface only.
- `advertiser: "ciao"` — **important**: the `avahi` and `resolved` advertisers use the system
  mDNS daemon, which advertises on *all* interfaces and **ignores `bridge.bind`**. Only
  Homebridge's own `ciao` (or `bonjour-hap`) advertiser honours `bind`, so if your advertiser is
  `avahi`, setting `bind` alone changes nothing.

Then restart Homebridge. (This only changes what HomeKit advertises — the Homebridge UI and any
VPN are unaffected.) Verify with `avahi-browse -rtp _hap._tcp` that your bridge shows only the
LAN address. Accessory identities are stable across a normal restart, so once the advertising is
clean your rooms will stick. If the error lingers, reboot your home hub (Apple TV / HomePod) to
flush its cached copy of the old address.
