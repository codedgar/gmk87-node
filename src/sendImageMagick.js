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
 * Extracts all frames from an image (static or animated GIF) using ImageMagick
 * For GIFs, -coalesce handles disposal methods so each frame is a complete image
 * For static images (PNG/JPG), produces a single frame
 * @param {string} inPath - Path to input image file
 * @param {string} outDir - Directory to write frame BMP files into
 * @returns {string[]} Sorted array of output BMP file paths
 * @throws {Error} If ImageMagick is not found or extraction fails
 */
function magickExtractFrames(inPath, outDir) {
  const outPattern = path.join(outDir, "frame_%04d.bmp");
  const common = [
    inPath,
    "-coalesce",
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
    `bmp3:${outPattern}`,
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
      const files = fs.readdirSync(outDir)
        .filter((f) => f.startsWith("frame_") && f.endsWith(".bmp"))
        .sort()
        .map((f) => path.join(outDir, f));
      return files;
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
 * Processes an image file (static or GIF) and uploads it to the GMK87 device
 * Extracts frames using ImageMagick, then uploads all frames
 * Uses temp directories for extracted frames which are automatically cleaned up
 * @param {string} imagePath - Path to the source image file
 * @param {number} [imageIndex=0] - Target slot on device (0 or 1)
 * @param {Object} [options={}] - Upload options
 * @param {boolean} [options.showAfter=true] - Whether to display the image after upload
 * @param {string} [options.slot0File] - Path to slot 0 image file
 * @param {string} [options.slot1File] - Path to slot 1 image file
 * @param {number} [options.frameDuration] - Animation delay in ms (min 60, default 100 for GIFs)
 * @returns {Promise<void>} Resolves when upload is complete
 * @throws {Error} If image file doesn't exist, slot is invalid, or upload fails
 */
export async function processAndSend(
  imagePath,
  imageIndex = 0,
  { showAfter = true, slot0File, slot1File, frameDuration } = {}
) {
  const tmpDirs = [];

  function extractFrames(inputPath) {
    if (!inputPath) return null;
    if (!fs.existsSync(inputPath))
      throw new Error(`Input file not found: ${inputPath}`);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmk87-frames-"));
    tmpDirs.push(tmpDir);
    console.log(`Extracting frames from ${path.basename(inputPath)} with ImageMagick...`);
    const framePaths = magickExtractFrames(inputPath, tmpDir);
    console.log(`  ${framePaths.length} frame(s) extracted`);
    return framePaths;
  }

  try {
    const src0 = slot0File || (imageIndex === 0 ? imagePath : null);
    const src1 = slot1File || (imageIndex === 1 ? imagePath : null);
    let frames0 = extractFrames(src0);
    let frames1 = extractFrames(src1);

    // Auto-truncate if total frames exceed the hardware limit
    // Protocol allows 90, but flash storage on tested hardware caps at 36 total frames
    const MAX_TOTAL_FRAMES = 36;
    const count0 = frames0 ? frames0.length : 1; // null slot = 1 blank frame
    const count1 = frames1 ? frames1.length : 1;
    if (count0 + count1 > MAX_TOTAL_FRAMES) {
      const budget0 = frames0 ? MAX_TOTAL_FRAMES - (frames1 ? frames1.length : 1) : count0;
      const budget1 = frames1 ? MAX_TOTAL_FRAMES - (frames0 ? Math.min(frames0.length, budget0) : 1) : count1;
      if (frames0 && frames0.length > budget0) {
        console.log(`  Truncating slot 0 from ${frames0.length} to ${budget0} frames (36-frame hardware limit)`);
        frames0 = frames0.slice(0, Math.max(1, budget0));
      }
      if (frames1 && frames1.length > budget1) {
        console.log(`  Truncating slot 1 from ${frames1.length} to ${budget1} frames (36-frame hardware limit)`);
        frames1 = frames1.slice(0, Math.max(1, budget1));
      }
    }

    // Auto-set frameDuration for GIFs if not explicitly provided
    const totalFrames = (frames0 ? frames0.length : 0) + (frames1 ? frames1.length : 0);
    const isAnimated = totalFrames > 2; // more than 1 frame per slot
    if (frameDuration === undefined && isAnimated) {
      frameDuration = 100; // default 100ms for animations (matches Python DEFAULT_ANIMATION_DELAY_MS)
      console.log(`  Using default animation delay: ${frameDuration}ms`);
    }

    await uploadImageToDevice(imagePath, imageIndex, {
      showAfter,
      slot0Paths: frames0,
      slot1Paths: frames1,
      frameDuration,
    });
  } finally {
    for (const dir of tmpDirs) {
      try { fs.rmSync(dir, { recursive: true }); } catch {}
    }
  }
}

// -------------------------------------------------------
// CLI Entry Point
// -------------------------------------------------------

/**
 * Main entry point when script is run directly from command line
 * Usage:
 *   node sendImageMagick.js --slot0 <path> --slot1 <path> [--ms <delay>] [--show <0|1|2>]
 *   node sendImageMagick.js --file <path> --slot <0|1> [--ms <delay>] [--show=true|false]
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv);

  // Parse --ms flag for animation delay
  const frameDuration = args.ms !== undefined ? Math.max(60, Number(args.ms)) : undefined;
  if (args.ms !== undefined && Number.isNaN(Number(args.ms))) {
    console.error("--ms must be a number (milliseconds between frames, min 60)");
    process.exit(1);
  }

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
      frameDuration,
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
        "Usage:\n" +
        "  node src/sendImageMagick.js --slot0 <path> --slot1 <path> [--ms <delay>]\n" +
        "  node src/sendImageMagick.js --file <path> --slot <0|1> [--ms <delay>]\n" +
        "\n" +
        "Options:\n" +
        "  --ms <number>  Animation delay in milliseconds (min 60, default 100 for GIFs)"
      );
      process.exit(1);
    }

    processAndSend(file, slot, { showAfter: show, frameDuration }).catch((err) => {
      console.error(err);
      process.exit(1);
    });
  }
}