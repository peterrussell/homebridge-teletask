# PROSOFT & licensing

This plugin talks to your central unit over TELETASK's **DoIP Open Protocol**. That protocol
is a licensed feature, so a little setup in PROSOFT is required before the plugin can control
anything.

## What is PROSOFT?

**PROSOFT** is TELETASK's Windows configuration tool. Your installer uses it to define every
output (lights, blinds, heating zones, …), their numbers and rooms, and to upload that
configuration (the `.NBT` file) to the central unit. This plugin doesn't replace PROSOFT — it
just controls the outputs PROSOFT has already set up. You'll refer to PROSOFT to find your
output **numbers** (GUISOFT → *Define Output*).

## The TDS15132 licence (required)

Third‑party control over DoIP is gated by the **TELETASK "DoIP Open Protocol" licence,
TDS15132**. Until it's active, the control port is closed and the plugin can connect but not
switch anything.

To enable it:

1. In PROSOFT, add the **TDS15132** as a *GUI* in GUISOFT.
2. **Download** the configuration to the central unit.
3. This opens **TCP port 55957** for the protocol.

- **No licence?** The port opens for a **free 3‑day trial** after a download — enough to try
  the plugin out.
- **For permanent use**, obtain a TDS15132 licence for your unit and import its activation
  file in PROSOFT (it's tied to your central unit's serial number).

> If the plugin logs `Connected…` but nothing responds, the licence/trial has almost certainly
> lapsed — re‑download from PROSOFT (or import your licence).

## Ports, for reference

| Port | Purpose |
|---|---|
| **55957** | **DoIP Open Protocol — what this plugin uses** (licence‑gated) |
| 55956 | Legacy/monitor port — accepts a connection but ignores real commands |
| 55955 | PROSOFT's own (SSH) commissioning channel — not for third‑party use |
| 80 | A read‑only "technical support" info page |

Always use **55957**.

## Finding your unit's IP

Your central unit needs a reachable IP on your LAN (set as Static in PROSOFT is best). You can
find it from your router's device list, from PROSOFT's *Communication → Search*, or by browsing
to a suspected IP (its port‑80 page is titled "TELETASK DOIP Central Unit"). Put that IP in the
plugin's `host`.
