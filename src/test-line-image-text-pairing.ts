import assert from "node:assert/strict";
import {
  findAccompanyingCustomerText,
  LINE_IMAGE_TEXT_PAIR_WINDOW_SECONDS,
  type ImageTextPairingQuery,
} from "./services/LineImageTextPairingService";

async function main(): Promise<void> {
  let capturedSql = "";
  let capturedValues: unknown[] | undefined;
  const expected = {
    id: 692115,
    content: "แจ้งเคสค่ะ ระบบชดใช้เงินยืม ต้องการย้อนสถานะ",
    created_at: "2026-09-22T10:19:05.000Z",
  };
  const db: ImageTextPairingQuery = {
    async query<Row>(sql: string, values?: unknown[]) {
      capturedSql = sql;
      capturedValues = values;
      return { rows: [expected as Row] };
    },
  };

  const result = await findAccompanyingCustomerText(db, 1041, 4008505);

  assert.deepEqual(result, expected);
  assert.deepEqual(capturedValues, [1041, 4008505, LINE_IMAGE_TEXT_PAIR_WINDOW_SECONDS]);
  assert.match(capturedSql, /image_message\.created_at\s*-\s*\(\$3::int \* INTERVAL '1 second'\)/);
  assert.match(capturedSql, /image_message\.created_at\s*\+\s*\(\$3::int \* INTERVAL '1 second'\)/);
  assert.doesNotMatch(capturedSql, /NOW\(\)\s*-\s*INTERVAL '30 seconds'/);

  const emptyDb: ImageTextPairingQuery = {
    async query<Row>() {
      return { rows: [] as Row[] };
    },
  };
  assert.equal(await findAccompanyingCustomerText(emptyDb, 1041, 4008505), null);

  console.log("Line image/text pairing regression: 2/2 passed");
}

void main();
