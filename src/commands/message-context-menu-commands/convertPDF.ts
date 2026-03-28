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
import { createConverter } from "../../converters";
import type { AppErrorCode } from "../../converters";
import { getStepTimeoutMs, throwAppError } from "../../converters/types";

const DOWNLOAD_TIMEOUT_MS = 120_000;
const PROCESS_TIMEOUT_MS = 10 * 60 * 1000;
const DISCORD_API_TIMEOUT_MS = 30_000;
const MAX_BASE_FILENAME_LENGTH = 64;

const LOW_DENSITY = 100;
const MEDIUM_DENSITY = 200;
const DEFAULT_DENSITY = 300;

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
} as const satisfies Record<AppErrorCode, string>;

const DISCORD_ERROR_MAP: Record<string, AppErrorCode> = {
  "50001": "BOT_SEND_PERMISSION",
  "50013": "BOT_REQUIRED_PERMISSION",
  "40005": "IMAGE_TOO_LARGE",
  ChannelNotCached: "CHANNEL_INFO_FAILED",
  "429": "RATE_LIMIT",
  "413": "IMAGE_TOO_LARGE",
};

const chooseDensity = (sizeBytes: number): number => {
  if (sizeBytes >= 60 * 1024 * 1024) return LOW_DENSITY;
  if (sizeBytes >= 30 * 1024 * 1024) return MEDIUM_DENSITY;
  return DEFAULT_DENSITY;
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
            { statusCode: response.statusCode },
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

  const totalMessages = Math.ceil(files.length / 10);
  let previousMessage: Message | null = null;

  for (let i = 0, messageIndex = 0; i < files.length; i += 10, messageIndex++) {
    const filesToSend = files.slice(i, i + 10);
    const content =
      totalMessages > 1 ? `(${messageIndex + 1}/${totalMessages})` : undefined;

    try {
      const messageOptions = {
        content,
        files: filesToSend,
        allowedMentions: { repliedUser: false },
      };

      const sendPromise: Promise<Message> = previousMessage
        ? previousMessage.reply(messageOptions)
        : targetMessage.reply(messageOptions);

      const sentMessage: Message = await withTimeout(
        sendPromise,
        getStepTimeoutMs(deadlineAt, PROCESS_TIMEOUT_MS),
      );
      previousMessage = sentMessage;
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

    const converter = createConverter(process.env.PDF_CONVERSION_TOOL);
    console.log(`[Convert] Using converter: ${converter.name}`);

    const generatedFiles = await converter.convert({
      inputPath: pdfPath,
      outputDir: imageDir,
      outputPrefix: originalFilename,
      density: chooseDensity(attachment.size),
      deadlineAt,
    });

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

const isUnknownInteractionError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const c = error as {
    code?: unknown;
    message?: unknown;
    rawError?: { code?: unknown; message?: unknown };
  };
  return (
    String(c.code) === "10062" ||
    String(c.rawError?.code) === "10062" ||
    String(c.message ?? "").includes("Unknown interaction") ||
    String(c.rawError?.message ?? "").includes("Unknown interaction")
  );
};

const isAlreadyAcknowledgedError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const c = error as {
    code?: unknown;
    message?: unknown;
    rawError?: { code?: unknown; message?: unknown };
  };
  return (
    String(c.code) === "40060" ||
    String(c.rawError?.code) === "40060" ||
    String(c.message ?? "").includes("already been acknowledged") ||
    String(c.rawError?.message ?? "").includes("already been acknowledged")
  );
};

const warnAlreadyAcknowledged = (
  interaction: MessageContextMenuCommandInteraction,
  phase: string,
  error: unknown,
): void => {
  console.warn(
    `[Command] ${phase}: interaction already acknowledged (40060). This can indicate another bot instance or duplicate handler already responded.`,
    {
      interactionId: interaction.id,
      commandName: interaction.commandName,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      userId: interaction.user.id,
      deferred: interaction.deferred,
      replied: interaction.replied,
      errorCode: String((error as { code?: unknown } | null)?.code ?? ""),
      rawErrorCode: String(
        (error as { rawError?: { code?: unknown } } | null)?.rawError?.code ??
          "",
      ),
    },
  );
};

const notifySuccessFallback = async (
  interaction: MessageContextMenuCommandInteraction,
  userMessage: string,
): Promise<void> => {
  try {
    const targetMessage = interaction.options.getMessage("message");
    if (targetMessage) {
      await targetMessage.reply({
        content: userMessage,
        allowedMentions: { repliedUser: false },
      });
      return;
    }
  } catch (fallbackError) {
    console.error(
      "[Command] target message success fallback failed:",
      fallbackError,
    );
  }

  try {
    if (interaction.channel?.isSendable()) {
      await interaction.channel.send({ content: userMessage });
    }
  } catch (channelFallbackError) {
    console.error(
      "[Command] channel success fallback failed:",
      channelFallbackError,
    );
  }
};

const notifyFailureFallback = async (
  interaction: MessageContextMenuCommandInteraction,
  userMessage: string,
): Promise<void> => {
  try {
    const targetMessage = interaction.options.getMessage("message");
    if (targetMessage) {
      await targetMessage.reply({
        content: `PDF変換に失敗しました。${userMessage}`,
        allowedMentions: { repliedUser: false },
      });
      return;
    }
  } catch (fallbackError) {
    console.error("[Command] target message fallback failed:", fallbackError);
  }

  try {
    if (interaction.channel?.isSendable()) {
      await interaction.channel.send({ content: userMessage });
    }
  } catch (channelFallbackError) {
    console.error("[Command] channel fallback failed:", channelFallbackError);
  }
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

    let canUseInteractionResponse = false;
    const targetMessage = interaction.options.getMessage("message");

    try {
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

      try {
        await withTimeout(
          interaction.deferReply({ flags: MessageFlags.Ephemeral }),
          DISCORD_API_TIMEOUT_MS,
        );
        canUseInteractionResponse = true;
      } catch (deferError) {
        if (isUnknownInteractionError(deferError)) {
          console.warn(
            "[Command] deferReply skipped due to unknown interaction. Continuing with channel fallback mode.",
          );
          canUseInteractionResponse = false;
        } else if (isAlreadyAcknowledgedError(deferError)) {
          warnAlreadyAcknowledged(interaction, "deferReply", deferError);
          console.warn(
            "[Command] interaction was already acknowledged before deferReply. Continuing with interaction response mode.",
          );
          canUseInteractionResponse = true;
        } else {
          throw deferError;
        }
      }

      for (const attachment of pdfAttachments) {
        await processAttachment(message, attachment);
      }

      const successMessage = `${pdfAttachments.length}件のPDF変換が完了しました。`;

      if (canUseInteractionResponse) {
        try {
          await withTimeout(
            interaction.editReply({ content: successMessage }),
            DISCORD_API_TIMEOUT_MS,
          );
        } catch (successReplyError) {
          if (isUnknownInteractionError(successReplyError)) {
            await notifySuccessFallback(interaction, successMessage);
          } else {
            throw successReplyError;
          }
        }
      } else {
        await notifySuccessFallback(interaction, successMessage);
      }
    } catch (error) {
      console.error("[Command] convertPDF failed:", error);
      const userMessage = resolveUserMessage(error);

      const interactionAlreadyAcknowledged =
        interaction.deferred ||
        interaction.replied ||
        isAlreadyAcknowledgedError(error);

      if (!canUseInteractionResponse || !interactionAlreadyAcknowledged) {
        try {
          await withTimeout(
            interaction.reply({
              content: userMessage,
              flags: MessageFlags.Ephemeral,
            }),
            DISCORD_API_TIMEOUT_MS,
          );
          return;
        } catch (replyError) {
          console.error("[Command] reply failed:", replyError);

          if (isAlreadyAcknowledgedError(replyError)) {
            warnAlreadyAcknowledged(interaction, "reply", replyError);
            canUseInteractionResponse = true;
          } else {
            await notifyFailureFallback(interaction, userMessage);
            return;
          }
        }
      }

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
          if (isUnknownInteractionError(followUpError)) {
            await notifyFailureFallback(interaction, userMessage);
          }
        }
      }
    }
  },
};
