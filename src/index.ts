#!/bin/env node
import "websocket-polyfill";
import Koa from "koa";
import debug from "debug";
import serve from "koa-static";
import path from "node:path";
import { PassThrough } from "node:stream";
import { URLSearchParams } from "node:url";
import mime from "mime";
import pfs from "node:fs/promises";
import { NostrEvent } from "@nostr-dev-kit/ndk";
import cors from "@koa/cors";
import Router from "@koa/router";

import { config } from "./config.js";
import { BlobPointer, BlobSearch } from "./types.js";
import * as fileStorage from "./storage/file.js";
import * as cdnDiscovery from "./discover/cdn.js";
import * as nostrDiscovery from "./discover/nostr.js";
import * as httpTransport from "./transport/http.js";
import * as uploadModule from "./storage/upload.js";
import { addPubkeyToBlob, db, setBlobExpiration, setBlobMimetype, setBlobSize } from "./db.js";
import { getExpirationTime, getFileRule } from "./storage/rules.js";

const log = debug("cdn");
const app = new Koa();
const router = new Router();

async function handlePointers(ctx: Koa.ParameterizedContext, pointers: BlobPointer[]) {
  for (const pointer of pointers) {
    try {
      if (pointer.type === "http") {
        const stream = await httpTransport.readHTTPPointer(pointer);
        if (pointer.mimeType) ctx.type = pointer.mimeType;
        const pass = (ctx.body = new PassThrough());
        stream.pipe(pass);

        fileStorage.saveFile(pointer.hash, stream, pointer.metadata);
        return true;
      }
    } catch (e) {}
  }

  return false;
}

function getBlobURL(hash: string) {
  const mimeType = db.data.blobs[hash]?.mimeType;
  const ext = mimeType && mime.getExtension(mimeType);
  return new URL(hash + (ext ? "." + ext : ""), config.publicDomain).toString();
}

// set CORS headers
app.use(
  cors({
    origin: "*",
    allowMethods: "*",
    allowHeaders: "Authorization,*",
    exposeHeaders: "*",
  }),
);

// fetch blobs
router.get("/:hash", async (ctx, next) => {
  const match = ctx.path.match(/([0-9a-f]{64})(\.[a-z]+)?/);
  if (!match) return next();

  const hash = match[1];
  const ext = match[2] || undefined;
  const searchParams = new URLSearchParams(ctx.search);

  const search: BlobSearch = {
    hash,
    ext,
    pubkey: searchParams.get("pubkey") ?? undefined,
  };

  log("Looking for", search.hash);

  const filePointer = await fileStorage.search(search);
  if (filePointer) {
    ctx.type = filePointer.ext;
    ctx.body = await fileStorage.readFilePointer(filePointer);
    return;
  }

  if (config.discovery.nostr.enabled) {
    let pointers = await nostrDiscovery.search(search);
    if (pointers.length) {
      const handled = await handlePointers(ctx, pointers);
      if (handled) return;
    }
  }

  if (config.discovery.upstream.enabled) {
    const cdnSource = await cdnDiscovery.search(search);
    if (cdnSource) {
      if (search.ext) ctx.type = search.ext;
      const pass = (ctx.body = new PassThrough());
      cdnSource.pipe(pass);
      fileStorage.saveFile(hash, cdnSource, {
        mimeType: ext ? mime.getType(ext) ?? undefined : undefined,
      });
    }
  }

  if (!ctx.body) {
    ctx.status = 404;
  }
});
``;

// upload blobs
router.put("/upload", async (ctx) => {
  if (!config.upload.enabled) {
    ctx.status = 403;
    ctx.body = "Uploads disabled";
    return;
  }

  // handle upload
  try {
    const contentType = ctx.header["content-type"];
    const auth = (ctx.headers["authorization"] || ctx.query.auth) as string | undefined;
    const authEvent = auth ? (JSON.parse(auth) as NostrEvent) : undefined;
    if (config.upload.requireAuth && !authEvent) {
      ctx.status = 403;
      ctx.body = "Missing Authorization header";
      return;
    }

    const pubkey = authEvent?.pubkey;
    const authSize = authEvent ? parseInt(authEvent.tags.find((t) => t[0] === "size")?.[1] || "NaN") : undefined;

    const rule = getFileRule(
      {
        mimeType: contentType,
        // pubkey: metadata?.pubkey,
      },
      config.upload.rules,
    );
    if (!rule) {
      ctx.status = 403;
      return;
    }

    const metadata = await uploadModule.uploadWriteStream(ctx.req);
    const mimeType = contentType || metadata.mimeType;

    if (config.upload.requireAuth && metadata.size !== authSize) {
      ctx.status = 403;
      ctx.body = "Incorrect upload size";
      await pfs.rm(metadata.tempFile);
      return;
    }

    // save the file if its not already there
    if (!db.data.blobs[metadata.hash]) {
      setBlobSize(metadata.hash, metadata.size);
      setBlobExpiration(metadata.hash, getExpirationTime(rule));
      if (mimeType) setBlobMimetype(metadata.hash, mimeType);

      await fileStorage.saveTempFile(metadata.hash, metadata.tempFile, mimeType);
    } else {
      await pfs.rm(metadata.tempFile);
    }

    if (pubkey) addPubkeyToBlob(metadata.hash, pubkey);

    ctx.status = 200;
    ctx.body = {
      url: getBlobURL(metadata.hash),
      created: db.data.blobs[metadata.hash].created,
      sha256: metadata.hash,
      type: mimeType,
      size: metadata.size,
    };
  } catch (e) {
    ctx.status = 403;
    if (e instanceof Error) ctx.body = e.message;
  }
});

// list blobs
router.get("/list", async (ctx) => {
  const filter = ctx.query as { pubkey?: string };

  ctx.status = 200;
  ctx.body = Object.entries(db.data.blobs)
    .filter(([hash, blob]) => (filter.pubkey ? blob.pubkeys?.includes(filter.pubkey) : true))
    .map(([hash, blob]) => ({
      sha256: hash,
      created: blob.created,
      url: getBlobURL(hash),
      type: blob.mimeType,
      size: blob.size,
    }));
});

app.use(router.routes()).use(router.allowedMethods());
app.use(serve(path.join(process.cwd(), "public")));

app.listen(3000);

setInterval(() => fileStorage.prune(), 1000 * 30);

async function shutdown() {
  log("Saving database...");
  await db.write();
  process.exit(0);
}

process.addListener("SIGTERM", shutdown);
process.addListener("SIGINT", shutdown);
