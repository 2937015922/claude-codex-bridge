import { afterEach, describe, expect, it } from "vitest";
import { createGateway, type GatewayDependencies } from "../src/native-gateway/server.js";
import { GatewayError } from "../src/native-gateway/runner.js";
import type { AddressInfo } from "node:net";

const token = "synthetic-only-capability-12345678901234567890";
const servers: ReturnType<typeof createGateway>[] = [];
const baseRequest = {
  model: "claude-opus",
  instructions: "Synthetic test",
  input: [{ role: "user", content: "Return a synthetic result." }],
  tools: [],
};
const success = {
  decision: { kind: "final", text: "synthetic-result", calls: [] },
  model: "synthetic-opus",
  usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
};
async function start(dependencies: GatewayDependencies = {}, concurrency = 2) {
  const gateway = createGateway(
    {
      host: "127.0.0.1",
      port: 0,
      token,
      claudeCommand: "C:/synthetic/claude.exe",
      workingDirectory: "C:/synthetic",
      models: { "claude-opus": "opus" },
      maxClaudeConcurrency: concurrency,
    },
    { inference: async () => success, ...dependencies },
  );
  servers.push(gateway);
  await gateway.listen();
  return `http://127.0.0.1:${(gateway.server.address() as AddressInfo).port}`;
}
function request(body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) {
  return {
    method: "POST",
    headers: { "content-type": "application/json", "x-native-gateway-token": token, ...headers },
    body: JSON.stringify(body),
    signal,
  };
}
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (gateway) =>
        new Promise<void>((resolve) => {
          gateway.server.close(resolve);
          gateway.server.closeAllConnections();
        }),
    ),
  );
});

describe("native model gateway", () => {
  it("requires the local capability and refuses browser-origin requests", async () => {
    const url = await start();
    expect((await fetch(url + "/health")).status).toBe(403);
    expect(
      (
        await fetch(url + "/health", {
          headers: { "x-native-gateway-token": token, origin: "https://synthetic.invalid" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await fetch(url + "/health", { headers: { "x-native-gateway-token": token } })).status,
    ).toBe(200);
  });
  it("returns a real Responses message and consistent usage", async () => {
    const url = await start();
    const response = await fetch(url + "/v1/responses", request(baseRequest));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.output[0].content[0].text).toBe("synthetic-result");
    expect(body.usage.total_tokens).toBe(7);
  });
  it("preserves native function namespaces and emits executable calls only after validation", async () => {
    const url = await start({
      inference: async () => ({
        ...success,
        decision: {
          kind: "tool_calls",
          text: "",
          calls: [{ tool_id: "tool_0", input: '{"value":42}' }],
        },
      }),
    });
    const response = await fetch(
      url + "/v1/responses",
      request({
        ...baseRequest,
        tools: [
          {
            type: "namespace",
            name: "synthetic",
            tools: [
              {
                type: "function",
                name: "read",
                parameters: {
                  type: "object",
                  properties: { value: { type: "integer" } },
                  required: ["value"],
                  additionalProperties: false,
                },
              },
            ],
          },
        ],
      }),
    );
    const body = await response.json();
    expect(body.output[0]).toMatchObject({
      type: "function_call",
      name: "read",
      namespace: "synthetic",
      arguments: '{"value":42}',
    });
  });
  it("never passes OpenAI credentials into Claude inference options", async () => {
    let received: unknown;
    const url = await start({
      inference: async (options) => {
        received = options;
        return success;
      },
    });
    await fetch(
      url + "/v1/responses",
      request(baseRequest, {
        authorization: "Bearer synthetic-credential",
        "chatgpt-account-id": "synthetic-account",
      }),
    );
    expect(JSON.stringify(received)).not.toContain("synthetic-credential");
    expect(JSON.stringify(received)).not.toContain("synthetic-account");
  });
  it("forwards GPT bytes and status only to the fixed official endpoint", async () => {
    let target: unknown;
    let options: RequestInit | undefined;
    const url = await start({
      upstream: (async (url, init) => {
        target = url;
        options = init;
        return new Response("synthetic-rate-limit", {
          status: 429,
          headers: { "content-type": "text/event-stream", "retry-after": "1" },
        });
      }) as typeof fetch,
    });
    const input = {
      model: "gpt-synthetic",
      input: [{ role: "user", content: "Synthetic request" }],
      custom_passthrough_field: 42,
    };
    const response = await fetch(
      url + "/v1/responses",
      request(input, {
        authorization: "Bearer synthetic-credential",
        "chatgpt-account-id": "synthetic-account",
      }),
    );
    expect(target).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(Buffer.from(options!.body as Buffer).toString()).toBe(JSON.stringify(input));
    expect(new Headers(options!.headers).get("authorization")).toBe("Bearer synthetic-credential");
    expect(new Headers(options!.headers).has("x-native-gateway-token")).toBe(false);
    expect(options!.redirect).toBe("error");
    expect(response.status).toBe(429);
    expect(await response.text()).toBe("synthetic-rate-limit");
  });
  it("does not send unconfigured model requests to an arbitrary provider", async () => {
    let called = false;
    const url = await start({
      upstream: (async () => {
        called = true;
        return new Response();
      }) as typeof fetch,
    });
    expect(
      (await fetch(url + "/v1/responses", request({ ...baseRequest, model: "arbitrary-model" })))
        .status,
    ).toBe(400);
    expect(called).toBe(false);
  });
  it("rejects an API-key route rather than switching to separately billed OpenAI API", async () => {
    let called = false;
    const url = await start({
      upstream: (async () => {
        called = true;
        return new Response();
      }) as typeof fetch,
    });
    expect(
      (
        await fetch(
          url + "/v1/responses",
          request(
            { model: "gpt-synthetic", input: "Synthetic" },
            { authorization: "Bearer synthetic-api-key" },
          ),
        )
      ).status,
    ).toBe(401);
    expect(called).toBe(false);
  });
  it("replays the same validated call IDs after a completed request is retried", async () => {
    let count = 0;
    const url = await start({
      inference: async () => {
        count++;
        return {
          ...success,
          decision: { kind: "tool_calls", text: "", calls: [{ tool_id: "tool_0", input: "{}" }] },
        };
      },
    });
    const input = {
      ...baseRequest,
      tools: [
        {
          type: "function",
          name: "synthetic_read",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
    };
    const first = await (await fetch(url + "/v1/responses", request(input))).json();
    const retry = await (await fetch(url + "/v1/responses", request(input))).json();
    expect(retry.output[0].call_id).toBe(first.output[0].call_id);
    expect(retry.id).toBe(first.id);
    expect(count).toBe(1);
  });
  it("emits valid SSE and does not expose provider errors or private payloads", async () => {
    const url = await start();
    const response = await fetch(url + "/v1/responses", request({ ...baseRequest, stream: true }));
    const text = await response.text();
    expect(text).toContain("event: response.output_text.delta");
    expect(text).toContain("event: response.completed");
    const bad = await start({
      inference: async () => {
        throw new Error("synthetic-secret-context");
      },
    });
    const failure = await fetch(bad + "/v1/responses", request(baseRequest));
    expect(await failure.text()).not.toContain("synthetic-secret-context");
  });
  it("keeps concurrent native conversations separate and serializes to the configured worker limit", async () => {
    let active = 0,
      maximum = 0;
    const prompts: string[] = [];
    const url = await start(
      {
        inference: async (options) => {
          active++;
          maximum = Math.max(maximum, active);
          prompts.push(options.prompt);
          await new Promise((resolve) => setTimeout(resolve, 20));
          active--;
          return success;
        },
      },
      1,
    );
    await Promise.all(
      ["SYNTHETIC_A", "SYNTHETIC_B"].map((value) =>
        fetch(url + "/v1/responses", request({ ...baseRequest, input: value })).then((response) =>
          response.json(),
        ),
      ),
    );
    expect(maximum).toBe(1);
    expect(prompts[0]).toContain("SYNTHETIC_A");
    expect(prompts[0]).not.toContain("SYNTHETIC_B");
    expect(prompts[1]).toContain("SYNTHETIC_B");
  });
  it("cancels owned inference when the native caller disconnects", async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let cancelled!: () => void;
    const stopped = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    const url = await start({
      inference: (options) =>
        new Promise((_resolve, reject) => {
          started();
          options.signal.addEventListener(
            "abort",
            () => {
              cancelled();
              reject(new GatewayError("cancelled", 499));
            },
            { once: true },
          );
        }),
    });
    const controller = new AbortController();
    const response = fetch(
      url + "/v1/responses",
      request(baseRequest, {}, controller.signal),
    ).catch(() => {});
    await ready;
    controller.abort();
    await stopped;
    await response;
  });
  it("shutdown closes active and queued SSE requests without starting a queued worker", async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let cancelled!: () => void;
    const stopped = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    let runs = 0;
    const url = await start(
      {
        inference: (options) =>
          new Promise((_resolve, reject) => {
            runs++;
            started();
            options.signal.addEventListener(
              "abort",
              () => {
                cancelled();
                reject(new GatewayError("cancelled", 499));
              },
              { once: true },
            );
          }),
      },
      1,
    );
    const active = await fetch(
      url + "/v1/responses",
      request({ ...baseRequest, input: "SYNTHETIC_ACTIVE", stream: true }),
    );
    await ready;
    const queued = await fetch(
      url + "/v1/responses",
      request({ ...baseRequest, input: "SYNTHETIC_QUEUED", stream: true }),
    );
    const health = await (
      await fetch(url + "/health", { headers: { "x-native-gateway-token": token } })
    ).json();
    expect(health).toMatchObject({ active: 1, queued: 1 });
    const consume = async (response: Response) => {
      try {
        await response.text();
      } catch {}
    };
    const bodies = Promise.all([consume(active), consume(queued)]);
    const shutdown = await fetch(url + "/shutdown", request({}));
    expect(await shutdown.json()).toEqual({ stopping: true });
    await stopped;
    let timer!: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([
        bodies,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("SSE streams did not close on shutdown")),
            1000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    expect(runs).toBe(1);
    expect(servers[servers.length - 1].server.listening).toBe(false);
  });
  it("cancels only the disconnected queued SSE caller and preserves the active worker", async () => {
    let finish!: () => void;
    let runs = 0;
    let activeCancelled = false;
    const url = await start(
      {
        inference: (options) =>
          new Promise((resolve) => {
            runs++;
            finish = () => resolve(success);
            options.signal.addEventListener(
              "abort",
              () => {
                activeCancelled = true;
              },
              { once: true },
            );
          }),
      },
      1,
    );
    const active = await fetch(
      url + "/v1/responses",
      request({ ...baseRequest, input: "SYNTHETIC_KEEP_ACTIVE", stream: true }),
    );
    const caller = new AbortController();
    const queued = await fetch(
      url + "/v1/responses",
      request({ ...baseRequest, input: "SYNTHETIC_CANCEL_QUEUE", stream: true }, {}, caller.signal),
    );
    const consumed = queued.text().catch(() => "cancelled");
    caller.abort();
    await consumed;
    for (let attempt = 0; attempt < 20; attempt++) {
      const health = await (
        await fetch(url + "/health", { headers: { "x-native-gateway-token": token } })
      ).json();
      if (health.queued === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const health = await (
      await fetch(url + "/health", { headers: { "x-native-gateway-token": token } })
    ).json();
    expect(health).toMatchObject({ active: 1, queued: 0 });
    expect(activeCancelled).toBe(false);
    finish();
    expect(await active.text()).toContain("event: response.completed");
    expect(runs).toBe(1);
  });
  it("waits for active worker cleanup before shutdown completes", async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let abortReceived!: () => void;
    const abortRequested = new Promise<void>((resolve) => {
      abortReceived = resolve;
    });
    let finishCleanup!: () => void;
    const url = await start({
      inference: (options) =>
        new Promise((_resolve, reject) => {
          started();
          options.signal.addEventListener(
            "abort",
            () => {
              // A real worker's taskkill/close acknowledgment can arrive after port closure.
              finishCleanup = () => reject(new GatewayError("cancelled", 499));
              abortReceived();
            },
            { once: true },
          );
        }),
    });
    const response = await fetch(
      url + "/v1/responses",
      request({ ...baseRequest, input: "SYNTHETIC_STOP_ACK", stream: true }),
    );
    await ready;
    const body = response.text().catch(() => "disconnected");
    const gateway = servers[servers.length - 1];
    const portClosed = new Promise<void>((resolve) => {
      gateway.server.once("close", resolve);
    });
    let completed = false;
    const shutdown = gateway.shutdown().then(() => {
      completed = true;
    });
    await abortRequested;
    await portClosed;
    await Promise.resolve();
    const completedBeforeWorkerStopped = completed;
    finishCleanup();
    await shutdown;
    await body;
    expect(completedBeforeWorkerStopped).toBe(false);
  });
});
