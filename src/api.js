/**
 * @fileoverview Public API for the GMK87 keyboard
 *
 * @example Default import
 *   import gmk87 from "./src/api.js";
 *
 *   // Upload static images to both slots
 *   await gmk87.uploadImage("cat.png", 0, { slot0File: "cat.png", slot1File: "dog.jpg" });
 *
 *   // Upload a GIF (auto-extracts frames, max 36 total across both slots)
 *   await gmk87.uploadImage("anim.gif", 0, { slot0File: "anim.gif", frameDuration: 100 });
 *
 *   // Upload GIFs to both slots
 *   await gmk87.uploadImage("a.gif", 0, { slot0File: "a.gif", slot1File: "b.gif", frameDuration: 150 });
 *
 *   // Change underglow lighting
 *   await gmk87.setLighting({ underglow: { effect: 5, brightness: 7, hue: { red: 255, green: 0, blue: 128 } } });
 *
 *   // Change LED key color (0=red,1=orange,2=yellow,3=green,4=teal,5=blue,6=purple,7=white,8=off)
 *   await gmk87.setLighting({ led: { mode: 3, color: 5 } });
 *
 *   // Switch displayed slot (0=time, 1=slot 0, 2=slot 1)
 *   await gmk87.showSlot(2);
 *
 *   // Sync system time to keyboard
 *   await gmk87.syncTime();
 *
 *   // Read current keyboard config
 *   const config = await gmk87.readConfig();
 *   console.log(config.underglow);    // { effect, brightness, speed, orientation, rainbow, hue }
 *   console.log(config.led);          // { mode, saturation, rainbow, color }
 *   console.log(config.showImage);    // 0, 1, or 2
 *   console.log(config.image1Frames); // frame count in slot 0
 *   console.log(config.frameDuration); // animation delay in ms
 *
 *   // Get device info
 *   const info = gmk87.getKeyboardInfo();
 *   console.log(info.product, info.vendorId, info.productId);
 *
 * @example Named imports
 *   import { uploadImage, setLighting, showSlot, readConfig } from "./src/api.js";
 *
 *   await uploadImage("cat.png", 0, { slot0File: "cat.png", slot1File: "dog.jpg" });
 *   await setLighting({ underglow: { effect: 12, brightness: 9 } });
 *   await showSlot(1);
 */

import {
  configureLighting,
  uploadImageToDevice,
  syncTime,
  getKeyboardInfo,
  openDevice,
  safeClose,
  readConfigFromDevice,
  parseConfigBuffer,
} from "./lib/device.js";

import { processAndSend } from "./sendImageMagick.js";

/**
 * Upload images with ImageMagick preprocessing (supports GIFs)
 * @param {string} imagePath - Path to the image file
 * @param {number} [slot=0] - Target slot (0 or 1)
 * @param {Object} [options] - Upload options
 * @param {string} [options.slot0File] - Path for slot 0 image
 * @param {string} [options.slot1File] - Path for slot 1 image
 * @param {number} [options.frameDuration] - Animation delay in ms (min 60, default 100 for GIFs)
 * @param {boolean} [options.showAfter=true] - Display the image after upload
 */
async function uploadImage(imagePath, slot = 0, options = {}) {
  return processAndSend(imagePath, slot, options);
}

/**
 * Configure lighting (read-modify-write, preserves unspecified settings)
 * @param {Object} changes - Settings to change
 * @param {Object} [changes.underglow] - Underglow settings
 * @param {number} [changes.underglow.effect] - Effect 0-18
 * @param {number} [changes.underglow.brightness] - Brightness 0-9
 * @param {number} [changes.underglow.speed] - Speed 0-9
 * @param {number} [changes.underglow.orientation] - 0 or 1
 * @param {boolean} [changes.underglow.rainbow] - Rainbow mode
 * @param {Object} [changes.underglow.hue] - { red, green, blue } each 0-255
 * @param {Object} [changes.led] - LED key settings
 * @param {number} [changes.led.mode] - Mode 0-4
 * @param {number} [changes.led.color] - 0=red,1=orange,2=yellow,3=green,4=teal,5=blue,6=purple,7=white,8=off
 * @param {number} [changes.led.saturation] - Saturation 0-9
 * @param {boolean} [changes.led.rainbow] - Rainbow mode
 * @param {number} [changes.showImage] - 0=time, 1=slot 0, 2=slot 1
 */
async function setLighting(changes) {
  return configureLighting(changes);
}

/**
 * Switch the displayed image slot
 * @param {number} slot - 0=show time, 1=show slot 0, 2=show slot 1
 */
async function showSlot(slot) {
  return configureLighting({ showImage: slot });
}

/**
 * Read current keyboard configuration
 * @returns {Promise<Object>} Parsed config with underglow, led, showImage, image1Frames, image2Frames, frameDuration
 */
async function readConfig() {
  const device = openDevice();
  try {
    return parseConfigBuffer(await readConfigFromDevice(device));
  } finally {
    await safeClose(device);
  }
}

export default {
  uploadImage,
  setLighting,
  showSlot,
  syncTime,
  readConfig,
  getKeyboardInfo,
};

export {
  uploadImage,
  setLighting,
  showSlot,
  syncTime,
  readConfig,
  getKeyboardInfo,
};
