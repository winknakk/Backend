import { sanitizeSensitiveData, EvidenceSource } from "../../domain/diagnostic/DeveloperDiagnostic";

export type AttachmentExtractionStatus =
  | "EXTRACTION_AVAILABLE"
  | "EXTRACTION_UNAVAILABLE"
  | "UNSUPPORTED_FORMAT"
  | "REJECTED_OVERSIZED"
  | "REJECTED_MALICIOUS";

export interface RawAttachmentInput {
  filename?: string;
  url?: string;
  type?: string;
  mimeType?: string;
  sizeBytes?: number;
  description?: string;
  extractedText?: string;
}

export interface ProcessedAttachmentResult {
  filename?: string;
  url?: string;
  type: string;
  mimeType?: string;
  description?: string;
  extractionStatus: AttachmentExtractionStatus;
  extractedText?: string;
  source: EvidenceSource;
  rejectionReason?: string;
}

export class AttachmentIntelligenceAdapter {
  private static readonly MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
  private static readonly ALLOWED_EXTENSIONS = new Set([
    "png", "jpg", "jpeg", "webp", "gif", "bmp", "pdf", "txt", "log", "json", "csv"
  ]);
  private static readonly DANGEROUS_EXTENSIONS = new Set([
    "exe", "bat", "cmd", "sh", "ps1", "vbs", "js", "mjs", "ts", "jar", "war", "py", "php"
  ]);

  /**
   * Evaluates and sanitizes inbound attachments.
   * Graceful fallback: If binary image/document has no OCR text, it is marked EXTRACTION_UNAVAILABLE
   * without falsely claiming OCR was performed.
   */
  public process(attachment: RawAttachmentInput): ProcessedAttachmentResult {
    const rawFilename = attachment.filename || "";
    const extension = rawFilename.includes(".")
      ? rawFilename.split(".").pop()?.toLowerCase() || ""
      : "";

    // 1. Security Check: Block dangerous executable file extensions
    if (extension && AttachmentIntelligenceAdapter.DANGEROUS_EXTENSIONS.has(extension)) {
      return {
        filename: sanitizeSensitiveData(rawFilename),
        url: attachment.url,
        type: "rejected",
        extractionStatus: "REJECTED_MALICIOUS",
        source: "CUSTOMER_ATTACHMENT",
        rejectionReason: `Security policy violation: dangerous file extension .${extension} is blocked`,
      };
    }

    // 2. Security Check: File Size limits
    if (attachment.sizeBytes && attachment.sizeBytes > AttachmentIntelligenceAdapter.MAX_FILE_SIZE_BYTES) {
      return {
        filename: sanitizeSensitiveData(rawFilename),
        url: attachment.url,
        type: attachment.type || "unknown",
        extractionStatus: "REJECTED_OVERSIZED",
        source: "CUSTOMER_ATTACHMENT",
        rejectionReason: `File size ${attachment.sizeBytes} exceeds maximum limit of 10MB`,
      };
    }

    // 3. Format / MIME validation
    if (extension && !AttachmentIntelligenceAdapter.ALLOWED_EXTENSIONS.has(extension)) {
      return {
        filename: sanitizeSensitiveData(rawFilename),
        url: attachment.url,
        type: attachment.type || "unknown",
        extractionStatus: "UNSUPPORTED_FORMAT",
        source: "CUSTOMER_ATTACHMENT",
        rejectionReason: `Unsupported file format .${extension}`,
      };
    }

    // 4. Extraction Determination
    // If upstream vision/OCR service provided text, make it available
    if (attachment.extractedText && attachment.extractedText.trim().length > 0) {
      return {
        filename: sanitizeSensitiveData(rawFilename),
        url: attachment.url,
        type: attachment.type || (extension === "pdf" ? "document" : "image"),
        mimeType: attachment.mimeType,
        description: attachment.description ? sanitizeSensitiveData(attachment.description) : undefined,
        extractionStatus: "EXTRACTION_AVAILABLE",
        extractedText: sanitizeSensitiveData(attachment.extractedText),
        source: "CUSTOMER_ATTACHMENT",
      };
    }

    // Graceful fallback for raw binaries: Local OCR/Vision is not executed on server,
    // marked cleanly as EXTRACTION_UNAVAILABLE without pretending OCR ran.
    return {
      filename: sanitizeSensitiveData(rawFilename),
      url: attachment.url,
      type: attachment.type || (extension === "pdf" ? "document" : "image"),
      mimeType: attachment.mimeType,
      description: attachment.description ? sanitizeSensitiveData(attachment.description) : undefined,
      extractionStatus: "EXTRACTION_UNAVAILABLE",
      extractedText: undefined,
      source: "CUSTOMER_ATTACHMENT",
    };
  }

  public processAll(attachments: RawAttachmentInput[] = []): ProcessedAttachmentResult[] {
    return attachments.map((att) => this.process(att));
  }
}
