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

export class GhostscriptConverter extends PdfConverter {
  readonly name = "ghostscript";

  async convert({
    inputPath,
    outputDir,
    outputPrefix,
    density,
    deadlineAt,
  }: PdfConversionOptions): Promise<string[]> {
    const pngPattern = path.join(outputDir, `${outputPrefix}_page_%03d.png`);

    await execFileAsync(
      "gs",
      [
        "-dSAFER",
        "-dBATCH",
        "-dNOPAUSE",
        "-dNOPROMPT",
        "-sDEVICE=png16m",
        `-r${density}`,
        "-o",
        pngPattern,
        inputPath,
      ],
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
