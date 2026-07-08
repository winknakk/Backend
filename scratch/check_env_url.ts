import { config } from "../src/config/env";
console.log("process.env.DATABASE_URL:", process.env.DATABASE_URL);
console.log("config.DATABASE_URL:", config.DATABASE_URL);
