/**
 * @fileoverview Image upload utility with built-in preprocessing
 * Converts images to the correct format (240x135) before uploading to GMK87 device
 * Uses jimp for static images and omggif for GIF frame extraction
 * Supports command-line usage with flexible argument parsing
 */

import os from "os";
import path from "path";
import fs from "fs";
import Jimp from "jimp";
import { GifReader } from "omggif";
import { uploadImageToDevice } from "./lib/device.js";

const DISPLAY_WIDTH = 240;
const DISPLAY_HEIGHT = 135;

/**
 * Parses command-line arguments into a key-value object
 * Supports both --key=value and --key value formats
 * @param {string[]} argv - Process argument array (typically process.argv)
 * @returns {Object<string, string|boolean>} Parsed arguments as key-value pairs
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
 * Extracts all frames from a GIF using omggif with proper frame compositing
 * Handles disposal methods (keep, restore to background, restore to previous)
 * so each output frame is a fully rendered image — equivalent to ImageMagick's -coalesce
 * @param {string} inPath - Path to GIF file
 * @param {string} outDir - Directory to write frame PNG files into
 * @returns {Promise<string[]>} Sorted array of output file paths
 */
async function extractGifFrames(inPath, outDir) {
  const buf = fs.readFileSync(inPath);
  const reader = new GifReader(buf);
  const { width, height } = reader;
  const frameCount = reader.numFrames();

  // Canvas holds the composited state (RGBA)
  const canvas = Buffer.alloc(width * height * 4, 0);
  const framePaths = [];

  for (let i = 0; i < frameCount; i++) {
    const info = reader.frameInfo(i);

    // Save canvas state before this frame (for disposal method 3 = restore to previous)
    const previousCanvas = Buffer.from(canvas);

    // Decode frame RGBA into a temp buffer
    const framePixels = Buffer.alloc(width * height * 4, 0);
    reader.decodeAndBlitFrameRGBA(i, framePixels);

    // Composite frame onto canvas (respecting transparency)
    const fx = info.x || 0;
    const fy = info.y || 0;
    const fw = info.width;
    const fh = info.height;
    for (let y = fy; y < fy + fh && y < height; y++) {
      for (let x = fx; x < fx + fw && x < width; x++) {
        const srcIdx = (y * width + x) * 4;
        const alpha = framePixels[srcIdx + 3];
        if (alpha > 0) {
          canvas[srcIdx] = framePixels[srcIdx];
          canvas[srcIdx + 1] = framePixels[srcIdx + 1];
          canvas[srcIdx + 2] = framePixels[srcIdx + 2];
          canvas[srcIdx + 3] = 255;
        }
      }
    }

    // Create jimp image from composited canvas, resize, and save
    const img = new Jimp(width, height);
    img.bitmap.data = Buffer.from(canvas);
    img.resize(DISPLAY_WIDTH, DISPLAY_HEIGHT);
    const outPath = path.join(outDir, `frame_${String(i).padStart(4, "0")}.png`);
    await img.writeAsync(outPath);
    framePaths.push(outPath);

    // Handle disposal method
    const disposal = info.disposal || 0;
    if (disposal === 2) {
      // Restore to background: clear the frame area
      for (let y = fy; y < fy + fh && y < height; y++) {
        for (let x = fx; x < fx + fw && x < width; x++) {
          const idx = (y * width + x) * 4;
          canvas[idx] = 0;
          canvas[idx + 1] = 0;
          canvas[idx + 2] = 0;
          canvas[idx + 3] = 0;
        }
      }
    } else if (disposal === 3) {
      // Restore to previous: revert canvas
      previousCanvas.copy(canvas);
    }
    // disposal 0 or 1: leave canvas as-is
  }

  return framePaths;
}

/**
 * Extracts frames from an image file (static or animated GIF)
 * Static images (PNG/JPG/BMP) produce a single frame
 * GIFs produce one frame per animation frame with proper compositing
 * @param {string} inPath - Path to input image file
 * @param {string} outDir - Directory to write frame files into
 * @returns {Promise<string[]>} Array of output file paths
 */
async function extractFramesFromFile(inPath, outDir) {
  const ext = path.extname(inPath).toLowerCase();

  if (ext === ".gif") {
    return extractGifFrames(inPath, outDir);
  }

  // Static image: resize with jimp and save
  const img = await Jimp.read(inPath);
  img.resize(DISPLAY_WIDTH, DISPLAY_HEIGHT);
  const outPath = path.join(outDir, "frame_0000.png");
  await img.writeAsync(outPath);
  return [outPath];
}

/**
 * Processes an image file (static or GIF) and uploads it to the GMK87 device
 * Extracts frames using jimp/omggif, then uploads all frames
 * @param {string} imagePath - Path to the source image file
 * @param {number} [imageIndex=0] - Target slot on device (0 or 1)
 * @param {Object} [options={}] - Upload options
 * @param {boolean} [options.showAfter=true] - Whether to display the image after upload
 * @param {string} [options.slot0File] - Path to slot 0 image file
 * @param {string} [options.slot1File] - Path to slot 1 image file
 * @param {number} [options.frameDuration] - Animation delay in ms (min 60, default 100 for GIFs)
 * @returns {Promise<void>} Resolves when upload is complete
 */
export async function processAndSend(
  imagePath,
  imageIndex = 0,
  { showAfter = true, slot0File, slot1File, frameDuration } = {}
) {
  const tmpDirs = [];

  async function extractFrames(inputPath) {
    if (!inputPath) return null;
    if (!fs.existsSync(inputPath))
      throw new Error(`Input file not found: ${inputPath}`);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmk87-frames-"));
    tmpDirs.push(tmpDir);
    console.log(`Processing ${path.basename(inputPath)}...`);
    const framePaths = await extractFramesFromFile(inputPath, tmpDir);
    console.log(`  ${framePaths.length} frame(s) extracted`);
    return framePaths;
  }

  try {
    const src0 = slot0File || (imageIndex === 0 ? imagePath : null);
    const src1 = slot1File || (imageIndex === 1 ? imagePath : null);
    let frames0 = await extractFrames(src0);
    let frames1 = await extractFrames(src1);

    // Auto-truncate if total frames exceed the hardware limit
    // Protocol allows 90, but flash storage on tested hardware caps at 36 total frames
    const MAX_TOTAL_FRAMES = 36;
    const count0 = frames0 ? frames0.length : 1; // null slot = 1 blank frame
    const count1 = frames1 ? frames1.length : 1;
    if (count0 + count1 > MAX_TOTAL_FRAMES) {
      const half = Math.floor(MAX_TOTAL_FRAMES / 2);
      const target0 = frames0 ? Math.min(frames0.length, half) : 1;
      const target1 = frames1 ? Math.min(frames1.length, MAX_TOTAL_FRAMES - target0) : 1;
      if (frames0 && frames0.length > target0) {
        console.log(`  Truncating slot 0 from ${frames0.length} to ${target0} frames (36-frame hardware limit)`);
        frames0 = frames0.slice(0, target0);
      }
      if (frames1 && frames1.length > target1) {
        console.log(`  Truncating slot 1 from ${frames1.length} to ${target1} frames (36-frame hardware limit)`);
        frames1 = frames1.slice(0, target1);
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
