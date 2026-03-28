export type AppErrorCode =
  | "PROCESS_TIMEOUT"
  | "TARGET_MESSAGE_NOT_FOUND"
  | "NO_ATTACHMENTS"
  | "NO_PDF_ATTACHMENTS"
  | "DOWNLOAD_FAILED"
  | "UPLOAD_GENERATION_FAILED"
  | "CHANNEL_SEND_UNAVAILABLE"
  | "BOT_SEND_PERMISSION"
  | "BOT_REQUIRED_PERMISSION"
  | "IMAGE_TOO_LARGE"
  | "CHANNEL_INFO_FAILED"
  | "RATE_LIMIT";

export const throwAppError = (code: AppErrorCode): never => {
  throw { code };
};
