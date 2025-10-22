// src/uploadImage.js
import Jimp from "jimp";
import {
  openDevice,
  drainDevice,
  sendConfigFrame,
  delay,
  toRGB565,
  trySend,
} from "./lib/device.js";

async function loadImageToFrames(path, imageIndex = 0) {
  console.log(`Loading image: ${path} for imageIndex ${imageIndex}`);
  const img = await Jimp.read(path);

  if (img.bitmap.width !== 240 || img.bitmap.height !== 135) {
    console.log(`Resizing image to 240x135...`);
    img.resize(240, 135);
  }

  const width = 240;
  const height = 135;
  const frames = [];

  let startOffset = 0x00;
  let bufIndex = 0x08;
  const command = Buffer.alloc(64, 0);
  const BYTES_PER_FRAME = 0x38;

  function transmit() {
    if (bufIndex === 0x08) return;

    command[0x04] = BYTES_PER_FRAME;
    command[0x05] = startOffset & 0xff;
    command[0x06] = (startOffset >> 8) & 0xff;
    command[0x07] = imageIndex;

    frames.push(Buffer.from(command.subarray(4, 64)));

    startOffset += BYTES_PER_FRAME;
    bufIndex = 0x08;
    for (let q = bufIndex; q < 64; q++) command[q] = 0;
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const { r, g, b } = Jimp.intToRGBA(img.getPixelColor(x, y));
      const rgb565 = toRGB565(r, g, b);

      command[bufIndex++] = (rgb565 >> 8) & 0xff;
      command[bufIndex++] = rgb565 & 0xff;

      if (bufIndex >= 64) {
        transmit();
      }
    }
  }

  transmit();

  console.log(`Total frames generated: ${frames.length}`);
  return frames;
}

async function main() {
  const device = openDevice();

  // Drain stale messages first
  console.log("Clearing device buffer...");
  const stale = await drainDevice(device);
  if (stale.length > 0) {
    console.log(`  Drained ${stale.length} stale messages`);
  }

  console.log("Starting image upload with ACK verification...");

  let success;
  
  success = await trySend(device, 0x01);
  if (!success) throw new Error("Device not responding to INIT!");
  
  await delay(3);
  
  success = await trySend(device, 0x01);
  if (!success) throw new Error("Device not responding to 2nd INIT!");
  
  await delay(2);
  
  success = await sendConfigFrame(device, 2, 1, 1);
  if (!success) throw new Error("Device not responding to CONFIG!");
  
  await delay(25);
  
  success = await trySend(device, 0x02);
  if (!success) throw new Error("Device not responding to COMMIT!");
  
  await delay(18);
  
  success = await trySend(device, 0x23);
  if (!success) throw new Error("Device not responding to 0x23!");

  console.log("Device confirmed ready! Waiting 263ms...");
  await delay(263);

  async function sendFrames(label, frames) {
    console.log(`Sending ${frames.length} frames for ${label}...`);
    let sent = 0;
    let failed = 0;
    
    for (let i = 0; i < frames.length; i++) {
      const success = await trySend(device, 0x21, frames[i], 3);
      
      if (success) {
        sent++;
      } else {
        failed++;
        if (failed > 10) {
          throw new Error(`Too many failed ACKs, aborting`);
        }
      }
      
      if (i % 256 === 0 && i > 0) {
        console.log(`  Progress: ${i}/${frames.length} (${failed} failed)`);
      }
    }
    
    console.log(`${label} complete! ${sent}/${frames.length} (${failed} failed ACKs)`);
  }

  console.log("\n=== Uploading Image to slot 0 ===");
  const frames0 = await loadImageToFrames("nyan.bmp", 0);
  await sendFrames("Image slot 0", frames0);

  await delay(100);

  console.log("\n=== Uploading Image to slot 1 ===");
  const frames1 = await loadImageToFrames("encoded-rgb555.bmp", 1);
  await sendFrames("Image slot 1", frames1);

  success = await trySend(device, 0x02);
  if (!success) {
    console.warn("Final COMMIT may not have been acknowledged");
  }

  console.log("\n✓ Upload complete!");
  device.close();
}

main().catch((e) => console.error(e));