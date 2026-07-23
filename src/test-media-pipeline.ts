import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MessageAttachment } from "./domain/entities/MessageAttachment";
import { S3MediaStorageService } from "./media/services/S3MediaStorageService";
import {
  isValidLineImageId,
  normalizeSessionMediaPayload,
  unwrapNestedPayload
} from "./media/utils/sessionMediaPayload";

async function run(): Promise<void> {
  const nestedPayload = {
    data: JSON.stringify({
      channel: "line",
      customer_ref: "line-user-1",
      message: "",
      message_type: "image",
      line_image_id: "623909829446205548"
    })
  };
  const normalized = normalizeSessionMediaPayload(nestedPayload);
  assert.equal(normalized.senderId, "line-user-1");
  assert.equal(normalized.messageType, "image");
  assert.equal(normalized.imageId, "623909829446205548");
  assert.equal(isValidLineImageId(normalized.imageId), true);
  assert.equal(isValidLineImageId("msg_123"), false);

  const wrappedMessage = unwrapNestedPayload({
    body: {
      data: JSON.stringify({
        conversationId: 67,
        role: "customer",
        messageType: "image"
      })
    }
  });
  assert.equal(wrappedMessage.conversationId, 67);
  assert.equal(wrappedMessage.messageType, "image");

  const stagedAttachment = new MessageAttachment({
    messageId: 0,
    fileUrl: "http://localhost:3000/api/v1/media/file?key=line_media/test.jpg",
    fileName: "test.jpg",
    fileType: "image/jpeg",
    fileSize: 1,
    storageKey: "line_media/test.jpg"
  });
  assert.equal(stagedAttachment.messageId, 0);
  assert.throws(
    () =>
      new MessageAttachment({
        messageId: -1,
        fileUrl: "http://localhost:3000/api/v1/media/file?key=line_media/test.jpg",
        fileName: "test.jpg",
        fileType: "image/jpeg",
        fileSize: 1,
        storageKey: "line_media/test.jpg"
      }),
    /non-negative integer/
  );

  const tempVault = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ticketx-media-test-"));
  try {
    const storage = new S3MediaStorageService({
      localVaultPath: tempVault,
      publicCdnBaseUrl: "http://localhost:3000/api/v1/media",
      signingSecret: "media-pipeline-test-secret"
    });
    const uploaded = await storage.upload({
      buffer: Buffer.from("ticketx-image-content"),
      fileName: "line-test.jpg",
      mimeType: "image/jpeg",
      folder: "line_media"
    });

    assert.match(uploaded.storageKey, /^line_media\/line-test_[a-f0-9]{10}\.jpg$/);
    assert.equal(await storage.exists(uploaded.storageKey), true);

    const signedUrl = new URL(uploaded.fileUrl);
    const expires = signedUrl.searchParams.get("expires") || "";
    const signature = signedUrl.searchParams.get("signature") || "";
    assert.equal(storage.verifyPresignedUrl(uploaded.storageKey, expires, signature), true);
    assert.equal(storage.verifyPresignedUrl(uploaded.storageKey, "1", signature), false);
    assert.equal(storage.verifyPresignedUrl(uploaded.storageKey, expires, "0".repeat(64)), false);

    const downloaded = await storage.download(uploaded.storageKey);
    assert.deepEqual(downloaded.buffer, Buffer.from("ticketx-image-content"));
    await assert.rejects(() => storage.download("../outside.jpg"), /Invalid media storage key/);

    await storage.delete(uploaded.storageKey);
    assert.equal(await storage.exists(uploaded.storageKey), false);
  } finally {
    const resolvedTempVault = path.resolve(tempVault);
    const resolvedTempRoot = path.resolve(os.tmpdir());
    assert.equal(resolvedTempVault.startsWith(resolvedTempRoot + path.sep), true);
    await fs.promises.rm(resolvedTempVault, { recursive: true, force: true });
  }

  console.log("Media pipeline regression checks passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
