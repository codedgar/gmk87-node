// src/sendImageMagick.js
import { execFileSync } from "child_process";
import os from "os";
import path from "path";
import fs from "fs";
import Jimp from "jimp";
import {
  openDevice,
  send,
  sendConfigFrame,
  trySend,
  delay,
  toRGB565,
} from "./lib/device.js";

// args: --key value | --key=value
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

// ImageMagick runner: tries magick, magick convert, convert
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
  const BYTES_PER_FRAME = 64 - 8; // 56 bytes of pixel data

  // IMPORTANT: mirror C# behavior
  // var startOffset = imageIndex * 0x28;  // not 0x00 for image 1
  let startOffset = imageIndex * 0x28;

  let bufIndex = 0x08; // first pixel byte index in 64B report

  function transmit() {
    if (bufIndex === 0x08) return;

    // header inside the 60B payload
    command[0x04] = 0x38; // 56 data bytes in this frame
    command[0x05] = startOffset & 0xff; // offset LSB
    command[0x06] = (startOffset >> 8) & 0xff; // offset MSB
    command[0x07] = imageIndex; // image slot (0 or 1)

    frames.push(Buffer.from(command.subarray(4, 64)));

    // advance by the 56 bytes of pixel data we just filled
    startOffset += BYTES_PER_FRAME;

    // reset pixel area
    bufIndex = 0x08;
    command.fill(0, 0x08);
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const { r, g, b } = Jimp.intToRGBA(img.getPixelColor(x, y));
      const rgb565 = toRGB565(r, g, b);
      command[bufIndex++] = (rgb565 >> 8) & 0xff; // MSB
      command[bufIndex++] = rgb565 & 0xff; // LSB
      if (bufIndex >= 64) transmit();
    }
  }
  transmit(); // flush final partial frame
  return frames;
}

async function sendFrames(device, frames) {
  let sent = 0;
  for (let i = 0; i < frames.length; i++) {
    // Retry around 0x21 writes improves stability a lot
    await trySend(device, 0x21, frames[i], 3);
    sent++;

    // Gentle pacing: tiny breathers to avoid HID backlog
    if ((i & 63) === 63) await delay(2); // every 64 frames
    if ((i & 255) === 255) await delay(4); // every 256 frames

    if ((i & 255) === 0 && i > 0) {
      console.log(`  sent ${i}/${frames.length}`);
    }
  }
  console.log(`  sent ${sent}/${frames.length}`);
}

/**
 * Stable flow:
 *  1) 0x01
 *  2) sendConfigFrame(shownImage, 1, 1)  // shownImage: 0=time, 1=slot0, 2=slot1
 *  3) 0x02
 *  4) 0x23
 *  5) 0x01
 *  6) sleep ~500–600ms
 *  7) send pixels (0x21 ...)
 *  8) 0x02   // commit once at the end
 */
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

  // 0=time widget, 1=slot0, 2=slot1
  const shownImage = showAfter ? imageIndex + 1 : 1;

  let device;
  try {
    magickConvert(imagePath, tmp);

    device = openDevice();
    console.log("init (C#-style)...");
    await trySend(device, 0x01);
    sendConfigFrame(device, shownImage, 1, 1);
    await trySend(device, 0x02);
    await trySend(device, 0x23);
    await trySend(device, 0x01);
    await delay(600); // slightly longer pause improves first-row stability

    console.log(`building frames for slot ${imageIndex}...`);
    const frames = await buildFramesFromBitmap(tmp, imageIndex);

    console.log(`sending ${frames.length} frames...`);
    await sendFrames(device, frames);

    await trySend(device, 0x02); // single commit at the end
    console.log("commit sent.");
  } finally {
    try {
      if (device) device.close();
    } catch {}
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv);
  const file = args.file || args.f;
  const slot = Number(args.slot ?? 0); // 0 or 1
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