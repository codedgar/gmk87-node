/**
 * @fileoverview Protocol constants and packet building utilities for GMK87
 * Contains device identifiers, protocol constants, checksums, and utility functions
 */

// -------------------------------------------------------
// Device Constants
// -------------------------------------------------------

/** @constant {number} USB Vendor ID for GMK87 keyboard */
export const VENDOR_ID = 0x320f;

/** @constant {number} USB Product ID for GMK87 keyboard */
export const PRODUCT_ID = 0x5055;

/** @constant {number} HID Report ID used for all communications */
export const REPORT_ID = 0x04;

/** @constant {number} Number of data bytes per frame packet */
export const BYTES_PER_FRAME = 0x38;

/** @constant {number} Target display width in pixels */
export const DISPLAY_WIDTH = 240;

/** @constant {number} Target display height in pixels */
export const DISPLAY_HEIGHT = 135;

// -------------------------------------------------------
// Utility Functions
// -------------------------------------------------------

/**
 * Creates a promise that resolves after a specified delay
 * @param {number} ms - Milliseconds to delay
 * @returns {Promise<void>} Promise that resolves after the delay
 */
export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Converts RGB color values to RGB565 format (16-bit color)
 * RGB565 uses 5 bits for red, 6 bits for green, and 5 bits for blue
 * @param {number} r - Red component (0-255)
 * @param {number} g - Green component (0-255)
 * @param {number} b - Blue component (0-255)
 * @returns {number} 16-bit RGB565 color value
 */
export function toRGB565(r, g, b) {
  const r5 = (r >> 3) & 0x1f;
  const g6 = (g >> 2) & 0x3f;
  const b5 = (b >> 3) & 0x1f;
  return (r5 << 11) | (g6 << 5) | b5;
}

/**
 * Converts a decimal number (0-99) to BCD (Binary-Coded Decimal) format
 * Used for encoding time/date values in device protocol
 * @param {number} num - Number to convert (0-99)
 * @returns {number} BCD-encoded value
 * @throws {RangeError} If num is outside the range 0-99
 * @example
 * toHexNum(42) // returns 0x42 (66 in decimal)
 * toHexNum(99) // returns 0x99 (153 in decimal)
 */
export function toHexNum(num) {
  if (num < 0 || num >= 100) throw new RangeError("toHexNum expects 0..99");
  const low = num % 10;
  const high = Math.floor(num / 10);
  return (high << 4) | low;
}

/**
 * Calculates a 16-bit checksum for the device protocol
 * Sums bytes from position 3 to 63 in the buffer
 * @param {Buffer} buf - 64-byte buffer to calculate checksum for
 * @returns {number} 16-bit checksum value
 */
export function checksum(buf) {
  let sum = 0;
  for (let i = 3; i < 64; i++) {
    sum = (sum + (buf[i] & 0xff)) & 0xffff;
  }
  return sum;
}