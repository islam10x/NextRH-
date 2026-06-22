import { DataSource } from "typeorm";
import * as path from "path";
import * as dotenv from "dotenv";

// Ensure CLI migrations load environment variables from the backend/.env file.
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const dbPassword = process.env.DB_PASSWORD;
if (!dbPassword) {
  throw new Error("DB_PASSWORD is required");
}

export const AppDataSource = new DataSource({
  type: "postgres",
  host: process.env.DB_HOST || "localhost",
  port: parseInt(process.env.DB_PORT, 10) || 5432,
  username: process.env.DB_USER || "postgres",
  password: dbPassword,
  database: process.env.DB_NAME || "cv_management",
  synchronize: false,
  logging: true,
  entities: [path.join(__dirname, "/../**/*.entity{.ts,.js}")],
  migrations: [path.join(__dirname, "/migrations/**/*{.ts,.js}")],
  subscribers: [],
});
