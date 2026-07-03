try {
  const result = require("../src/adapters/postgres/PostgresAdapter");
  console.log("Keys in require result:", Object.keys(result));
  console.log("Is pool defined?", !!result.pool);
} catch (e: any) {
  console.error("Require failed:", e.message);
}
