#!/usr/bin/env node
// Self-contained DoIP probe — NO dependencies (node built-ins only), read-only.
//
// It sweeps every relay/dimmer/motor/sensor output the central unit answers for and
// prints each one's raw state bytes (and the ErrorState byte, which the TDS15132 spec
// marks "Not Used"). Purpose: find out whether this particular unit exposes ANY signal
// that separates a wired output from an unused one — the protocol has no documented
// "device present" field, so we're checking empirically before adding any auto-"UNUSED"
// logic to the plugin.
//
// Safe to run while Homebridge is running (the TDS allows multiple connections). It only
// sends keep-alive + Function Get; it never sets anything.
//
//   node scripts/probe-raw.mjs [host] [port] [centralUnit]
//   node scripts/probe-raw.mjs 192.168.1.113 55957 1
import net from "node:net";

const HOST = process.argv[2] || "192.168.1.113";
const PORT = Number(process.argv[3] || 55957);
const CU = Number(process.argv[4] || 1);

const STX = 0x02;
const ACK = 0x0a;
const FUNCTION_GET = 0x06;
const KEEP_ALIVE = 0x0b;
const EVENT_REPORT = 0x10;
const SENSOR_MAX = 0x3f00; // sensor short >= this means "no sensor / error" (spec §6.8)

const FUNCS = [
  { fn: 1, name: "RELAY", max: 32 },
  { fn: 2, name: "DIMMER", max: 16 },
  { fn: 6, name: "MOTOR", max: 16 },
  { fn: 20, name: "SENSOR", max: 24 }
];

const checksum = (bytes) => bytes.reduce((sum, b) => (sum + b) & 0xff, 0);
function frame(command, params = []) {
  const head = [STX, params.length + 3, command, ...params];
  return Buffer.from([...head, checksum(head)]);
}
const keepAlive = () => frame(KEEP_ALIVE);
const get = (fn, n) => frame(FUNCTION_GET, [CU, fn, (n >> 8) & 0xff, n & 0xff]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const found = new Map(); // "fn:n" -> { fn, n, err, state(Buffer) }
let buf = Buffer.alloc(0);
let reported = false;

function drain(sock) {
  let o = 0;
  while (o < buf.length) {
    if (buf[o] === ACK) {
      o += 1;
      continue;
    }
    if (buf[o] !== STX) {
      o += 1;
      continue;
    }
    if (o + 2 > buf.length) break;
    const total = buf[o + 1] + 1;
    if (o + total > buf.length) break;
    const f = buf.subarray(o, o + total);
    o += total;
    const command = f[2];
    const params = f.subarray(3, f.length - 1);
    try {
      sock.write(Buffer.from([ACK]));
    } catch {}
    if (command === EVENT_REPORT && params.length >= 4) {
      const fn = params[1];
      const n = (params[2] << 8) | params[3];
      const err = params.length >= 5 ? params[4] : null;
      const state = Buffer.from(params.subarray(5));
      found.set(`${fn}:${n}`, { fn, n, err, state });
    }
  }
  buf = buf.subarray(o);
}

function report() {
  if (reported) return;
  reported = true;
  for (const { fn, name } of FUNCS) {
    const rows = [...found.values()].filter((x) => x.fn === fn).sort((a, b) => a.n - b.n);
    console.log(`\n== ${name} (fn ${fn}) — ${rows.length} answered ==`);
    for (const r of rows) {
      const hex = r.state.toString("hex").replace(/(..)/g, "$1 ").trim() || "(none)";
      let extra = "";
      if (fn === 20 && r.state.length >= 2) {
        const short = (r.state[0] << 8) | r.state[1];
        extra = short >= SENSOR_MAX ? "  -> NO SENSOR (>= SENS_MAX)" : `  -> ${(short / 10 - 273).toFixed(1)} C`;
      }
      console.log(`  #${String(r.n).padStart(2)}  err=${r.err}  state=[${hex}]${extra}`);
    }
  }
  console.log(`\nTotal outputs answered: ${found.size}`);
  console.log(
    "\nNow note which RELAY numbers are actually wired to something vs. unused, and send this\n" +
      "back — we'll see if the unused ones share a distinguishing byte (or simply don't answer)."
  );
}

const s = net.createConnection({ host: HOST, port: PORT });
s.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  drain(s);
});
s.on("error", (e) => {
  console.error(`socket error: ${e?.message ?? e}`);
  process.exit(1);
});
s.on("connect", async () => {
  console.error(`connected ${HOST}:${PORT} (central unit ${CU}) — sweeping...`);
  s.write(keepAlive());
  await sleep(400);
  for (const { fn, max } of FUNCS) {
    for (let n = 1; n <= max; n++) {
      s.write(get(fn, n));
      await sleep(110);
    }
  }
  await sleep(1200);
  report();
  try {
    s.end();
  } catch {}
  process.exit(0);
});
setTimeout(() => {
  report();
  process.exit(0);
}, 30000);
