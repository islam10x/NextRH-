export const ALLOWED_UPLOAD_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/png",
  "image/jpeg",
];

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

export type UploadContext = "cv" | "certification";
