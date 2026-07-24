import { pool } from "./adapters/postgres/PostgresAdapter";
(async () => {
  const rows = await pool.query("SELECT id, file_url FROM message_attachments WHERE storage_key = 'admin_media/file'");
  console.log("Records to fix:", rows.rows.length);
  for (const row of rows.rows) {
    try {
      const u = new URL(row.file_url);
      const k = u.searchParams.get("key") || "";
      const n = k ? (k.split("/").pop() || "operator_image.jpg") : "operator_image.jpg";
      if (k && k !== "admin_media/file") {
        await pool.query("UPDATE message_attachments SET storage_key=$1, file_name=$2 WHERE id=$3", [k, n, row.id]);
        console.log("Fixed id", row.id, "->", k);
      } else {
        console.log("Skipped id", row.id);
      }
    } catch (e: any) { console.error("Error id", row.id, e.message); }
  }
  console.log("Done!");
  await pool.end();
})();
