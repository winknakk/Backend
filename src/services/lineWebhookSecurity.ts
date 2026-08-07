import crypto from "crypto";

export interface ResolvedLineWebhookPayload {
  rawBody: Buffer;
  signature: string;
  body: any;
  forwardedByRouter: boolean;
}

export function resolveLineWebhookPayload(input: {
  body: unknown;
  requestRawBody?: Buffer;
  headerSignature?: unknown;
}): ResolvedLineWebhookPayload {
  const requestBody = (input.body || {}) as any;
  const forwardedRawBody = typeof requestBody.rawBody === "string" ? requestBody.rawBody : null;
  if (forwardedRawBody) {
    return {
      rawBody: Buffer.from(forwardedRawBody, "utf8"),
      signature: String(requestBody.signature || ""),
      body: JSON.parse(forwardedRawBody),
      forwardedByRouter: true,
    };
  }
  return {
    rawBody: input.requestRawBody || Buffer.from(JSON.stringify(requestBody), "utf8"),
    signature: String(input.headerSignature || ""),
    body: requestBody,
    forwardedByRouter: false,
  };
}

export function verifyLineSignature(rawBody: Buffer, signature: string, channelSecret: string): boolean {
  if (!rawBody.length || !signature || !channelSecret) return false;
  const expected = crypto.createHmac("sha256", channelSecret).update(rawBody).digest("base64");
  const actualBuffer = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}
