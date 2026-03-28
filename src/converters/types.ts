import { execFile } from "child_process";
import fs from "fs/promises";
import path from "path";
import { promisify } from "util";
import { throwAppError } from "./errors";

export { throwAppError };
export type { AppErrorCode } from "./errors";

export const execFileAsync = promisify(execFile);

export const CONVERT_TIMEOUT_MS = 120_000;

export const getStepTimeoutMs = (
  deadlineAt: number,
  maxTimeoutMs: number,
): number => {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    throwAppError("PROCESS_TIMEOUT");
  }
  return Math.min(remainingMs, maxTimeoutMs);
};

export interface PdfConversionOptions {
  /** Absolute path to the source PDF file. */
  inputPath: string;
  /** Directory where output image files will be written. */
  outputDir: string;
  /** Base filename prefix used for naming output pages (e.g. "mydoc"). */
  outputPrefix: string;
  /** Render resolution in DPI. */
  density: number;
  /** Unix timestamp (ms) after which the operation should be aborted. */
  deadlineAt: number;
}

/**
 * Abstract base class for PDF-to-image converters.
 *
 * Implement this class to add support for a new conversion tool.
 * Each converter is responsible for producing WebP output files and
 * cleaning up any intermediate files it creates.
 *
 * Register custom converters with `registerConverter` from the registry
 * module before the bot starts processing commands.
 *
 * Example:
 * ```ts
 * import { PdfConverter, PdfConversionOptions } from "./converters/types";
 * import { registerConverter } from "./converters/registry";
 *
 * class MyConverter extends PdfConverter {
 *   readonly name = "mytool";
 *   async convert(options: PdfConversionOptions): Promise<string[]> {
 *     // ... invoke your tool and return sorted WebP file paths
 *   }
 * }
 *
 * registerConverter("mytool", new MyConverter());
 * ```
 */
export abstract class PdfConverter {
  /** Unique identifier for this converter (lower-case, matches env value). */
  abstract readonly name: string;

  /**
   * Convert a PDF to images.
   * @returns Sorted absolute paths to the generated WebP files.
   */
  abstract convert(options: PdfConversionOptions): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Shared file-system helpers used by multiple converters
// ---------------------------------------------------------------------------

export const listGeneratedFiles = async (
  dir: string,
  ext: string,
): Promise<string[]> =>
  (await fs.readdir(dir))
    .filter((f) => f.endsWith(ext))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((f) => path.join(dir, f));

export const clearGeneratedFiles = async (
  dir: string,
  ext: string,
): Promise<void> => {
  await Promise.all(
    (await fs.readdir(dir))
      .filter((f) => f.endsWith(ext))
      .map((f) => fs.unlink(path.join(dir, f)).catch(() => {})),
  );
};
