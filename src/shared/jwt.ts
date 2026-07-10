import * as crypto from "crypto";

export class JwtUtil {
  /**
   * Signs a payload and returns a stateless JWT.
   */
  static sign(
    payload: any,
    secret: string,
    expiresInSeconds: number = 3600
  ): string {
    const header = {
      alg: "HS256",
      typ: "JWT",
    };

    const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const fullPayload = { ...payload, exp };

    const base64Header = this.base64UrlEncode(JSON.stringify(header));
    const base64Payload = this.base64UrlEncode(JSON.stringify(fullPayload));

    const signature = this.generateSignature(
      base64Header,
      base64Payload,
      secret
    );

    return `${base64Header}.${base64Payload}.${signature}`;
  }

  /**
   * Verifies a JWT and returns the parsed payload, or null if invalid/expired.
   */
  static verify(token: string, secret: string): any | null {
    try {
      const parts = token.split(".");
      if (parts.length !== 3) return null;

      const [headerB64, payloadB64, signature] = parts;

      const expectedSignature = this.generateSignature(
        headerB64,
        payloadB64,
        secret
      );

      if (signature !== expectedSignature) {
        return null;
      }

      // ✅ Decode Base64URL -> JSON string
      const payloadStr = this.base64UrlDecode(payloadB64);

      // ✅ Parse JSON
      const payload = JSON.parse(payloadStr);

      // ✅ Check expiration
      if (payload.exp && Date.now() / 1000 > payload.exp) {
        return null;
      }

      return payload;
    } catch {
      return null;
    }
  }

  /**
   * Encode UTF-8 string -> Base64URL
   */
  private static base64UrlEncode(str: string): string {
    return Buffer.from(str, "utf-8")
      .toString("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  }

  /**
   * Decode Base64URL -> UTF-8 string
   */
  private static base64UrlDecode(base64url: string): string {
    let base64 = base64url
      .replace(/-/g, "+")
      .replace(/_/g, "/");

    while (base64.length % 4) {
      base64 += "=";
    }

    return Buffer.from(base64, "base64").toString("utf-8");
  }

  /**
   * Generate HS256 signature
   */
  private static generateSignature(
    headerB64: string,
    payloadB64: string,
    secret: string
  ): string {
    return crypto
      .createHmac("sha256", secret)
      .update(`${headerB64}.${payloadB64}`)
      .digest("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  }
}