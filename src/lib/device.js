/**
 * @fileoverview Main orchestrator for GMK87 device communication
 * Re-exports all functions for backward compatibility with existing code
 */

// Import from Protocol.js
import {
  VENDOR_ID,
  PRODUCT_ID,
  REPORT_ID,
  BYTES_PER_FRAME,
  DISPLAY_WIDTH,
  DISPLAY_HEIGHT,
  delay,
  toRGB565,
  toHexNum,
  checksum,
} from "./protocol.js";

// Import from DeviceConnection.js (internal module)
import {
  findDeviceInfo as _findDeviceInfo,
  openDevice as _openDevice,
  drainDevice as _drainDevice,
  getKeyboardInfo as _getKeyboardInfo,
} from "./deviceConnection.js";

// Import from Communication.js
import {
  readResponse,
  send,
  trySend,
  waitForReady,
  sendConfigFrame,
  waitForInitAck,
  waitForImageAck,
} from "./communication.js";

// Import from ImageUpload.js
import {
  buildImageFrames,
  sendFrames,
  uploadImageToDevice,
  initializeDevice,
} from "./imageUpload.js";

// Import from ColorControl.js
import {
  buildLightingFrame,
  sendLightingFrame,
  trySendLightingFrame,
  configureLighting,
  syncTime,
} from "./colorControl.js";

// -------------------------------------------------------
// Re-exports for backward compatibility
// -------------------------------------------------------

// Constants
export {
  VENDOR_ID,
  PRODUCT_ID,
  REPORT_ID,
  BYTES_PER_FRAME,
  DISPLAY_WIDTH,
  DISPLAY_HEIGHT,
};

// Utilities
export { delay, toRGB565, toHexNum };

// Device Connection
export const findDeviceInfo = _findDeviceInfo;
export const openDevice = _openDevice;
export const drainDevice = _drainDevice;
export const getKeyboardInfo = _getKeyboardInfo;

// Protocol Functions
export {
  checksum,
  send,
  trySend,
  readResponse,
  waitForReady,
  sendConfigFrame,
  waitForInitAck,
  waitForImageAck,
};

// Frame Building & Transmission
export { buildImageFrames, sendFrames };

// High-Level Pipelines
export {
  initializeDevice,
  uploadImageToDevice,
  buildLightingFrame,
  sendLightingFrame,
  trySendLightingFrame,
  configureLighting,
  syncTime,
};