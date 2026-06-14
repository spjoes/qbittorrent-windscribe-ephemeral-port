import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

// Set to true to save debug images and logs
const DEBUG_CAPTCHA = process.env.DEBUG_CAPTCHA === 'true';

// Debug context for collecting log messages
interface DebugContext {
  timestamp: number;
  logs: string[];
}

let debugContext: DebugContext | null = null;

function debugLog(message: string): void {
  console.log(message);
  if (debugContext) {
    debugContext.logs.push(message);
  }
}

function saveDebugLogs(): void {
  if (debugContext && DEBUG_CAPTCHA) {
    const debugDir = path.join(process.cwd(), 'captcha_debug');
    const logPath = path.join(debugDir, `${debugContext.timestamp}_debug.txt`);
    const content = [
      `CAPTCHA Debug Log`,
      `Timestamp: ${new Date(debugContext.timestamp).toISOString()}`,
      ``,
      ...debugContext.logs
    ].join('\n');
    fs.writeFileSync(logPath, content);
    console.log(`Debug log saved to ${logPath}`);
  }
}

interface CaptchaData {
  background: string; // base64 encoded PNG
  slider?: string; // base64 encoded PNG (puzzle piece) - may not be present
  top: number; // vertical position of the piece
}

interface CaptchaSolution {
  offset: number;
  trail: {
    x: number[];
    y: number[];
  };
}

/**
 * Solves Windscribe's slider CAPTCHA by finding where the puzzle piece fits
 * in the background image using edge-based template matching.
 * @param {CaptchaData} captchaData - The CAPTCHA data containing background, slider, and top offset
 * @return {Promise<CaptchaSolution>} The solution containing offset and mouse trail
 */
export async function solveCaptcha(captchaData: CaptchaData): Promise<CaptchaSolution> {
  // Initialize debug context
  const timestamp = Date.now();
  if (DEBUG_CAPTCHA) {
    debugContext = {timestamp, logs: []};
  }

  try {
    // Decode base64 background image
    const bgBuffer = Buffer.from(
      captchaData.background.replace(/^data:image\/\w+;base64,/, ''),
      'base64'
    );

    let offset: number;
    const bgMeta = await sharp(bgBuffer).metadata();

    if (captchaData.slider && captchaData.slider !== captchaData.background) {
      // If we have a separate slider image, use template matching
      const sliderBuffer = Buffer.from(
        captchaData.slider.replace(/^data:image\/\w+;base64,/, ''),
        'base64'
      );

      // Save debug images if enabled
      if (DEBUG_CAPTCHA) {
        const debugDir = path.join(process.cwd(), 'captcha_debug');
        if (!fs.existsSync(debugDir)) {
          fs.mkdirSync(debugDir, {recursive: true});
        }
        fs.writeFileSync(path.join(debugDir, `${timestamp}_background.png`), bgBuffer);
        fs.writeFileSync(path.join(debugDir, `${timestamp}_slider.png`), sliderBuffer);
        debugLog(`Debug images saved to ${debugDir}/${timestamp}_*.png`);
        debugLog(`CAPTCHA top offset: ${captchaData.top}`);
      }

      offset = await findSliderOffsetWithTemplate(bgBuffer, sliderBuffer, captchaData.top);
    } else {
      // No separate slider - find the shadow/cutout in the background
      if (DEBUG_CAPTCHA) {
        debugLog(`No separate slider image, using cutout detection`);
        debugLog(`CAPTCHA top offset: ${captchaData.top}`);
      }
      offset = await findCutoutPosition(bgBuffer, captchaData.top);
    }

    const desktopCaptchaWidth = 274;
    const desktopRunnerDiameter = 32;
    const maxDesktopOffset = Math.floor(((desktopCaptchaWidth - desktopRunnerDiameter) * (bgMeta.width ?? desktopCaptchaWidth)) / desktopCaptchaWidth);
    offset = Math.max(0, Math.min(offset, maxDesktopOffset));

    // Generate human-like mouse trail
    const trail = generateMouseTrail(offset, bgMeta.width ?? desktopCaptchaWidth, bgMeta.height ?? 154);

    if (DEBUG_CAPTCHA) {
      debugLog(`Final solution: offset=${offset}`);
      debugLog(`Mouse trail length: ${trail.x.length} points`);
    }

    return {offset, trail};
  } finally {
    // Always save debug logs at the end
    saveDebugLogs();
    debugContext = null;
  }
}

/**
 * Find the horizontal offset where the slider piece fits in the background
 * using multiple detection strategies.
 * @param {Buffer} bgBuffer - The background image buffer
 * @param {Buffer} sliderBuffer - The slider piece image buffer
 * @param {number} topOffset - The vertical position of the target
 * @return {Promise<number>} The horizontal offset where the piece fits
 */
async function findSliderOffsetWithTemplate(
  bgBuffer: Buffer,
  sliderBuffer: Buffer,
  topOffset: number
): Promise<number> {
  const bgImage = sharp(bgBuffer);
  const sliderImage = sharp(sliderBuffer);

  const bgMeta = await bgImage.metadata();
  const sliderMeta = await sliderImage.metadata();

  // Get background as grayscale
  const bgGray = await bgImage
    .greyscale()
    .raw()
    .toBuffer({resolveWithObject: true});

  // Get slider with alpha channel to find the puzzle piece shape
  const sliderRGBA = await sliderImage
    .ensureAlpha()
    .raw()
    .toBuffer({resolveWithObject: true});

  const bgWidth = bgMeta.width!;
  const bgHeight = bgMeta.height!;
  const sliderWidth = sliderMeta.width!;
  const sliderHeight = sliderMeta.height!;

  // Find where the white outline target matches the puzzle piece edges
  const targetOffset = findTargetOutline(
    bgGray.data,
    bgWidth,
    bgHeight,
    sliderRGBA.data,
    sliderWidth,
    sliderHeight,
    topOffset
  );

  if (DEBUG_CAPTCHA) {
    debugLog(`Target outline detection offset: ${targetOffset}`);
  }

  return targetOffset;
}

/**
 * Find the white outlined target region in the background that matches the puzzle piece.
 * The target is marked with a thin white border outline.
 *
 * Strategy: Find the left edge of the white rectangular outline by looking for
 * vertical lines of bright pixels, then verify by checking for a complete rectangle.
 * @param {Buffer} bgPixels - The background image pixel data
 * @param {number} bgWidth - Background image width
 * @param {number} bgHeight - Background image height
 * @param {Buffer} sliderRGBA - The slider piece RGBA pixel data
 * @param {number} sliderWidth - Slider image width
 * @param {number} sliderHeight - Slider image height
 * @param {number} topOffset - The vertical position of the target
 * @return {number} The horizontal offset where the piece fits
 */
function findTargetOutline(
  bgPixels: Buffer,
  bgWidth: number,
  bgHeight: number,
  sliderRGBA: Buffer,
  sliderWidth: number,
  sliderHeight: number,
  topOffset: number
): number {
  // First pass: find the bounding box of the puzzle piece using alpha channel
  let minX = sliderWidth; let maxX = 0; let minY = sliderHeight; let maxY = 0;

  for (let y = 0; y < sliderHeight; y++) {
    for (let x = 0; x < sliderWidth; x++) {
      const idx = (y * sliderWidth + x) * 4;
      const alpha = sliderRGBA[idx + 3];
      if (alpha > 128) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }

  const pieceWidth = maxX - minX + 1;
  const pieceHeight = maxY - minY + 1;

  if (DEBUG_CAPTCHA) {
    debugLog(`Puzzle piece bounds: x=${minX}-${maxX}, y=${minY}-${maxY}, size=${pieceWidth}x${pieceHeight}`);
    debugLog(`topOffset from CAPTCHA data: ${topOffset}`);
    debugLog(`Background size: ${bgWidth}x${bgHeight}`);
  }

  const searchStartX = Math.floor(bgWidth * 0.35);
  const searchEndX = Math.floor(bgWidth * 0.95);

  // Expected vertical span of the target outline
  const expectedTop = topOffset;
  const expectedBottom = Math.min(bgHeight - 1, topOffset + pieceHeight);
  const expectedHeight = expectedBottom - expectedTop;

  if (DEBUG_CAPTCHA) {
    debugLog(`Searching for outline in x=${searchStartX}-${searchEndX}, y=${expectedTop}-${expectedBottom}`);
  }

  const columnScores: { x: number; score: number; brightPixels: number }[] = [];

  for (let x = Math.max(1, searchStartX); x < Math.min(bgWidth - 1, searchEndX); x++) {
    let edgePixelCount = 0;
    let edgeStrength = 0;

    for (let y = expectedTop; y <= expectedBottom; y++) {
      if (y >= 0 && y < bgHeight) {
        const pixelIndex = y * bgWidth + x;
        const gradient
          = Math.abs(bgPixels[pixelIndex] - bgPixels[pixelIndex - 1])
          + Math.abs(bgPixels[pixelIndex] - bgPixels[pixelIndex + 1]);

        if (gradient > 20) {
          edgePixelCount++;
          edgeStrength += gradient;
        }
      }
    }

    columnScores.push({x, score: edgeStrength, brightPixels: edgePixelCount});
  }

  const maxColumnScore = Math.max(...columnScores.map(c => c.score), 0);
  const significantColumns = columnScores
    .filter(c => c.score > maxColumnScore * 0.35 && c.brightPixels > expectedHeight * 0.1)
    .sort((a, b) => a.x - b.x);

  if (DEBUG_CAPTCHA) {
    debugLog(`Top 10 gradient columns: ${JSON.stringify([...columnScores].sort((a, b) => b.score - a.score).slice(0, 10))}`);
  }

  const clusters: {left: number, right: number, score: number}[] = [];
  for (const column of significantColumns) {
    const current = clusters[clusters.length - 1];
    if (current && column.x - current.right <= 4) {
      current.right = column.x;
      current.score += column.score;
    } else {
      clusters.push({left: column.x, right: column.x, score: column.score});
    }
  }

  if (DEBUG_CAPTCHA) {
    debugLog(`Gradient clusters: ${JSON.stringify(clusters.sort((a, b) => b.score - a.score).slice(0, 8))}`);
  }

  let bestLeftEdge = Math.floor(bgWidth * 0.5);
  if (clusters.length > 0) {
    const strongestScore = Math.max(...clusters.map(cluster => cluster.score));
    const candidate = clusters
      .filter(cluster => cluster.score >= strongestScore * 0.5)
      .sort((a, b) => a.left - b.left)[0];
    bestLeftEdge = candidate.left;

    if (DEBUG_CAPTCHA) {
      debugLog(`Best gradient cluster: left=${candidate.left}, right=${candidate.right}, score=${candidate.score}`);
    }
  }

  // Verify with horizontal edge detection
  let topEdgeBonus = 0;
  for (let dx = 0; dx < Math.min(pieceWidth, 50); dx++) {
    const checkX = bestLeftEdge + dx;
    if (checkX < bgWidth && expectedTop >= 0 && expectedTop < bgHeight) {
      const brightness = bgPixels[expectedTop * bgWidth + checkX];
      if (brightness > 150) {
        topEdgeBonus++;
      }
    }
  }

  let bottomEdgeBonus = 0;
  for (let dx = 0; dx < Math.min(pieceWidth, 50); dx++) {
    const checkX = bestLeftEdge + dx;
    if (checkX < bgWidth && expectedBottom >= 0 && expectedBottom < bgHeight) {
      const brightness = bgPixels[expectedBottom * bgWidth + checkX];
      if (brightness > 150) {
        bottomEdgeBonus++;
      }
    }
  }

  if (DEBUG_CAPTCHA) {
    debugLog(`Best left edge x=${bestLeftEdge}: topEdgeBonus=${topEdgeBonus}, bottomEdgeBonus=${bottomEdgeBonus}`);
  }

  // The drag offset is from the slider's starting position to align with the target
  // The slider piece content starts at minX within the slider image
  // So we need to drag by: (target left edge) - minX
  const dragOffset = bestLeftEdge - minX;

  if (DEBUG_CAPTCHA) {
    debugLog(`Final drag offset: ${bestLeftEdge} - ${minX} = ${dragOffset}`);
  }

  return dragOffset;
}

/**
 * Find the cutout/shadow position in the background image.
 * This is used when there's no separate slider image - we look for
 * a darker rectangular region (the shadow) or sharp edge discontinuity.
 * @param {Buffer} bgBuffer - The background image buffer
 * @param {number} topOffset - The vertical position hint
 * @return {Promise<number>} The horizontal position of the cutout
 */
async function findCutoutPosition(
  bgBuffer: Buffer,
  topOffset: number
): Promise<number> {
  const bgImage = sharp(bgBuffer);
  const bgMeta = await bgImage.metadata();
  const width = bgMeta.width!;
  const height = bgMeta.height!;

  // Get raw RGBA pixel data
  const {data} = await bgImage
    .ensureAlpha()
    .raw()
    .toBuffer({resolveWithObject: true});

  // Look for areas with strong vertical edges (the cutout boundaries)
  // We search in a horizontal band around the topOffset position
  const searchStartY = Math.max(0, topOffset - 10);
  const searchEndY = Math.min(height, topOffset + 70); // Puzzle piece is typically ~60px tall

  // Calculate vertical edge strength at each x position
  const edgeStrength: number[] = new Array(width).fill(0);

  for (let y = searchStartY; y < searchEndY; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = (y * width + x) * 4;
      const idxLeft = (y * width + (x - 1)) * 4;
      const idxRight = (y * width + (x + 1)) * 4;

      // Calculate brightness
      const brightness = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
      const brightnessLeft = (data[idxLeft] + data[idxLeft + 1] + data[idxLeft + 2]) / 3;
      const brightnessRight = (data[idxRight] + data[idxRight + 1] + data[idxRight + 2]) / 3;

      // Edge detection: look for sudden brightness changes
      const edgeL = Math.abs(brightness - brightnessLeft);
      const edgeR = Math.abs(brightness - brightnessRight);

      edgeStrength[x] += edgeL + edgeR;
    }
  }

  // Find the position with maximum edge strength in the valid range
  // The cutout is typically on the right side (puzzle piece starts from left)
  let maxStrength = 0;
  let bestX = Math.floor(width * 0.5); // Default to middle

  // Search from 30% to 90% of width (cutout is usually not at edges)
  const searchStartX = Math.floor(width * 0.3);
  const searchEndX = Math.floor(width * 0.9);

  for (let x = searchStartX; x < searchEndX; x++) {
    // Look for a pattern: low-high-low edge strength indicating cutout boundaries
    const windowStrength = edgeStrength[x] + edgeStrength[x + 1] + edgeStrength[x + 2];
    if (windowStrength > maxStrength) {
      maxStrength = windowStrength;
      bestX = x;
    }
  }

  // The piece needs to slide TO this position, so this is our offset
  if (DEBUG_CAPTCHA) {
    debugLog(`Cutout detection: found position at x=${bestX}`);
  }
  return bestX;
}

/**
 * Generate a human-like mouse trail from 0 to the target offset.
 * Simulates natural mouse movement with slight variations.
 * @param {number} targetOffset - The target horizontal offset
 * @return {{x: number[], y: number[]}} Arrays of x and y coordinates
 */
function generateMouseTrail(targetOffset: number, backgroundWidth: number, backgroundHeight: number): {x: number[]; y: number[]} {
  const x: number[] = [];
  const y: number[] = [];

  const maxTrailSize = 50;
  const runnerRadius = 16;
  const sliderY = backgroundHeight + 24;
  const startX = runnerRadius;
  const maxRunnerLeft = 274 - 2 * runnerRadius;
  const scaledTargetOffset = Math.round((targetOffset * 274) / backgroundWidth);
  const boundedTargetOffset = Math.max(0, Math.min(scaledTargetOffset, maxRunnerLeft));
  const numPoints = Math.min(maxTrailSize, Math.max(10, Math.floor(boundedTargetOffset / 6)));

  let currentX = startX;
  let currentY = sliderY;

  for (let i = 0; i < numPoints; i++) {
    // Progress from 0 to 1
    const progress = (i + 1) / numPoints;

    // Ease-out curve for natural deceleration
    const easeProgress = 1 - Math.pow(1 - progress, 2);

    // Target position with some overshoot near the end
    const targetX = Math.round(startX + boundedTargetOffset * easeProgress);

    // Add some random jitter (humans aren't perfectly smooth)
    const jitterX = Math.round((Math.random() - 0.5) * 2);
    const jitterY = Math.round((Math.random() - 0.5) * 4);

    currentX = Math.max(startX, Math.min(startX + boundedTargetOffset, targetX + jitterX));
    currentY = sliderY + jitterY;

    x.push(currentX);
    y.push(currentY);
  }

  // Ensure final position is at target
  x[x.length - 1] = startX + boundedTargetOffset;
  y[y.length - 1] = sliderY;

  return {x, y};
}
