import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { config } from "../../config/env";
import { createLogger } from "../../observability/logger";

const logger = createLogger("BackupManager");

export class BackupManager {
  private static backupDir = path.resolve(__dirname, "../../../data/backups");

  private static getFilePath(tableName: string): string {
    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }
    return path.join(this.backupDir, `${tableName}.json.enc`);
  }

  private static deriveKey(): Buffer {
    // Derives a 32-byte key from BACKUP_ENCRYPTION_KEY
    return crypto.scryptSync(config.BACKUP_ENCRYPTION_KEY, "backup-salt", 32);
  }

  static encrypt(text: string): string {
    const iv = crypto.randomBytes(16);
    const key = this.deriveKey();
    const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
    let encrypted = cipher.update(text, "utf8", "hex");
    encrypted += cipher.final("hex");
    return iv.toString("hex") + ":" + encrypted;
  }

  static decrypt(text: string): string {
    const parts = text.split(":");
    const ivHex = parts.shift();
    const encryptedHex = parts.join(":");
    if (!ivHex || !encryptedHex) {
      throw new Error("Invalid encrypted format");
    }
    const iv = Buffer.from(ivHex, "hex");
    const encryptedText = Buffer.from(encryptedHex, "hex");
    const key = this.deriveKey();
    const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
  }

  static async readFromBackup<T>(tableName: string): Promise<T[]> {
    const filePath = this.getFilePath(tableName);
    if (!fs.existsSync(filePath)) {
      return [];
    }
    try {
      const encrypted = fs.readFileSync(filePath, "utf-8");
      if (!encrypted.trim()) {
        return [];
      }
      const decrypted = this.decrypt(encrypted);
      return JSON.parse(decrypted) as T[];
    } catch (err: any) {
      logger.error({ tableName, error: err.message }, "Failed to read or decrypt local backup file");
      return [];
    }
  }

  static async saveToBackup(tableName: string, row: any, idField: string = "id"): Promise<void> {
    try {
      const filePath = this.getFilePath(tableName);
      const list = await this.readFromBackup<any>(tableName);

      const index = list.findIndex((item) => String(item[idField]) === String(row[idField]));

      if (index !== -1) {
        list[index] = { ...list[index], ...row };
      } else {
        list.push(row);
      }

      const serialized = JSON.stringify(list, null, 2);
      const encrypted = this.encrypt(serialized);
      fs.writeFileSync(filePath, encrypted, "utf-8");
    } catch (err: any) {
      logger.error({ tableName, error: err.message }, "Failed to write local backup file");
    }
  }
}
