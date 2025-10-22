// src/uploadImage.js
import Jimp from "jimp";
import {
  openDevice,
  sendConfigFrame,
  send,
  delay,
  toRGB565,
} from "./lib/device.js";

// -------------------------------------------------------
// Convert image to HID data frames (60-byte payloads)
//   payload[0] = 0x38 (56 data bytes inside this frame)
//   payload[1] = startOffset LSB
//   payload[2] = startOffset MSB
//   payload[3] = imageIndex
//   payload[4..59] = 56 bytes of pixel data (RGB565, MSB first)
// -------------------------------------------------------
async function loadImageToFrames(path, imageIndex = 0) {
  console.log(`Loading image: ${path} for imageIndex ${imageIndex}`);
  const img = await Jimp.read(path);

  if (img.bitmap.width !== 240 || img.bitmap.height !== 135) {
    console.log(`Resizing image to 240x135...`);
    img.resize(240, 135); // keep aspect? we force exact panel res
  }

  const width = 240;
  const height = 135;

  const frames = [];

  // Important: do NOT bias the startOffset per image.
  // The target "slot" is chosen by imageIndex; offset must begin at 0.
  let startOffset = 0x00;

  // We build a 64B working buffer; indices 4..63 are the 60B payload.
  // Inside the payload, pixel bytes start at global index 8 (payload idx 4).
  let bufIndex = 0x08;
  const command = Buffer.alloc(64, 0);

  // Fixed "bytes in frame" = 56 (0x38), as per device expectation.
  const BYTES_PER_FRAME = 64 - 8; // 56
  const PAYLOAD_LEN = 60;

  function transmit() {
    if (bufIndex === 0x08) return; // nothing to send

    const startOffsetLsb = startOffset & 0xff;
    const startOffsetMsb = (startOffset >> 8) & 0xff;

    // Header inside payload
    command[0x04] = 0x38; // 56 data bytes per frame
    command[0x05] = startOffsetLsb; // LSB
    command[0x06] = startOffsetMsb; // MSB
    command[0x07] = imageIndex; // image slot selector

    // Push the 60-byte payload (bytes 4..63)
    frames.push(Buffer.from(command.subarray(4, 64)));

    // Advance offset by the amount of pixel data we just queued (56 bytes)
    startOffset += BYTES_PER_FRAME;

    // Reset pixel write index and clear pixel area
    bufIndex = 0x08;
    for (let q = bufIndex; q < 64; q++) command[q] = 0;
  }

  // Write pixels row-major; each pixel = 2 bytes (MSB then LSB)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const { r, g, b } = Jimp.intToRGBA(img.getPixelColor(x, y));
      const rgb565 = toRGB565(r, g, b);

      command[bufIndex++] = (rgb565 >> 8) & 0xff; // MSB
      command[bufIndex++] = rgb565 & 0xff; // LSB

      if (bufIndex >= 64) {
        transmit();
      }
    }
  }

  // Flush any remaining partial frame (zero-padded)
  transmit();

  console.log(`Total frames generated: ${frames.length}`);
  return frames;
}

// -------------------------------------------------------
// Main entry
// -------------------------------------------------------
async function main() {
  const device = openDevice();

  console.log("Starting image upload sequence...");

  // Init sequence mirrored from the C# impl
  send(device, 0x01);
  sendConfigFrame(device, 1, 1, 1);
  send(device, 0x02);
  send(device, 0x23);
  send(device, 0x01);

  // Give the device a breath (avoids first-row white issue)
  console.log("Waiting 500ms...");
  await delay(500);

  // Helper to send frames with gentle pacing
  async function sendFrames(label, frames) {
    console.log(`Sending ${frames.length} frames for ${label}...`);
    for (let i = 0; i < frames.length; i++) {
      send(device, 0x21, frames[i]); // payload is exactly 60B
      // Gentle drip every 64 frames to improve reliability
      if (i % 64 === 63) await delay(1);
      if (i % 256 === 0 && i > 0) {
        console.log(`  Progress: ${i}/${frames.length}`);
        await delay(2);
      }
    }
    console.log(`${label} complete!`);
  }

  // Upload image 0
  console.log("\n=== Uploading Image to slot 0 ===");
  const frames0 = await loadImageToFrames("nyan.bmp", 0);
  await sendFrames("Image slot 0", frames0);

  // Upload image 1
  console.log("\n=== Uploading Image to slot 1 ===");
  const frames1 = await loadImageToFrames("encoded-rgb555.bmp", 1);
  await sendFrames("Image slot 1", frames1);

  // Finalize
  send(device, 0x02);

  console.log("\nUpload complete!");
  device.close();
}

main().catch((e) => console.error(e));