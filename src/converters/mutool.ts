/**
 * MuPDF/mutool converter.
 *
 * mutool is invoked as an external binary so this project does not need to
 * link against or distribute MuPDF library code, which would trigger the
 * AGPL license requirements that apply to static/dynamic linking.
 *
 * mutool renders PDF pages to PNG at the requested DPI, then ImageMagick
 * converts the PNGs to WebP for smaller Discord upload sizes.
 */

import path from "path";
import {
  CONVERT_TIMEOUT_MS,
  PdfConverter,
  clearGeneratedFiles,
  execFileAsync,
  getStepTimeoutMs,
  listGeneratedFiles,
  throwAppError,
} from "./types";
import type { PdfConversionOptions } from "./types";

export class MuToolConverter extends PdfConverter {
  readonly name = "mutool";

  async convert({
    inputPath,
    outputDir,
    outputPrefix,
    density,
    deadlineAt,
  }: PdfConversionOptions): Promise<string[]> {
    // mutool draw uses %03d-style pattern for page numbering
    const pngPattern = path.join(outputDir, `${outputPrefix}_page_%03d.png`);

    await execFileAsync(
      "mutool",
      ["draw", "-r", String(density), "-o", pngPattern, inputPath],
      { timeout: getStepTimeoutMs(deadlineAt, CONVERT_TIMEOUT_MS) },
    );

    const pngFiles = await listGeneratedFiles(outputDir, ".png");
    if (pngFiles.length === 0) throwAppError("UPLOAD_GENERATION_FAILED");

    for (const pngPath of pngFiles) {
      const webpPath = pngPath.replace(/\.png$/i, ".webp");
      await execFileAsync(
        "convert",
        ["-alpha", "remove", pngPath, webpPath],
        { timeout: getStepTimeoutMs(deadlineAt, CONVERT_TIMEOUT_MS) },
      );
    }

    await clearGeneratedFiles(outputDir, ".png");

    const results = await listGeneratedFiles(outputDir, ".webp");
    if (results.length === 0) throwAppError("UPLOAD_GENERATION_FAILED");
    return results;
  }
}
