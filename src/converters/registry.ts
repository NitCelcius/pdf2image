import { GhostscriptConverter } from "./ghostscript";
import { ImageMagickConverter } from "./imagemagick";
import { MuToolConverter } from "./mutool";
import type { PdfConverter } from "./types";

const registry = new Map<string, PdfConverter>();

/**
 * Register a converter under the given name.
 * The name is the value used in the `PDF_CONVERSION_TOOL` env variable.
 *
 * Call this before the bot starts accepting commands, e.g. in index.ts:
 * ```ts
 * import { registerConverter } from "./converters/registry";
 * registerConverter("mypdf2img", new MyPdf2ImgConverter());
 * ```
 */
export const registerConverter = (
  name: string,
  converter: PdfConverter,
): void => {
  registry.set(name.toLowerCase(), converter);
};

/**
 * Resolve the converter for the given tool name.
 * Falls back to `imagemagick` when `toolName` is undefined or empty.
 *
 * Throws if the requested converter has not been registered.
 */
export const createConverter = (toolName?: string): PdfConverter => {
  const key = (toolName ?? "imagemagick").toLowerCase().trim();
  const converter = registry.get(key);
  if (!converter) {
    const available = [...registry.keys()].join(", ");
    throw new Error(
      `Unknown PDF_CONVERSION_TOOL "${key}". Available: ${available}`,
    );
  }
  return converter;
};

// Register the built-in converters
registerConverter("imagemagick", new ImageMagickConverter());
registerConverter("ghostscript", new GhostscriptConverter());
registerConverter("mutool", new MuToolConverter());
