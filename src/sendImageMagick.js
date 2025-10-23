// src/sendImageMagick.js
import { execFileSync } from "child_process";
import os from "os";
import path from "path";
import fs from "fs";
import Jimp from "jimp";
import {
  openDevice,
  drainDevice,
  sendConfigFrame,
  trySend,
  delay,
  toRGB565,
  waitForReady, // 👈 new import
  resetDeviceState,
  reviveDevice
} from "./lib/device.js";

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function magickConvert(inPath, outPath) {
  const common = [
    inPath,
    "-resize",
    "240x135!",
    "-background",
    "black",
    "-alpha",
    "remove",
    "-alpha",
    "off",
    "-strip",
    "-colorspace",
    "sRGB",
    "-type",
    "TrueColor",
    `bmp3:${outPath}`,
  ];
  const tries = [
    { bin: "magick", args: common },
    { bin: "magick", args: ["convert", ...common] },
    { bin: "convert", args: common },
  ];
  let last;
  for (const t of tries) {
    try {
      execFileSync(t.bin, t.args, { stdio: "ignore" });
      return;
    } catch (e) {
      last = e;
    }
  }
  throw new Error(
    `ImageMagick not found/failed. Ensure 'magick' or 'convert' is in PATH. ${
      last ? last.message : ""
    }`
  );
}

async function buildFramesFromBitmap(bmpPath, imageIndex) {
  const img = await Jimp.read(bmpPath);
  const width = 240,
    height = 135;
  if (img.bitmap.width !== width || img.bitmap.height !== height) {
    img.resize(width, height);
  }

  const frames = [];
  const command = Buffer.alloc(64, 0);

  const BYTES_PER_FRAME = 0x38;
  let startOffset = 0x00;
  let bufIndex = 0x08;

  function transmit() {
    if (bufIndex === 0x08) return;

    command[0x04] = BYTES_PER_FRAME;
    command[0x05] = startOffset & 0xff;
    command[0x06] = (startOffset >> 8) & 0xff;
    command[0x07] = imageIndex;

    frames.push(Buffer.from(command.subarray(4, 64)));

    startOffset += BYTES_PER_FRAME;
    bufIndex = 0x08;
    command.fill(0, 0x08);
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const { r, g, b } = Jimp.intToRGBA(img.getPixelColor(x, y));
      const rgb565 = toRGB565(r, g, b);
      command[bufIndex++] = (rgb565 >> 8) & 0xff;
      command[bufIndex++] = rgb565 & 0xff;
      if (bufIndex >= 64) transmit();
    }
  }
  transmit();
  return frames;
}

async function sendFrames(device, frames) {
  let sent = 0;
  let failed = 0;

  for (let i = 0; i < frames.length; i++) {
    const success = await trySend(device, 0x21, frames[i], 3);

    if (success) {
      sent++;
    } else {
      failed++;
      if (failed > 10) {
        throw new Error(`Too many failed ACKs (${failed}), aborting upload`);
      }
    }

    if (i % 256 === 0 && i > 0) {
      console.log(`  Progress: ${i}/${frames.length} (${failed} failed ACKs)`);
    }
  }

  console.log(`  Sent ${sent}/${frames.length} frames (${failed} failed ACKs)`);

  if (failed > 0) {
    console.warn(`  ⚠ Warning: ${failed} frames may not have been acknowledged`);
  }
}

export async function processAndSend(
  imagePath,
  imageIndex = 0,
  { showAfter = true } = {}
) {
  if (!imagePath || typeof imagePath !== "string")
    throw new Error("imagePath is required");
  if (!fs.existsSync(imagePath))
    throw new Error(`Input file not found: ${imagePath}`);
  if (imageIndex !== 0 && imageIndex !== 1)
    throw new Error("Slot must be 0 or 1");

  const tmp = path.join(
    os.tmpdir(),
    `gmk87-prepped-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.bmp`
  );

  const shownImage = showAfter ? imageIndex + 1 : 0;

  let device;
  try {
    magickConvert(imagePath, tmp);

    device = openDevice();

    // CRITICAL: Drain any stale/pending responses first
    console.log("Clearing device buffer...");
    const stale = await drainDevice(device);
    if (stale.length > 0) {
      console.log(`  Drained ${stale.length} stale messages`);
    }
    
    await resetDeviceState(device);

    console.log("Initializing with ACK handshake...");

    let success;

    success = await trySend(device, 0x01);
    if (!success) {
      console.warn("No INIT ACK — trying soft revive...");
      const revived = await reviveDevice(device);
      if (!revived) throw new Error("Device could not be revived.");
      device = revived; // swap handle
    }
    await delay(3);

    success = await trySend(device, 0x01);
    if (!success) throw new Error("Device not responding to 2nd INIT!");
    await delay(2);

    success = await sendConfigFrame(device, shownImage, 1, 1);
    if (!success) throw new Error("Device not responding to CONFIG!");
    await delay(25);

    success = await trySend(device, 0x02);
    if (!success) throw new Error("Device not responding to COMMIT!");
    await delay(18);

    success = await trySend(device, 0x23);
    if (!success) throw new Error("Device not responding to 0x23 command!");

    // Replaces the old fixed delay with event-driven wait
    await waitForReady(device);

    console.log(`Building frames for slot ${imageIndex}...`);
    const frames = await buildFramesFromBitmap(tmp, imageIndex);

    console.log(`Sending ${frames.length} frames with ACK verification...`);
    await sendFrames(device, frames);

    success = await trySend(device, 0x02);
    if (!success) {
      console.warn("Final COMMIT may not have been acknowledged");
    }

    console.log("✓ Upload complete!");
  } finally {
    try {
      if (device) device.close();
    } catch {}
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv);
  const file = args.file || args.f;
  const slot = Number(args.slot ?? 0);
  const show =
    args.show === undefined ? true : String(args.show).toLowerCase() !== "false";

  if (!file || Number.isNaN(slot) || slot < 0 || slot > 1) {
    console.error(
      "Usage: node src/sendImageMagick.js --file <path> --slot <0|1> [--show=true|false]"
    );
    process.exit(1);
  }

  processAndSend(file, slot, { showAfter: show }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
