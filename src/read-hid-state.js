import HID from "node-hid";
import fs from "fs";

const VID = 0x320f;
const PID = 0x5055;
const OUTFILE = "/tmp/gmk87_state.json";

function sendCommand(dev, cmd, sub = 0x09) {
  const buf = Buffer.alloc(64, 0);
  buf[0] = 0x04;     // write channel
  buf[1] = cmd;      // opcode
  buf[2] = sub;      // subcommand
  dev.write(Array.from(buf));
  console.log(`→ Sent trigger 0x${cmd.toString(16)} sub=0x${sub.toString(16)}`);
}

function readFeature(dev) {
  const data = dev.getFeatureReport(0x05, 64);
  console.log(`[FEATURE][RID=0x5] len=${data.length}`);
  console.log(data.map(x => x.toString(16).padStart(2, "0")).join(""));
  return Buffer.from(data);
}

function decode(buf) {
  // Map your real fields here; this is placeholder scaffolding
  const brightness = buf[10];
  const speed = buf[11];
  const r = buf[14], g = buf[15], b = buf[16];
  return {
    underglow: { brightness, speed, hue: { red: r, green: g, blue: b } },
    rtc: { sec: 0, min: 0, hour: 0, date: 0, month: 0, year: 0 }
  };
}

try {
  const dev = new HID.HID(VID, PID);
  console.log(`[HID] Connected to GMK87 (VID 0x${VID.toString(16)}, PID 0x${PID.toString(16)})`);

  // probe all three commands, use first successful
  let config = null;
  for (const cmd of [0x21, 0x2b, 0x3d]) {
    sendCommand(dev, cmd);
    await new Promise(r => setTimeout(r, 120));
    const buf = readFeature(dev);
    if (buf.length >= 50) {
      config = decode(buf);
      break;
    }
  }

  if (config) {
    fs.writeFileSync(OUTFILE, JSON.stringify(config, null, 2));
    fs.chmodSync(OUTFILE, 0o666);
    console.log(`✓ RGB/time state saved → ${OUTFILE}`);
    console.table(config);
  } else {
    console.warn("⚠ No readable config frame");
  }

  dev.close();
} catch (err) {
  console.error("[ERR]", err.message);
}
