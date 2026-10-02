import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual, randomUUID, createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  prepareResponsesRequest,
  parseClaudeDecision,
  decisionToResponse,
  responseToSse,
  ProtocolError,
  type GatewayResponse,
} from "./protocol.js";
import { GatewayError, runClaude, type ClaudeRunOptions, type ClaudeRunResult } from "./runner.js";
import {
  prepareGptInteropRequest,
  restoreGptInteropJsonResponse,
  restoreGptInteropSse,
} from "./gpt-interop.js";

export interface GatewayConfig {
  host: "127.0.0.1";
  port: number;
  token: string;
  claudeCommand: string;
  workingDirectory: string;
  models: Record<string, string>;
  maxClaudeConcurrency?: number;
  maxQueuedRequests?: number;
  timeoutMs?: number;
}
export interface GatewayDependencies {
  inference?: (options: ClaudeRunOptions) => Promise<ClaudeRunResult>;
  upstream?: typeof fetch;
}

const MAX_BODY = 48 * 1024 * 1024;
const HOP_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailer",
  "x-native-gateway-token",
  "origin",
  "referer",
]);

function errorResponse(res: ServerResponse, error: unknown) {
  const known = error instanceof GatewayError;
  const protocol = error instanceof ProtocolError;
  const status = known
    ? error.status
    : protocol
      ? error.code === "invalid_model_output"
        ? 502
        : error.status
      : 502;
  const message = known || protocol ? error.message : "Model gateway could not finish this request";
  const code = known || protocol ? error.code : "gateway_error";
  if (res.headersSent) {
    res.write(
      `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "gateway_error", code, message } })}\n\n`,
    );
    res.end();
  } else {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "gateway_error", code, message } }));
  }
}

export function createGateway(config: GatewayConfig, dependencies: GatewayDependencies = {}) {
  if (
    config.host !== "127.0.0.1" ||
    !Number.isInteger(config.port) ||
    config.port < 0 ||
    config.port > 65535 ||
    config.token.length < 32
  )
    throw new Error("Invalid loopback gateway configuration");
  const infer = dependencies.inference ?? runClaude;
  const upstream = dependencies.upstream ?? fetch;
  const maxConcurrency = config.maxClaudeConcurrency ?? 2;
  const maxQueue = config.maxQueuedRequests ?? 16;
  let active = 0;
  const controllers = new Set<AbortController>();
  const handlers = new Set<Promise<void>>();
  const queue: {
    resolve: () => void;
    reject: (error: Error) => void;
    signal: AbortSignal;
    abort: () => void;
  }[] = [];
  const metrics = { gptRequests: 0, claudeRequests: 0, failures: 0 };
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () =>
    (shutdownPromise ??= (async () => {
      const pending = [...handlers];
      for (const controller of controllers) controller.abort();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await Promise.all([closed, ...pending]);
    })());
  const completed = new Map<string, { expires: number; response: GatewayResponse; size: number }>();
  let cachedBytes = 0;
  let claudeBlocked = false;
  async function acquire(signal: AbortSignal) {
    if (signal.aborted) throw new GatewayError("Request cancelled", 499, "cancelled");
    if (active < maxConcurrency) {
      active++;
      return;
    }
    if (queue.length >= maxQueue)
      throw new GatewayError("Claude inference queue is full", 429, "queue_full");
    await new Promise<void>((resolve, reject) => {
      const job = { resolve, reject, signal, abort: () => {} };
      job.abort = () => {
        const index = queue.indexOf(job);
        if (index >= 0) queue.splice(index, 1);
        reject(new GatewayError("Request cancelled", 499, "cancelled"));
      };
      queue.push(job);
      signal.addEventListener("abort", job.abort, { once: true });
    });
  }
  function release() {
    const next = queue.shift();
    if (next) {
      next.signal.removeEventListener("abort", next.abort);
      next.resolve();
    } else active--;
  }
  function authorized(req: IncomingMessage) {
    const supplied = req.headers["x-native-gateway-token"];
    if (typeof supplied !== "string") return false;
    const a = Buffer.from(supplied),
      b = Buffer.from(config.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  const server = http.createServer(async (req, res) => {
    if (req.headers.origin || !authorized(req)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
    if (req.method === "GET" && pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          version: "0.5.0-native.1",
          ready: !claudeBlocked && !shutdownPromise,
          models: Object.keys(config.models),
          active,
          queued: queue.length,
          ...metrics,
        }),
      );
      return;
    }
    if (req.method === "POST" && pathname === "/shutdown") {
      res.once("finish", () => {
        void shutdown();
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"stopping":true}');
      return;
    }
    if (req.method !== "POST" || !/^\/(v1\/)?responses(?:\/compact)?$/.test(pathname)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const controller = new AbortController();
    controllers.add(controller);
    let settled!: () => void;
    const completion = new Promise<void>((resolve) => {
      settled = resolve;
    });
    handlers.add(completion);
    req.on("aborted", () => controller.abort());
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    let acquired = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY)
          throw new GatewayError("Request exceeds 48 MiB", 413, "request_too_large");
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      if (req.headers["content-encoding"])
        throw new GatewayError(
          "Request compression is not enabled for this provider",
          415,
          "unsupported_encoding",
        );
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        throw new GatewayError("Request body must be valid JSON", 400, "invalid_request_error");
      }
      const model = typeof parsed.model === "string" ? parsed.model : "";
      const claudeModel = Object.hasOwn(config.models, model) ? config.models[model] : undefined;
      if (!claudeModel) {
        if (!/^gpt-[\w.-]+$/.test(model) && model !== "codex-auto-review")
          throw new GatewayError("Model is not configured", 400, "unknown_model");
        if (
          !req.headers.authorization?.startsWith("Bearer ") ||
          typeof req.headers["chatgpt-account-id"] !== "string" ||
          !req.headers["chatgpt-account-id"].trim()
        )
          throw new GatewayError(
            "Codex must provide its existing ChatGPT subscription authentication",
            401,
            "authentication_required",
          );
        const base = "https://chatgpt.com/backend-api/codex";
        const target = base + (pathname.endsWith("/compact") ? "/responses/compact" : "/responses");
        const interop = pathname.endsWith("/compact")
          ? { body, aliased: false }
          : prepareGptInteropRequest(body);
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (HOP_HEADERS.has(key) || key === "content-length" || value === undefined) continue;
          headers.set(key, Array.isArray(value) ? value.join(", ") : value);
        }
        metrics.gptRequests++;
        const upstreamRes = await upstream(target, {
          method: "POST",
          headers,
          body: new Uint8Array(interop.body),
          redirect: "error",
          signal: controller.signal,
        });
        const outputHeaders: Record<string, string> = {};
        upstreamRes.headers.forEach((value, key) => {
          if (!HOP_HEADERS.has(key) && key !== "content-length" && key !== "content-encoding")
            outputHeaders[key] = value;
        });
        if (!outputHeaders["content-type"])
          outputHeaders["content-type"] =
            upstreamRes.ok && parsed.stream === true ? "text/event-stream" : "application/json";
        if (interop.aliased) {
          delete outputHeaders.etag;
          delete outputHeaders["content-md5"];
          delete outputHeaders.digest;
        }
        if (interop.aliased && upstreamRes.ok && parsed.stream !== true) {
          const value = restoreGptInteropJsonResponse(await upstreamRes.json(), true);
          res.writeHead(upstreamRes.status, outputHeaders);
          res.end(JSON.stringify(value));
          return;
        }
        res.writeHead(upstreamRes.status, outputHeaders);
        if (upstreamRes.body)
          await new Promise<void>((resolve, reject) => {
            const source = Readable.fromWeb(
              upstreamRes.body as import("node:stream/web").ReadableStream,
            );
            const stream =
              interop.aliased && upstreamRes.ok
                ? Readable.from(restoreGptInteropSse(source, { aliased: true }))
                : source;
            stream.on("error", reject);
            res.on("finish", resolve);
            res.on("close", resolve);
            stream.pipe(res);
          });
        else res.end();
        return;
      }
      if (pathname.endsWith("/compact"))
        throw new GatewayError(
          "Use Codex local compaction for Claude models",
          400,
          "unsupported_compaction",
        );
      if (claudeBlocked)
        throw new GatewayError(
          "Claude worker termination was uncertain; restart the gateway",
          503,
          "termination_unknown",
        );
      const prepared = prepareResponsesRequest(parsed);
      metrics.claudeRequests++;
      const cacheKey = createHash("sha256").update(body).digest("hex");
      for (const [key, entry] of completed) {
        if (entry.expires < Date.now()) {
          cachedBytes -= entry.size;
          completed.delete(key);
        }
      }
      const cached = completed.get(cacheKey);
      if (cached) {
        if (parsed.stream === true) {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          res.end(responseToSse(cached.response));
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(cached.response));
        }
        return;
      }
      if (parsed.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(": inference pending\n\n");
        heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 10_000);
      }
      await acquire(controller.signal);
      acquired = true;
      const reasoning = parsed.reasoning as { effort?: string } | undefined;
      const effort =
        reasoning?.effort === "low"
          ? "low"
          : reasoning?.effort === "medium"
            ? "medium"
            : reasoning?.effort === "max" || reasoning?.effort === "ultra"
              ? "max"
              : "high";
      const result = await infer({
        command: config.claudeCommand,
        cwd: config.workingDirectory,
        model: claudeModel,
        prompt: prepared.prompt,
        content: prepared.content,
        schema: prepared.outputSchema,
        signal: controller.signal,
        timeoutMs: config.timeoutMs,
        effort,
      });
      const decision = parseClaudeDecision(result.decision, prepared);
      const response = decisionToResponse(decision, prepared, {
        id: "resp_" + randomUUID().replaceAll("-", ""),
        usage: result.usage,
      });
      const responseSize = Buffer.byteLength(JSON.stringify(response));
      if (responseSize <= 4 * 1024 * 1024) {
        while (completed.size >= 64 || cachedBytes + responseSize > 32 * 1024 * 1024) {
          const oldest = completed.keys().next().value;
          if (!oldest) break;
          cachedBytes -= completed.get(oldest)!.size;
          completed.delete(oldest);
        }
        completed.set(cacheKey, { expires: Date.now() + 120_000, response, size: responseSize });
        cachedBytes += responseSize;
      }
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
      if (parsed.stream === true) {
        res.end(responseToSse(response));
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(response));
      }
    } catch (error) {
      metrics.failures++;
      if (error instanceof GatewayError && error.code === "termination_unknown")
        claudeBlocked = true;
      if (controller.signal.aborted) res.destroy();
      else errorResponse(res, error);
    } finally {
      controllers.delete(controller);
      if (heartbeat) clearInterval(heartbeat);
      if (acquired) release();
      handlers.delete(completion);
      settled();
    }
  });
  return {
    server,
    metrics,
    shutdown,
    listen: () =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, resolve);
      }),
  };
}
