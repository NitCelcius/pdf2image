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

const LOW_DENSITY = 100;
const MEDIUM_DENSITY = 200;
const BATCH_SIZE = 32;

const isResourceLimitError = (error: unknown): boolean => {
  const msg = `${error instanceof Error ? error.message : ""}\n${(error as { stderr?: unknown })?.stderr ?? ""}`;
  return /cache resources exhausted|TooManyExceptions|IDAT: Too much image data/i.test(
    msg,
  );
};

const getPdfPageCount = async (
  pdfPath: string,
  deadlineAt: number,
): Promise<number> => {
  const { stdout } = await execFileAsync(
    "identify",
    ["-ping", "-format", "%p\n", pdfPath],
    { timeout: getStepTimeoutMs(deadlineAt, CONVERT_TIMEOUT_MS) },
  );
  const count = String(stdout)
    .split("\n")
    .filter((l) => l.trim() !== "").length;
  return Math.max(count, 1);
};

export class ImageMagickConverter extends PdfConverter {
  readonly name = "imagemagick";

  async convert({
    inputPath,
    outputDir,
    outputPrefix,
    density,
    deadlineAt,
  }: PdfConversionOptions): Promise<string[]> {
    const outputPattern = path.join(outputDir, `${outputPrefix}_page_%03d.webp`);

    const runConvert = async (d: number): Promise<void> => {
      await execFileAsync(
        "convert",
        ["-density", String(d), "-alpha", "remove", inputPath, outputPattern],
        { timeout: getStepTimeoutMs(deadlineAt, CONVERT_TIMEOUT_MS) },
      );
    };

    const runBatchedConvert = async (d: number): Promise<void> => {
      const pageCount = await getPdfPageCount(inputPath, deadlineAt);
      for (let start = 0; start < pageCount; start += BATCH_SIZE) {
        const end = Math.min(start + BATCH_SIZE - 1, pageCount - 1);
        await execFileAsync(
          "convert",
          [
            "-density",
            String(d),
            "-alpha",
            "remove",
            `${inputPath}[${start}-${end}]`,
            "-scene",
            String(start),
            outputPattern,
          ],
          { timeout: getStepTimeoutMs(deadlineAt, CONVERT_TIMEOUT_MS) },
        );
      }
    };

    // First attempt at requested density
    try {
      await runConvert(density);
      return listGeneratedFiles(outputDir, ".webp");
    } catch (error) {
      if (!isResourceLimitError(error)) {
        console.error("[ImageMagick] Conversion failed:", error);
        throwAppError("UPLOAD_GENERATION_FAILED");
      }
    }

    // Retry at a lower density; bail out if already at the minimum
    const retryDensity: number =
      density > MEDIUM_DENSITY
        ? MEDIUM_DENSITY
        : density > LOW_DENSITY
          ? LOW_DENSITY
          : throwAppError("UPLOAD_GENERATION_FAILED");

    await clearGeneratedFiles(outputDir, ".webp");

    try {
      await runConvert(retryDensity);
      return listGeneratedFiles(outputDir, ".webp");
    } catch (retryError) {
      if (!isResourceLimitError(retryError)) {
        console.error("[ImageMagick] Failed after density retry:", retryError);
        throwAppError("UPLOAD_GENERATION_FAILED");
      }
    }

    // Last resort: batch conversion at reduced density
    await clearGeneratedFiles(outputDir, ".webp");
    await runBatchedConvert(retryDensity);

    const results = await listGeneratedFiles(outputDir, ".webp");
    if (results.length === 0) throwAppError("UPLOAD_GENERATION_FAILED");
    return results;
  }
}
