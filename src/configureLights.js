/**
 * @fileoverview GMK87 Keyboard Lighting Configuration Utility
 * Configures underglow effects, LED brightness, speed, colors, and more
 * Ported from Python GMK87Tool to Node.js
 */

import HID from "node-hid";
import { 
  VENDOR_ID as GMK87_VENDOR_ID,
  PRODUCT_ID as GMK87_PRODUCT_ID,
  GMK87_USAGE_CONFIG,
  checksum,
  toHexNum,
  delay
} from "./lib/device.js";

/**
 * Available underglow effects
 */
export const UNDERGLOW_EFFECTS = {
  OFF: 0x00,
  HORIZONTAL_DIMMING_WAVE: 0x01,
  HORIZONTAL_PULSE_WAVE: 0x02,
  WATERFALL: 0x03,
  FULL_CYCLING_COLORS: 0x04,
  BREATHING: 0x05,
  FULL_ONE_COLOR: 0x06,
  GLOW_PRESSED_KEY: 0x07,
  GLOW_SPREADING: 0x08,
  GLOW_ROW: 0x09,
  RANDOM_PATTERN: 0x0a,
  RAINBOW_CYCLE: 0x0b,
  RAINBOW_WATERFALL: 0x0c,
  WAVE_FROM_CENTER: 0x0d,
  CIRCLING_JK: 0x0e,
  RAINING: 0x0f,
  WAVE_LEFT_RIGHT: 0x10,
  SLOW_SATURATION_CYCLE: 0x11,
  SLOW_RAINBOW_FROM_CENTER: 0x12,
};

/**
 * Available LED modes for the big LED (screen area indicator)
 */
export const LED_MODES = {
  BLINKING_ONE_COLOR: 0x00,
  PULSE_RAINBOW: 0x01,
  BLINKING_ONE_COLOR_ALT: 0x02,
  FIXED_COLOR: 0x03,
  FIXED_COLOR_ALT: 0x04,
};

/**
 * LED color presets for the big LED
 */
export const LED_COLORS = {
  RED: 0x00,
  ORANGE: 0x01,
  YELLOW: 0x02,
  GREEN: 0x03,
  TEAL: 0x04,
  BLUE: 0x05,
  PURPLE: 0x06,
  WHITE: 0x07,
  OFF: 0x08,
};

/**
 * Default configuration values
 */
const DEFAULT_CONFIG = {
  underglow: {
    effect: UNDERGLOW_EFFECTS.HORIZONTAL_DIMMING_WAVE,
    brightness: 2, // 0-9 (0=off, 9=max)
    speed: 2, // 0-9 (0=fast, 9=slow)
    orientation: 1, // 0=left-to-right, 1=right-to-left
    rainbow: 1, // 0=hue mode only, 1=rainbow mode
    hue: {
      red: 0xff,
      green: 0xff,
      blue: 0xff,
    },
  },
  led: {
    mode: LED_MODES.BLINKING_ONE_COLOR,
    saturation: 0, // 0-9
    rainbow: 1, // 0=hue mode only, 1=rainbow mode
    color: LED_COLORS.RED,
  },
  winlock: 0, // 0=off, 1=on
  showImage: 0, // 0=time, 1=image1, 2=image2
  image1Frames: 0, // Number of frames in image 1
  image2Frames: 0, // Number of frames in image 2
};

/**
 * Validates configuration values
 * @param {Object} config - Configuration object to validate
 * @throws {Error} If configuration values are invalid
 */
function validateConfig(config) {
  const ug = config.underglow;
  if (ug.brightness < 0 || ug.brightness > 9) {
    throw new Error("underglow.brightness must be 0-9");
  }
  if (ug.speed < 0 || ug.speed > 9) {
    throw new Error("underglow.speed must be 0-9");
  }
  if (ug.orientation !== 0 && ug.orientation !== 1) {
    throw new Error("underglow.orientation must be 0 or 1");
  }
  if (ug.rainbow !== 0 && ug.rainbow !== 1) {
    throw new Error("underglow.rainbow must be 0 or 1");
  }
  if (ug.hue.red < 0 || ug.hue.red > 255) {
    throw new Error("underglow.hue.red must be 0-255");
  }
  if (ug.hue.green < 0 || ug.hue.green > 255) {
    throw new Error("underglow.hue.green must be 0-255");
  }
  if (ug.hue.blue < 0 || ug.hue.blue > 255) {
    throw new Error("underglow.hue.blue must be 0-255");
  }

  const led = config.led;
  if (led.saturation < 0 || led.saturation > 9) {
    throw new Error("led.saturation must be 0-9");
  }
  if (led.rainbow !== 0 && led.rainbow !== 1) {
    throw new Error("led.rainbow must be 0 or 1");
  }

  if (config.winlock !== 0 && config.winlock !== 1) {
    throw new Error("winlock must be 0 or 1");
  }
  if (config.showImage < 0 || config.showImage > 2) {
    throw new Error("showImage must be 0, 1, or 2");
  }
}

/**
 * Builds the 64-byte configuration frame for the GMK87 keyboard
 * @param {Object} config - Configuration object (merged with defaults)
 * @returns {Buffer} 64-byte configuration data packet
 */
function buildConfigFrame(config) {
  const now = new Date();
  const data = Buffer.alloc(64);

  // Header
  data[0x00] = 0x04; // Report ID
  data[0x03] = 0x06; // Config command
  data[0x04] = 0x30; // Full configuration frame

  // Underglow configuration (0x09-0x10)
  data[0x09] = config.underglow.effect;
  data[0x0a] = config.underglow.brightness;
  data[0x0b] = config.underglow.speed;
  data[0x0c] = config.underglow.orientation;
  data[0x0d] = config.underglow.rainbow;
  data[0x0e] = config.underglow.hue.red;
  data[0x0f] = config.underglow.hue.green;
  data[0x10] = config.underglow.hue.blue;

  // Unknown/reserved bytes (0x11-0x1c)
  for (let i = 0x11; i <= 0x1c; i++) {
    data[i] = 0x00;
  }

  // Windows key lock (0x1d)
  data[0x1d] = config.winlock;

  // Unknown/reserved bytes (0x1e-0x23)
  for (let i = 0x1e; i <= 0x23; i++) {
    data[i] = 0x00;
  }

  // Big LED configuration (0x24-0x28)
  data[0x24] = config.led.mode;
  data[0x25] = config.led.saturation;
  data[0x26] = 0x00; // Unknown
  data[0x27] = config.led.rainbow;
  data[0x28] = config.led.color;

  // Image display selection (0x29)
  data[0x29] = config.showImage;

  // Image frame counts (0x2a, 0x36)
  data[0x2a] = config.image1Frames;
  data[0x36] = config.image2Frames;

  // Time and date (0x2b-0x31)
  data[0x2b] = toHexNum(now.getSeconds());
  data[0x2c] = toHexNum(now.getMinutes());
  data[0x2d] = toHexNum(now.getHours());
  data[0x2e] = toHexNum(now.getDay()); // 0=Sunday
  data[0x2f] = toHexNum(now.getDate());
  data[0x30] = toHexNum(now.getMonth() + 1); // Month is 0-indexed
  data[0x31] = toHexNum(now.getFullYear() % 100);

  // Calculate and set checksum (bytes 0x01-0x02)
  const checksumData = data.slice(3);
  const chk = checksum(checksumData);
  data[0x01] = chk & 0xff; // LSB
  data[0x02] = (chk >> 8) & 0xff; // MSB

  return data;
}

/**
 * Sends configuration to the GMK87 keyboard
 * @param {Object} userConfig - User-provided configuration (partial or complete)
 * @returns {Promise<void>}
 * @throws {Error} If device not found or communication fails
 */
export async function configureLights(userConfig = {}) {
  // Merge user config with defaults
  const config = {
    underglow: {
      ...DEFAULT_CONFIG.underglow,
      ...(userConfig.underglow || {}),
      hue: {
        ...DEFAULT_CONFIG.underglow.hue,
        ...(userConfig.underglow?.hue || {}),
      },
    },
    led: {
      ...DEFAULT_CONFIG.led,
      ...(userConfig.led || {}),
    },
    winlock: userConfig.winlock ?? DEFAULT_CONFIG.winlock,
    showImage: userConfig.showImage ?? DEFAULT_CONFIG.showImage,
    image1Frames: userConfig.image1Frames ?? DEFAULT_CONFIG.image1Frames,
    image2Frames: userConfig.image2Frames ?? DEFAULT_CONFIG.image2Frames,
  };

  // Validate configuration
  validateConfig(config);

  // Find device with correct usage ID
  const devices = HID.devices(GMK87_VENDOR_ID, GMK87_PRODUCT_ID);
  const configDevice = devices.find((d) => d.usage === GMK87_USAGE_CONFIG);

  if (!configDevice) {
    throw new Error(
      `GMK87 keyboard not found (config interface, usage=${GMK87_USAGE_CONFIG})`
    );
  }

  console.log("Opening GMK87 keyboard for configuration...");
  const device = new HID.HID(configDevice.path);

  try {
    const frame = buildConfigFrame(config);
    console.log("Sending configuration frame...");
    
    // Write directly
    device.write([...frame]);
    
    console.log("Configuration sent successfully!");
    
    // Give the device time to process
    await delay(100);
  } finally {
    device.close();
  }
}

/**
 * Parses command-line arguments
 * @param {string[]} argv - Process arguments
 * @returns {Object} Parsed configuration object
 */
function parseCliArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;

    const eqIndex = arg.indexOf("=");
    let key, value;

    if (eqIndex !== -1) {
      key = arg.slice(2, eqIndex);
      value = arg.slice(eqIndex + 1);
    } else {
      key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        value = next;
        i++;
      } else {
        value = "true";
      }
    }

    args[key] = value;
  }
  return args;
}

/**
 * Converts CLI args to config object
 * @param {Object} args - Parsed CLI arguments
 * @returns {Object} Configuration object
 */
function argsToConfig(args) {
  const config = {};

  // Underglow configuration
  if (args.effect !== undefined) {
    config.underglow = config.underglow || {};
    const effectValue = parseInt(args.effect);
    if (!isNaN(effectValue)) {
      config.underglow.effect = effectValue;
    } else {
      // Try to match by name
      const effectName = args.effect.toUpperCase().replace(/-/g, "_");
      if (UNDERGLOW_EFFECTS[effectName] !== undefined) {
        config.underglow.effect = UNDERGLOW_EFFECTS[effectName];
      }
    }
  }

  if (args.brightness !== undefined) {
    config.underglow = config.underglow || {};
    config.underglow.brightness = parseInt(args.brightness);
  }

  if (args.speed !== undefined) {
    config.underglow = config.underglow || {};
    config.underglow.speed = parseInt(args.speed);
  }

  if (args.orientation !== undefined) {
    config.underglow = config.underglow || {};
    config.underglow.orientation = parseInt(args.orientation);
  }

  if (args.rainbow !== undefined) {
    config.underglow = config.underglow || {};
    config.underglow.rainbow = args.rainbow === "true" || args.rainbow === "1" ? 1 : 0;
  }

  if (args.red !== undefined || args.green !== undefined || args.blue !== undefined) {
    config.underglow = config.underglow || {};
    config.underglow.hue = {};
    if (args.red !== undefined) config.underglow.hue.red = parseInt(args.red);
    if (args.green !== undefined) config.underglow.hue.green = parseInt(args.green);
    if (args.blue !== undefined) config.underglow.hue.blue = parseInt(args.blue);
  }

  // LED configuration
  if (args["led-mode"] !== undefined) {
    config.led = config.led || {};
    const modeValue = parseInt(args["led-mode"]);
    if (!isNaN(modeValue)) {
      config.led.mode = modeValue;
    }
  }

  if (args["led-saturation"] !== undefined) {
    config.led = config.led || {};
    config.led.saturation = parseInt(args["led-saturation"]);
  }

  if (args["led-rainbow"] !== undefined) {
    config.led = config.led || {};
    config.led.rainbow = args["led-rainbow"] === "true" || args["led-rainbow"] === "1" ? 1 : 0;
  }

  if (args["led-color"] !== undefined) {
    config.led = config.led || {};
    const colorValue = parseInt(args["led-color"]);
    if (!isNaN(colorValue)) {
      config.led.color = colorValue;
    } else {
      // Try to match by name
      const colorName = args["led-color"].toUpperCase();
      if (LED_COLORS[colorName] !== undefined) {
        config.led.color = LED_COLORS[colorName];
      }
    }
  }

  // Other settings
  if (args.winlock !== undefined) {
    config.winlock = args.winlock === "true" || args.winlock === "1" ? 1 : 0;
  }

  if (args["show-image"] !== undefined) {
    config.showImage = parseInt(args["show-image"]);
  }

  return config;
}

/**
 * CLI entry point
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseCliArgs(process.argv);

  if (args.help || args.h) {
    console.log(`
GMK87 Lighting Configuration Tool

Usage: node configureLights.js [options]

Underglow Options:
  --effect <name|number>      Underglow effect (see effects below)
  --brightness <0-9>          Brightness (0=off, 9=max)
  --speed <0-9>               Speed (0=fast, 9=slow)
  --orientation <0|1>         Orientation (0=left-to-right, 1=right-to-left)
  --rainbow <true|false>      Rainbow mode
  --red <0-255>               Red component
  --green <0-255>             Green component
  --blue <0-255>              Blue component

LED Options:
  --led-mode <0-4>            LED mode (0=blinking, 3=fixed, etc.)
  --led-saturation <0-9>      LED saturation
  --led-rainbow <true|false>  LED rainbow mode
  --led-color <name|number>   LED color (RED, BLUE, etc.)

Other Options:
  --winlock <true|false>      Lock Windows key
  --show-image <0|1|2>        Display mode (0=time, 1=image1, 2=image2)

Available Effects:
  off, horizontal-dimming-wave, horizontal-pulse-wave, waterfall,
  full-cycling-colors, breathing, full-one-color, glow-pressed-key,
  glow-spreading, glow-row, random-pattern, rainbow-cycle,
  rainbow-waterfall, wave-from-center, circling-jk, raining,
  wave-left-right, slow-saturation-cycle, slow-rainbow-from-center

Available Colors:
  red, orange, yellow, green, teal, blue, purple, white, off

Examples:
  node configureLights.js --effect rainbow-cycle --brightness 5
  node configureLights.js --effect breathing --red 255 --green 0 --blue 0
  node configureLights.js --led-color blue --led-mode 3
    `);
    process.exit(0);
  }

  const config = argsToConfig(args);

  configureLights(config)
    .then(() => {
      console.log("Done!");
      process.exit(0);
    })
    .catch((err) => {
      console.error("Error:", err.message);
      process.exit(1);
    });
}