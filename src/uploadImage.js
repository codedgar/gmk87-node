/**
 * @fileoverview Direct image upload utility for GMK87 keyboard
 * Uploads pre-formatted BMP images to both device slots without ImageMagick dependency
 * Expects images to already be in 240x135 pixel format
 */

import {
  openDevice,
  drainDevice,
  buildRawImageData,
  sendFrameData,
  sendWithPosition,
  readConfigFromDevice,
  parseConfigBuffer,
  buildConfigBuffer,
  writeConfigToDevice,
  delay,
} from "./lib/device.js";

/**
 * Main upload function - uploads two images to device slots 0 and 1
 * Uses NEW protocol throughout: read-modify-write preserves ALL config bytes
 * Matches sniffed sequence: INIT → INIT → CONFIG → COMMIT → READY → FRAME_DATA → COMMIT
 * @returns {Promise<void>} Resolves when both uploads complete successfully
 * @throws {Error} If device initialization fails or upload encounters errors
 */
async function main() {
  let device = openDevice();

  console.log("Clearing device buffer...");
  const stale = await drainDevice(device, 500);
  if (stale.length > 0) {
    console.log(`  Drained ${stale.length} stale messages`);
  }

  await delay(200); // Let device settle

  console.log("Starting image upload...");

  // Build raw image data (matches Python's encode_frame - 32KB padded per image)
  console.log("\n=== Building raw image data ===");
  const imageData0 = await buildRawImageData("nyan.bmp");
  const imageData1 = await buildRawImageData("encoded-rgb555.bmp");
  console.log(`Image 0: ${imageData0.length} bytes`);
  console.log(`Image 1: ${imageData1.length} bytes`);

  const concatenatedData = Buffer.concat([imageData0, imageData1]);
  console.log(`Total concatenated: ${concatenatedData.length} bytes\n`);

  // === Read current config (preserves ALL bytes including unknown ones) ===
  console.log("=== Reading current config ===");
  const configBuffer = await readConfigFromDevice(device);
  const currentConfig = parseConfigBuffer(configBuffer);
  console.log(`  Underglow: effect=${currentConfig.underglow.effect}, brightness=${currentConfig.underglow.brightness}`);
  console.log(`  LED: mode=${currentConfig.led.mode}, color=${currentConfig.led.color}`);

  // === Build new config: only change showImage + frame counts ===
  const newConfig = buildConfigBuffer(currentConfig, {
    showImage: 1,       // show slot 0 after upload
    image1Frames: 1,
    image2Frames: 1,
    time: true,         // sync time while we're at it
  });

  // === Upload sequence matching sniffed protocol ===
  // INIT → INIT → CONFIG(0x06) → COMMIT → READY(0x23) → FRAME_DATA × N → COMMIT
  console.log("\n=== Initializing upload (new protocol) ===");

  // Two INITs as sniffed captures show
  await sendWithPosition(device, 0x01, Buffer.alloc(0), 0);
  await sendWithPosition(device, 0x01, Buffer.alloc(0), 0);

  // CONFIG — write full config preserving all lighting
  await sendWithPosition(device, 0x06, newConfig, 0);

  // COMMIT
  await sendWithPosition(device, 0x02, Buffer.alloc(0), 0);

  // READY — start upload session (ACK from sendWithPosition confirms device is ready)
  await sendWithPosition(device, 0x23, Buffer.alloc(0), 0);

  console.log("\n=== Uploading both images ===");
  await sendFrameData(device, concatenatedData, "both slots");

  console.log("\n=== Upload Commit ===");
  const response = await sendWithPosition(device, 0x02, Buffer.alloc(0), 0);
  if (!response) console.warn("Upload COMMIT may not have been acknowledged");

  console.log("\n✓ Upload complete!");
  device.close();
}

// -------------------------------------------------------
// Entry Point
// -------------------------------------------------------

main().catch((e) => console.error(e));