/**
 * @fileoverview Image upload utility using ImageMagick for preprocessing
 * Converts images to the correct format (240x135 BMP) before uploading to GMK87 device
 * Supports command-line usage with flexible argument parsing
 */

import { execFileSync } from "child_process";
import os from "os";
import path from "path";
import fs from "fs";
import { uploadImageToDevice } from "./lib/device.js";

/**
 * Parses command-line arguments into a key-value object
 * Supports both --key=value and --key value formats
 * @param {string[]} argv - Process argument array (typically process.argv)
 * @returns {Object<string, string|boolean>} Parsed arguments as key-value pairs
 * @example
 * parseArgs(['node', 'script.js', '--file=test.png', '--slot', '0'])
 * // Returns: { file: 'test.png', slot: '0' }
 */
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

/**
 * Converts an image to GMK87-compatible BMP format using ImageMagick
 * Tries multiple ImageMagick command variants for cross-platform compatibility
 * Output: 240x135px, 24-bit BMP3, black background, no alpha channel
 * @param {string} inPath - Path to input image file
 * @param {string} outPath - Path where converted BMP should be saved
 * @throws {Error} If ImageMagick is not found or conversion fails
 */
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

/**
 * Processes an image file and uploads it to the GMK87 device
 * Converts the image to the required format using ImageMagick, then uploads
 * Uses a temporary file for the converted image which is automatically cleaned up
 * @param {string} imagePath - Path to the source image file
 * @param {number} [imageIndex=0] - Target slot on device (0 or 1)
 * @param {Object} [options={}] - Upload options
 * @param {boolean} [options.showAfter=true] - Whether to display the image after upload
 * @returns {Promise<void>} Resolves when upload is complete
 * @throws {Error} If image file doesn't exist, slot is invalid, or upload fails
 */
export async function processAndSend(
  imagePath,
  imageIndex = 0,
  { showAfter = true, slot0File, slot1File } = {}
) {
  // Convert all provided images to BMP with ImageMagick
  const tmpFiles = [];

  function convertToTmp(inputPath) {
    if (!inputPath) return null;
    if (!fs.existsSync(inputPath))
      throw new Error(`Input file not found: ${inputPath}`);
    const tmp = path.join(
      os.tmpdir(),
      `gmk87-prepped-${Date.now()}-${Math.random().toString(36).slice(2)}.bmp`
    );
    console.log(`Converting ${path.basename(inputPath)} with ImageMagick...`);
    magickConvert(inputPath, tmp);
    tmpFiles.push(tmp);
    return tmp;
  }

  try {
    // If both slots provided, convert both
    const tmp0 = convertToTmp(slot0File || (imageIndex === 0 ? imagePath : null));
    const tmp1 = convertToTmp(slot1File || (imageIndex === 1 ? imagePath : null));

    await uploadImageToDevice(imagePath, imageIndex, {
      showAfter,
      slot0Path: tmp0,
      slot1Path: tmp1,
    });
  } finally {
    for (const tmp of tmpFiles) {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }
}

// -------------------------------------------------------
// CLI Entry Point
// -------------------------------------------------------

/**
 * Main entry point when script is run directly from command line
 * Usage:
 *   node sendImageMagick.js --slot0 <path> --slot1 <path> [--show <0|1|2>]
 *   node sendImageMagick.js --file <path> --slot <0|1> [--show=true|false]
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv);

  // Two-file mode: --slot0 <path> --slot1 <path>
  if (args.slot0 || args.slot1) {
    const show = Number(args.show ?? (args.slot1 ? 2 : 1));

    if (!args.slot0 && !args.slot1) {
      console.error("Provide at least one of --slot0 or --slot1");
      process.exit(1);
    }

    processAndSend(args.slot0 || args.slot1, args.slot0 ? 0 : 1, {
      showAfter: show > 0,
      slot0File: args.slot0,
      slot1File: args.slot1,
    }).catch((err) => {
      console.error(err);
      process.exit(1);
    });
  } else {
    // Single-file mode (backwards compatible): --file <path> --slot <0|1>
    const file = args.file || args.f;
    const slot = Number(args.slot ?? 0);
    const show =
      args.show === undefined ? true : String(args.show).toLowerCase() !== "false";

    if (!file || Number.isNaN(slot) || slot < 0 || slot > 1) {
      console.error(
        "Usage:\n  node src/sendImageMagick.js --slot0 <path> --slot1 <path>\n  node src/sendImageMagick.js --file <path> --slot <0|1>"
      );
      process.exit(1);
    }

    processAndSend(file, slot, { showAfter: show }).catch((err) => {
      console.error(err);
      process.exit(1);
    });
  }
}