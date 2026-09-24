export const LINE_IMAGE_TEXT_PAIR_WINDOW_SECONDS = 30;

type QueryResult<Row> = { rows: Row[] };

export interface ImageTextPairingQuery {
  query<Row = any>(sql: string, values?: unknown[]): Promise<QueryResult<Row>>;
}

export interface AccompanyingCustomerText {
  id: number;
  content: string;
  created_at: Date | string;
}

/**
 * Finds customer text close to one specific image message.
 *
 * The window is anchored to the image's persisted timestamp. Anchoring it to
 * query time would shorten the usable pre-image window by however long the
 * post-ingest debounce waited before running this lookup.
 */
export async function findAccompanyingCustomerText(
  db: ImageTextPairingQuery,
  conversationId: number,
  imageMessageId: number,
  windowSeconds: number = LINE_IMAGE_TEXT_PAIR_WINDOW_SECONDS
): Promise<AccompanyingCustomerText | null> {
  const result = await db.query<AccompanyingCustomerText>(
    `SELECT text_message.id, text_message.content, text_message.created_at
       FROM messages image_message
       JOIN LATERAL (
         SELECT candidate.id, candidate.content, candidate.created_at
           FROM messages candidate
          WHERE candidate.conversation_id = image_message.conversation_id
            AND candidate.role = 'customer'
            AND candidate.message_type = 'text'
            AND candidate.created_at BETWEEN
                image_message.created_at - ($3::int * INTERVAL '1 second')
                AND image_message.created_at + ($3::int * INTERVAL '1 second')
          ORDER BY ABS(EXTRACT(EPOCH FROM (candidate.created_at - image_message.created_at))) ASC,
                   candidate.id DESC
          LIMIT 1
       ) text_message ON TRUE
      WHERE image_message.id = $2::integer
        AND image_message.conversation_id = $1::integer
        AND image_message.role = 'customer'
        AND image_message.message_type = 'image'
      LIMIT 1`,
    [conversationId, imageMessageId, windowSeconds]
  );

  return result.rows[0] ?? null;
}
