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
sudo HOME="$HOME" npm_config_cache=/root/.npm \
  npm install --install-links ~/homebridge-teletask
sudo chown -R --reference=/var/lib/homebridge/node_modules/homebridge \
  /var/lib/homebridge/node_modules/homebridge-teletask
sudo hb-service restart
```

> **Why `HOME="$HOME"`?** `sudo npm install` runs as **root**, which has no SSH key, so cloning
> the private `teletask-api` repo fails with *Permission denied (publickey)*. Pointing `HOME` at
> your home makes root's `git`/`ssh` read **your** `~/.ssh` (keys, `config` and `known_hosts`),
> so it authenticates exactly as your own `git clone` does — whatever your key is named, and with
> no host-key prompt. `$HOME` expands before `sudo` runs; root can read your files.
> `npm_config_cache=/root/.npm` stops root leaving root-owned files in your `~/.npm`.
>
> If your key lives only in an ssh-agent (no file root can read), use
> `GIT_SSH_COMMAND="ssh -i /path/to/key"` with a readable key file instead.
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
sudo HOME="$HOME" npm_config_cache=/root/.npm \
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
