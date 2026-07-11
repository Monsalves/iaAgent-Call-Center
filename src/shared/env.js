import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

export function getProjectRoot() {
  return projectRoot;
}

export function loadEnvForApp(appDir) {
  dotenv.config({ path: path.join(projectRoot, ".env"), quiet: true });
  dotenv.config({ path: path.join(appDir, ".env"), quiet: true, override: true });
}

export function readRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function resolveProjectPath(relativePath) {
  return path.resolve(projectRoot, relativePath);
}

export function readTextFileIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return "";
  }

  return fs.readFileSync(filePath, "utf8").trim();
}
