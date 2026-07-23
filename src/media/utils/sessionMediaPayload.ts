export interface NormalizedSessionMediaPayload {
  senderId?: string;
  channel: string;
  messageText: string;
  isMentioned: boolean;
  messageType: string;
  imageId?: string;
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;

  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
    return value;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

export function unwrapNestedPayload(input: unknown): Record<string, any> {
  let current = parseJsonValue(input);

  for (let depth = 0; depth < 5; depth += 1) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      break;
    }

    const record = current as Record<string, any>;
    const nested = record.data ?? record.body;
    if (nested === undefined) {
      if (typeof record.rawBody === "string") {
        const parsedRawBody = parseJsonValue(record.rawBody);
        if (parsedRawBody !== record.rawBody) {
          current = parsedRawBody;
          continue;
        }
      }
      return record;
    }

    current = parseJsonValue(nested);
  }

  return current && typeof current === "object" && !Array.isArray(current)
    ? current as Record<string, any>
    : {};
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).trim();
  return normalized || undefined;
}

export function normalizeSessionMediaPayload(input: unknown): NormalizedSessionMediaPayload {
  const payload = unwrapNestedPayload(input);
  const imageId = optionalString(
    payload.imageId ??
    payload.image_id ??
    payload.lineImageId ??
    payload.line_image_id ??
    payload.externalMessageId ??
    payload.external_message_id
  );
  const explicitMessageType = optionalString(payload.messageType ?? payload.message_type);

  return {
    senderId: optionalString(payload.senderId ?? payload.sender_ref ?? payload.customer_ref),
    channel: optionalString(payload.channel) || "LINE",
    messageText: optionalString(payload.messageText ?? payload.message) || "",
    isMentioned: payload.isMentioned === true ||
      payload.isMentioned === "true" ||
      payload.is_mentioned === true ||
      payload.is_mentioned === "true",
    messageType: (imageId ? "image" : (explicitMessageType || "text")).toLowerCase(),
    imageId
  };
}

export function isValidLineImageId(imageId: string | undefined): imageId is string {
  return Boolean(imageId && /^\d{6,32}$/.test(imageId));
}
