import { execFile } from "child_process";
import {
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  MessageFlags,
  type Attachment,
  type Message,
  type MessageContextMenuCommandInteraction,
} from "discord.js";
import { createWriteStream } from "fs";
import fs from "fs/promises";
import type { IncomingMessage } from "http";
import https from "https";
import os from "os";
import path from "path";
import { pipeline } from "stream/promises";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const DOWNLOAD_TIMEOUT_MS = 120_000;
const CONVERT_TIMEOUT_MS = 120_000;
const PROCESS_TIMEOUT_MS = 10 * 60 * 1000;
const DISCORD_API_TIMEOUT_MS = 30_000;
const MAX_BASE_FILENAME_LENGTH = 64;

const LOW_DENSITY = 100;
const MEDIUM_DENSITY = 200;
const DEFAULT_DENSITY = 300;
const CONVERT_BATCH_SIZE = 32;

const CHECK_BOT_PERMISSIONS_MESSAGE = "Botの権限設定を確認してください。";
const GENERIC_ERROR =
  "変換処理に失敗しました。時間をおいて再試行してください。";
const TIMEOUT_RETRY =
  "処理がタイムアウトしました。PDFのページ数を減らして再試行してください。";

const APP_ERROR_MESSAGES = {
  PROCESS_TIMEOUT:
    "処理時間が上限を超えました。PDFのページ数を減らして再試行してください。",
  TARGET_MESSAGE_NOT_FOUND: "対象のメッセージが見つかりませんでした。",
  NO_ATTACHMENTS: "ファイルが添付されていません。",
  NO_PDF_ATTACHMENTS: "PDFファイルが添付されていません。",
  DOWNLOAD_FAILED:
    "PDFのダウンロードに失敗しました。時間をおいて再試行してください。",
  UPLOAD_GENERATION_FAILED:
    "画像の生成に失敗しました。別のPDFで再試行してください。",
  CHANNEL_SEND_UNAVAILABLE: `このチャンネルにはメッセージを送信できません。\n${CHECK_BOT_PERMISSIONS_MESSAGE}`,
  BOT_SEND_PERMISSION: `Botにメッセージ送信権限がありません。\n${CHECK_BOT_PERMISSIONS_MESSAGE}`,
  BOT_REQUIRED_PERMISSION: `Botに必要な権限がありません。\n${CHECK_BOT_PERMISSIONS_MESSAGE}`,
  IMAGE_TOO_LARGE:
    "画像サイズが大きすぎて送信できませんでした。\nページ数を減らして再試行してください。",
  CHANNEL_INFO_FAILED:
    "チャンネル情報の取得に失敗しました。\nもう一度お試しください。",
  RATE_LIMIT: "送信が混み合っています。時間をおいて再試行してください。",
} as const;

type AppErrorCode = keyof typeof APP_ERROR_MESSAGES;

const DISCORD_ERROR_MAP: Record<string, AppErrorCode> = {
  "50001": "BOT_SEND_PERMISSION",
  "50013": "BOT_REQUIRED_PERMISSION",
  "40005": "IMAGE_TOO_LARGE",
  ChannelNotCached: "CHANNEL_INFO_FAILED",
  "429": "RATE_LIMIT",
  "413": "IMAGE_TOO_LARGE",
};

const throwAppError = (code: AppErrorCode): never => {
  throw { code };
};

const getStepTimeoutMs = (deadlineAt: number, maxTimeoutMs: number): number => {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    throwAppError("PROCESS_TIMEOUT");
  }
  return Math.min(remainingMs, maxTimeoutMs);
};

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> => {
  const timeoutPromise = new Promise<T>((_, reject) => {
    const timer = setTimeout(
      () => reject({ code: "PROCESS_TIMEOUT" as const }),
      timeoutMs,
    );
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  });

  return Promise.race([promise, timeoutPromise]);
};

const isPdfAttachment = (attachment: Attachment): boolean => {
  const contentType = attachment.contentType?.toLowerCase();
  return (
    contentType?.startsWith("application/pdf") ||
    attachment.name?.toLowerCase().endsWith(".pdf") ||
    false
  );
};

const sanitizeBaseFilename = (filename?: string): string => {
  const base = (filename ?? "file.pdf").replace(/\.[^.]*$/, "");
  const sanitized = base
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/[\x00-\x1F\x7F]/g, "_")
    .trim();
  return (sanitized || "file").slice(0, MAX_BASE_FILENAME_LENGTH);
};

const chooseDensity = (sizeBytes: number): number => {
  if (sizeBytes >= 60 * 1024 * 1024) {
    return LOW_DENSITY;
  }
  if (sizeBytes >= 30 * 1024 * 1024) {
    return MEDIUM_DENSITY;
  }
  return DEFAULT_DENSITY;
};

const downloadPdf = async (
  url: string,
  filePath: string,
  timeoutMs: number,
): Promise<void> => {
  const cleanupFile = async (): Promise<void> => {
    try {
      await fs.unlink(filePath);
    } catch {
      // ignore cleanup errors
    }
  };

  await new Promise<void>((resolve, reject) => {
    const request = https.get(url, (response: IncomingMessage) => {
      void (async () => {
        if (
          !response.statusCode ||
          response.statusCode < 200 ||
          response.statusCode >= 300
        ) {
          console.error(
            `[Download] Failed with status code: ${response.statusCode}`,
            {
              statusCode: response.statusCode,
            },
          );
          response.resume();
          await cleanupFile();
          reject({ code: "DOWNLOAD_FAILED" as const });
          return;
        }

        const file = createWriteStream(filePath);
        try {
          await pipeline(response, file);
          resolve();
        } catch (error) {
          console.error("[Download] Stream error:", error);
          await cleanupFile();
          reject(error);
        }
      })();
    });

    request.setTimeout(timeoutMs, () => {
      const timeoutError = new Error(
        "ファイルのダウンロードがタイムアウトしました。",
      ) as NodeJS.ErrnoException;
      timeoutError.code = "ETIMEDOUT";
      request.destroy(timeoutError);
    });

    request.on("error", (error) => {
      console.error("[Download] Request error:", error);
      void cleanupFile().finally(() => reject(error));
    });
  });
};

const isResourceLimitError = (error: unknown): boolean => {
  const message = `${error instanceof Error ? error.message : ""}\n${(error as { stderr?: unknown })?.stderr ?? ""}`;
  return /cache resources exhausted|TooManyExceptions|IDAT: Too much image data/i.test(
    message,
  );
};

const listGeneratedWebps = async (imageDir: string): Promise<string[]> => {
  return (await fs.readdir(imageDir))
    .filter((file) => file.endsWith(".webp"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((file) => path.join(imageDir, file));
};

const listGeneratedPngs = async (imageDir: string): Promise<string[]> => {
  return (await fs.readdir(imageDir))
    .filter((file) => file.endsWith(".png"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((file) => path.join(imageDir, file));
};

const clearGeneratedWebps = async (imageDir: string): Promise<void> => {
  await Promise.all(
    (await fs.readdir(imageDir))
      .filter((file) => file.endsWith(".webp"))
      .map((file) => fs.unlink(path.join(imageDir, file)).catch(() => {})),
  );
};

const clearGeneratedPngs = async (imageDir: string): Promise<void> => {
  await Promise.all(
    (await fs.readdir(imageDir))
      .filter((file) => file.endsWith(".png"))
      .map((file) => fs.unlink(path.join(imageDir, file)).catch(() => {})),
  );
};

const getPdfPageCount = async (
  pdfPath: string,
  deadlineAt: number,
): Promise<number> => {
  const { stdout } = await execFileAsync(
    "identify",
    ["-ping", "-format", "%p\n", pdfPath],
    {
      timeout: getStepTimeoutMs(deadlineAt, CONVERT_TIMEOUT_MS),
    },
  );
  const pageCount = String(stdout)
    .split("\n")
    .filter((line) => line.trim() !== "").length;
  return Math.max(pageCount, 1);
};

const convertPdfToWebps = async (
  pdfPath: string,
  imageDir: string,
  originalFilename: string,
  initialDensity: number,
  deadlineAt: number,
): Promise<string[]> => {
  const outputPattern = path.join(
    imageDir,
    `${originalFilename}_page_%03d.webp`,
  );

  const runConvert = async (density: number): Promise<void> => {
    await execFileAsync(
      "convert",
      ["-density", String(density), "-alpha", "remove", pdfPath, outputPattern],
      {
        timeout: getStepTimeoutMs(deadlineAt, CONVERT_TIMEOUT_MS),
      },
    );
  };

  const runBatchedConvert = async (density: number): Promise<void> => {
    const pageCount = await getPdfPageCount(pdfPath, deadlineAt);
    for (let start = 0; start < pageCount; start += CONVERT_BATCH_SIZE) {
      const end = Math.min(start + CONVERT_BATCH_SIZE - 1, pageCount - 1);
      await execFileAsync(
        "convert",
        [
          "-density",
          String(density),
          "-alpha",
          "remove",
          `${pdfPath}[${start}-${end}]`,
          "-scene",
          String(start),
          outputPattern,
        ],
        { timeout: getStepTimeoutMs(deadlineAt, CONVERT_TIMEOUT_MS) },
      );
    }
  };

  try {
    await runConvert(initialDensity);
    return listGeneratedWebps(imageDir);
  } catch (error) {
    const retryDensity =
      initialDensity > MEDIUM_DENSITY
        ? MEDIUM_DENSITY
        : initialDensity > LOW_DENSITY
          ? LOW_DENSITY
          : null;
    if (retryDensity === null || !isResourceLimitError(error)) {
      console.error("[Convert] Failed:", error);
      throw error;
    }
    await clearGeneratedWebps(imageDir);
    try {
      await runConvert(retryDensity);
      return listGeneratedWebps(imageDir);
    } catch (retryError) {
      if (!isResourceLimitError(retryError)) {
        console.error("[Convert] Failed after retry:", retryError);
        throw retryError;
      }
      await clearGeneratedWebps(imageDir);
      await runBatchedConvert(retryDensity);
      return listGeneratedWebps(imageDir);
    }
  }
};

const sendWebps = async (
  targetMessage: Message,
  files: string[],
  deadlineAt: number,
): Promise<void> => {
  if (files.length === 0) {
    throwAppError("UPLOAD_GENERATION_FAILED");
  }

  if (!targetMessage.channel) {
    throwAppError("CHANNEL_SEND_UNAVAILABLE");
  }

  if (targetMessage.channel.partial) {
    await targetMessage.channel.fetch();
  }

  const firstMessageFiles = ((files.length - 1) % 9) + 1;
  for (let i = 0, messageIndex = 0; i < files.length; messageIndex++) {
    const chunkSize = messageIndex === 0 ? firstMessageFiles : 9;
    const filesToSend = files.slice(i, i + chunkSize);

    try {
      const sendPromise =
        messageIndex === 0
          ? targetMessage.reply({
              files: filesToSend,
              allowedMentions: { repliedUser: false },
            })
          : (() => {
              const sendableChannel = targetMessage.channel as {
                send?: (options: { files: string[] }) => Promise<unknown>;
              };
              const send = sendableChannel.send?.bind(targetMessage.channel);
              if (typeof send !== "function") {
                throwAppError("CHANNEL_SEND_UNAVAILABLE");
              }
              return (
                send as (options: { files: string[] }) => Promise<unknown>
              )({ files: filesToSend });
            })();

      await withTimeout(
        sendPromise,
        getStepTimeoutMs(deadlineAt, PROCESS_TIMEOUT_MS),
      );
    } catch (error) {
      if (error && typeof error === "object") {
        const mapped =
          DISCORD_ERROR_MAP[String((error as { code?: unknown }).code)] ??
          DISCORD_ERROR_MAP[String((error as { status?: unknown }).status)];
        if (mapped) {
          throwAppError(mapped);
        }
      }
      throw error;
    }

    i += chunkSize;
  }
};

const processAttachment = async (
  targetMessage: Message,
  attachment: Attachment,
): Promise<void> => {
  let pdfPath: string | undefined;
  let imageDir: string | undefined;
  const deadlineAt = Date.now() + PROCESS_TIMEOUT_MS;

  try {
    const originalFilename = sanitizeBaseFilename(attachment.name);
    imageDir = await fs.mkdtemp(path.join(os.tmpdir(), `${originalFilename}_`));
    pdfPath = path.join(
      path.dirname(imageDir),
      `${path.basename(imageDir)}.pdf`,
    );

    await downloadPdf(
      attachment.url,
      pdfPath,
      getStepTimeoutMs(deadlineAt, DOWNLOAD_TIMEOUT_MS),
    );
    const generatedFiles = await convertPdfToWebps(
      pdfPath,
      imageDir,
      originalFilename,
      chooseDensity(attachment.size),
      deadlineAt,
    );
    await sendWebps(targetMessage, generatedFiles, deadlineAt);
  } catch (error) {
    console.error(`[Process] Failed processing ${attachment.name}:`, error);
    throw error;
  } finally {
    try {
      await Promise.all([
        pdfPath ? fs.unlink(pdfPath).catch(() => {}) : undefined,
        imageDir
          ? fs.rm(imageDir, { recursive: true, force: true })
          : undefined,
      ]);
    } catch (cleanupError) {
      console.error("[Cleanup] Error:", cleanupError);
    }
  }
};

const resolveUserMessage = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code in APP_ERROR_MESSAGES) {
    return APP_ERROR_MESSAGES[code as AppErrorCode] ?? GENERIC_ERROR;
  }

  if (error instanceof Error) {
    const err = error as {
      code?: unknown;
      killed?: unknown;
      signal?: unknown;
      message: string;
    };
    if (
      err.code === "ETIMEDOUT" ||
      err.code === "ESOCKETTIMEDOUT" ||
      err.killed === true ||
      /timed out|timeout|タイムアウト/i.test(err.message)
    ) {
      return TIMEOUT_RETRY;
    }
  }

  return GENERIC_ERROR;
};

export = {
  data: new ContextMenuCommandBuilder()
    .setName("convertPDF")
    .setType(ApplicationCommandType.Message),
  async execute(interaction: MessageContextMenuCommandInteraction) {
    const guildName = interaction.guild?.name ?? "DM";
    console.log(
      `[Command] convertPDF executed in ${guildName} by ${interaction.user.tag}`,
    );

    try {
      await withTimeout(
        interaction.deferReply({ flags: MessageFlags.Ephemeral }),
        DISCORD_API_TIMEOUT_MS,
      );

      const targetMessage = interaction.options.getMessage("message");
      if (!targetMessage) {
        throwAppError("TARGET_MESSAGE_NOT_FOUND");
      }
      const message = targetMessage!;

      const pdfAttachments = Array.from(message.attachments.values()).filter(
        isPdfAttachment,
      );
      if (pdfAttachments.length === 0) {
        throwAppError(
          message.attachments.size === 0
            ? "NO_ATTACHMENTS"
            : "NO_PDF_ATTACHMENTS",
        );
      }

      for (const attachment of pdfAttachments) {
        await processAttachment(message, attachment);
      }

      await withTimeout(
        interaction.editReply({
          content: `${pdfAttachments.length}件のPDF変換が完了しました。`,
        }),
        DISCORD_API_TIMEOUT_MS,
      );
    } catch (error) {
      console.error("[Command] convertPDF failed:", error);
      const userMessage = resolveUserMessage(error);
      try {
        await withTimeout(
          interaction.editReply({ content: userMessage }),
          DISCORD_API_TIMEOUT_MS,
        );
      } catch (replyError) {
        console.error(
          "[Command] editReply failed, trying followUp:",
          replyError,
        );
        try {
          await withTimeout(
            interaction.followUp({
              content: userMessage,
              flags: MessageFlags.Ephemeral,
            }),
            DISCORD_API_TIMEOUT_MS,
          );
        } catch (followUpError) {
          console.error("[Command] followUp also failed:", followUpError);
        }
      }
    }
  },
};
