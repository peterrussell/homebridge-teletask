# Installation & updates

## Requirements

- Homebridge **1.6+** (including Homebridge 2.x) and Node **18+**.
- A TELETASK DoIP central unit reachable on your network, with the **TDS15132** licence or
  trial active — see [PROSOFT & licensing](prosoft-and-licensing.md).
- Git access (over SSH) to the **`teletask-api`** library repo, which this plugin pulls in
  as a pinned dependency at build time. See [The library dependency](#the-library-dependency).

## The library dependency

This plugin does **not** contain the TELETASK protocol code. It depends on the separate
[`teletask-api`](https://github.com/peterrussell/js-teletask) library, pinned to a specific
git tag in `package.json`:

```json
"dependencies": {
  "teletask-api": "git+ssh://git@github.com/peterrussell/js-teletask.git#v1.0.0"
}
```

`npm install` fetches the library from that tag over SSH — no npm registry involved, and the
two projects version independently. To move to a newer library release, change the `#v1.0.0`
tag and reinstall.

Because the fetch is over SSH from a private repo, **whoever runs `npm install` must have an
SSH key that can read that repo**. On a single-user machine that's automatic; on the
Homebridge host, where installs run under `sudo`, see the note below.

## Install from source

```bash
# 1. get the plugin
git clone git@github.com:peterrussell/homebridge-teletask.git
cd homebridge-teletask

# 2. install it into Homebridge as a tracked dependency (copies, doesn't symlink).
#    This also fetches the pinned teletask-api library over SSH.
cd /var/lib/homebridge
grep -q install-links .npmrc 2>/dev/null || echo "install-links=true" | sudo tee -a .npmrc
sudo --preserve-env=SSH_AUTH_SOCK HOME="$HOME" npm_config_cache=/root/.npm \
  npm install --install-links ~/homebridge-teletask
sudo chown -R --reference=/var/lib/homebridge/node_modules/homebridge \
  /var/lib/homebridge/node_modules/homebridge-teletask
sudo hb-service restart
```

> **Why the extra env?** `sudo npm install` runs as **root**, which has no SSH credentials, so
> cloning the private `teletask-api` repo fails with *Permission denied (publickey)*. The flags
> hand root your credentials:
> - `HOME="$HOME"` — root's `git`/`ssh` read **your** `~/.ssh` (`config` and `known_hosts`), so
>   there's no host-key prompt. `$HOME` expands before `sudo` runs; root can read your files.
> - `--preserve-env=SSH_AUTH_SOCK` — if your key is in an **ssh-agent** (including a forwarded
>   agent, with no key file on the host), this passes the agent socket through so root can use it.
> - `npm_config_cache=/root/.npm` — keeps root from leaving root-owned files in your `~/.npm`.
>
> It authenticates exactly as your own `git clone` does, whatever your key is named and wherever
> it lives. (A plain on-disk key works too — `HOME` alone finds it; the agent flag is then a
> harmless no-op.)
>
> Paths assume the official Homebridge image (storage at `/var/lib/homebridge`). The key is
> installing into the folder Homebridge actually scans for plugins — check its startup log for
> the `-P <path>` flag if unsure.

## Install (Homebridge UI)

Not available: this plugin isn't published to the npm registry, so it won't appear in the
Homebridge UI *Plugins* search. Install from source as above; configure it afterwards in the
UI (see [Configuration](configuration.md)).

## Updating

`npm install` can report *"up to date"* and **skip re-copying** a local package whose version
number hasn't changed — leaving the old build in place. So bump the plugin's `version` in
`package.json` each release (or uninstall first) to force a clean re-copy:

```bash
cd ~/homebridge-teletask && git pull
cd /var/lib/homebridge
sudo npm uninstall homebridge-teletask
sudo --preserve-env=SSH_AUTH_SOCK HOME="$HOME" npm_config_cache=/root/.npm \
  npm install --install-links ~/homebridge-teletask
sudo hb-service restart
```

> Updating the plugin does **not** move it to a newer library version — the library tag is
> pinned in `package.json`. To take a new `teletask-api` release, edit the `#v<tag>` in
> `dependencies` first, commit, then run the update above.

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

Then restart Homebridge. (This only changes what HomeKit advertises — Tailscale and the
Homebridge UI are unaffected.) Verify with `avahi-browse -rtp _hap._tcp` that your bridge shows
only the LAN address. Accessory identities are stable across a normal restart, so once the
advertising is clean your rooms will stick. If the error lingers, reboot your home hub
(Apple TV / HomePod) to flush its cached copy of the old address.
