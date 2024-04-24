import { lilconfig } from "lilconfig";
import yaml from "yaml";
import fs from "node:fs";
import { generate } from "generate-password";
import { randomBytes } from "node:crypto";

import logger from "./logger.js";
import { mergeDeep } from "./helpers/object.js";

const log = logger.extend("config");

export type Rule = { id: string; type: string; pubkeys?: string[]; expiration: string };
export type Config = {
  publicDomain: string;
  databasePath: string;
  dashboard: {
    enabled: boolean;
    username: string;
    password: string;
    sessionKey: string;
  };
  discovery: {
    nostr: {
      enabled: boolean;
      relays: string[];
    };
    upstream: {
      enabled: boolean;
      domains: string[];
    };
  };
  storage: {
    backend: "local" | "s3";
    local?: {
      dir: string;
    };
    s3?: {
      endpoint: string;
      accessKey: string;
      secretKey: string;
      bucket: string;
      publicURL?: string;
    };
    rules: Rule[];
  };
  upload: {
    enabled: boolean;
    requireAuth: boolean;
    requirePubkeyInRule: boolean;
  };
  list: {
    requireAuth: boolean;
    allowListOthers: boolean;
  };
  tor: {
    enabled: boolean;
    proxy: string;
  };
};

function loadYaml(filepath: string, content: string) {
  return yaml.parse(content);
}
function loadJson(filepath: string, content: string) {
  return JSON.parse(content);
}

const defaultConfig: Config = {
  publicDomain: "http://127.0.0.1",
  databasePath: "data/sqlite.db",
  dashboard: { enabled: false, username: "admin", password: generate(), sessionKey: randomBytes(16).toString("hex") },
  discovery: {
    nostr: { enabled: false, relays: [] },
    upstream: { enabled: false, domains: [] },
  },
  storage: {
    backend: "local",
    local: { dir: "data" },
    rules: [],
  },
  upload: { enabled: false, requireAuth: true, requirePubkeyInRule: false },
  list: { requireAuth: false, allowListOthers: false },
  tor: { enabled: false, proxy: "" },
};

const result = await lilconfig("blossom", {
  searchPlaces: ["config.yaml", "config.yml", "config.json"],
  loaders: {
    ".yaml": loadYaml,
    ".yml": loadYaml,
    ".json": loadJson,
  },
}).search();

const config = mergeDeep(defaultConfig, result?.config ?? {}) as Config;

function saveConfig() {
  if (result) {
    if (result.filepath.includes(".json")) {
      fs.writeFileSync(result.filepath, JSON.stringify(config), { encoding: "utf-8" });
    } else {
      fs.writeFileSync(result.filepath, yaml.stringify(config), { encoding: "utf-8" });
    }
    log("Saved config file", result.filepath);
  } else {
    fs.writeFileSync("config.yml", yaml.stringify(config), { encoding: "utf-8" });
    log("Saved config file config.yml");
  }
}

export { config, saveConfig };
