import { describe, expect, it } from "vitest";
import {
  prepareGptInteropRequest,
  restoreGptInteropJsonResponse,
  restoreGptInteropSse,
} from "../src/native-gateway/gpt-interop.js";

const dispatch = (name: string) => ({
  type: "function",
  name,
  description: "Public synthetic dispatch",
  parameters: {
    type: "object",
    properties: {
      message: { type: "string", description: "Synthetic message", encrypted: true },
      model: { type: "string", enum: ["claude-opus"] },
    },
    required: ["message"],
    additionalProperties: false,
  },
});
const namespace = {
  type: "namespace",
  name: "collaboration",
  tools: [
    dispatch("spawn_agent"),
    dispatch("send_message"),
    dispatch("followup_task"),
    dispatch("list_agents"),
  ],
};
const argumentsText = '{"message":"你好 🌆\\nSYNTHETIC_DISPATCH","model":"claude-opus"}';
const call = (extra: Record<string, unknown> = {}) => ({
  type: "function_call",
  id: "fc_synthetic",
  call_id: "call_synthetic",
  name: "spawn_agent",
  namespace: "native_collaboration",
  arguments: argumentsText,
  ...extra,
});

async function collect(source: AsyncIterable<Uint8Array>, maxEventBytes?: number) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of restoreGptInteropSse(source, { aliased: true, maxEventBytes }))
    chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
async function* chunks(bytes: Buffer, width = bytes.length) {
  for (let index = 0; index < bytes.length; index += width)
    yield bytes.subarray(index, index + width);
}
function dataEvents(text: string) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
}

describe("GPT native collaboration interoperability", () => {
  it("preserves unrelated requests byte for byte, including an existing user alias", () => {
    const body = Buffer.from(
      ' { "model": "gpt-synthetic", "tools": [{"type":"namespace","name":"native_collaboration","tools":[]}], "input": "untouched" }\n',
    );
    const result = prepareGptInteropRequest(body);
    expect(result).toEqual({ body, aliased: false });
    expect(result.body).toBe(body);
  });
  it("aliases only the namespace and three dispatch annotations, retaining other schema constraints", () => {
    const original = {
      tools: [namespace],
      input: "Synthetic",
      instructions: "Original harness instruction",
    };
    const mapped = JSON.parse(
      prepareGptInteropRequest(Buffer.from(JSON.stringify(original))).body.toString(),
    );
    expect(original.tools[0].name).toBe("collaboration");
    expect(mapped.tools[0].name).toBe("native_collaboration");
    for (let index = 0; index < 3; index++)
      expect(mapped.tools[0].tools[index]).toEqual({
        ...namespace.tools[index],
        parameters: {
          ...namespace.tools[index].parameters,
          properties: {
            ...namespace.tools[index].parameters.properties,
            message: { ...namespace.tools[index].parameters.properties.message, encrypted: false },
          },
        },
      });
    expect(mapped.tools[0].tools[3]).toEqual(namespace.tools[3]);
    expect(mapped.instructions).toContain("Original harness instruction\n\n");
    expect(mapped.instructions).toContain("native_collaboration");
  });
  it("keeps a continued tool conversation connected without altering arguments, results or hidden reasoning", () => {
    const input = [
      {
        type: "function_call",
        namespace: "collaboration",
        name: "spawn_agent",
        call_id: "same_call",
        arguments: argumentsText,
      },
      {
        type: "function_call_output",
        call_id: "same_call",
        output: '{"namespace":"collaboration","value":"literal"}',
      },
      { type: "reasoning", encrypted_content: "opaque-synthetic-reasoning", summary: [] },
      {
        type: "agent_message",
        content: [{ type: "input_text", text: "Keep collaboration in narrative text" }],
      },
    ];
    const request = {
      tools: [namespace],
      input,
      tool_choice: {
        type: "allowed_tools",
        mode: "auto",
        tools: [{ type: "function", namespace: "collaboration", name: "spawn_agent" }],
      },
    };
    const mapped = JSON.parse(
      prepareGptInteropRequest(Buffer.from(JSON.stringify(request))).body.toString(),
    );
    expect(mapped.input[0]).toEqual({ ...input[0], namespace: "native_collaboration" });
    expect(mapped.input.slice(1)).toEqual(input.slice(1));
    expect(mapped.tool_choice.tools[0]).toEqual({
      ...request.tool_choice.tools[0],
      namespace: "native_collaboration",
    });
  });
  it("refuses alias collisions without exposing the request payload", () => {
    const secret = "SYNTHETIC_PRIVATE_TEXT";
    const body = Buffer.from(
      JSON.stringify({
        instructions: secret,
        tools: [namespace, { type: "namespace", name: "native_collaboration", tools: [] }],
      }),
    );
    try {
      prepareGptInteropRequest(body);
      throw new Error("Expected alias collision");
    } catch (error) {
      expect(error).toMatchObject({ status: 400, code: "gpt_interop_alias_collision" });
      expect(String(error)).not.toContain(secret);
    }
  });
  it.each([undefined, null, []])(
    "restores plain dispatch calls and explicit empty encryption metadata",
    (encrypted) => {
      const item = call(encrypted === undefined ? {} : { encrypted_function_args: encrypted });
      const response = {
        id: "resp_synthetic",
        output: [item, { type: "reasoning", encrypted_content: "opaque-keep" }],
      };
      const mapped = restoreGptInteropJsonResponse(response, true) as typeof response;
      expect(mapped.output[0]).toEqual({
        ...item,
        namespace: "collaboration",
        encrypted_function_args: [],
      });
      expect(mapped.output[0].arguments).toBe(argumentsText);
      expect(mapped.output[1]).toBe(response.output[1]);
      expect(restoreGptInteropJsonResponse(response, false)).toBe(response);
    },
  );
  it.each([[{ ciphertext: "SYNTHETIC_OPAQUE" }], { ciphertext: "SYNTHETIC_OPAQUE" }])(
    "refuses opaque dispatch metadata instead of relabeling it as plaintext",
    (encrypted) => {
      expect(() =>
        restoreGptInteropJsonResponse(
          { output: [call({ encrypted_function_args: encrypted })] },
          true,
        ),
      ).toThrow("opaque collaboration dispatch arguments");
    },
  );
  it("restores added, done, and completed consistently across every UTF-8 byte boundary", async () => {
    const untouched =
      ': 🌆 comment\r\nevent: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"你好 🌆"}\r\n\r\n';
    const events = [
      { type: "response.output_item.added", item: call({ arguments: "" }) },
      { type: "response.output_item.done", item: call() },
      {
        type: "response.completed",
        response: { output: [call(), { type: "reasoning", encrypted_content: "opaque-keep" }] },
      },
    ];
    const raw = Buffer.from(
      untouched +
        events
          .map(
            (event) =>
              `: retained\r\nevent: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`,
          )
          .join(""),
    );
    const text = await collect(chunks(raw, 1));
    expect(text.startsWith(untouched)).toBe(true);
    expect(text.match(/: retained/g)).toHaveLength(3);
    const parsed = dataEvents(text).slice(1);
    for (const event of parsed) {
      const item = event.item ?? event.response.output[0];
      expect(item.namespace).toBe("collaboration");
      expect(item.encrypted_function_args).toEqual([]);
    }
    expect(parsed[1].item.arguments).toBe(argumentsText);
    expect(parsed[2].response.output[1].encrypted_content).toBe("opaque-keep");
  });
  it("preserves comments within multiline data and mixed line endings", async () => {
    const source = `event: response.output_item.done\rdata: {"type":"response.output_item.done",\r: middle comment\rdata: "item":${JSON.stringify(call())}}\r\r`;
    const result = await collect(chunks(Buffer.from(source), 3));
    expect(result).toContain(": middle comment\r");
    expect(result.endsWith("\r\r")).toBe(true);
    expect(
      JSON.parse(
        result
          .split("\r")
          .find((line) => line.startsWith("data: "))!
          .slice(6),
      ).item.namespace,
    ).toBe("collaboration");
  });
  it("yields a completed event without waiting for later network chunks", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function* source() {
      yield Buffer.from(": ready\n\n");
      await gate;
      yield Buffer.from(": later\n\n");
    }
    const output = restoreGptInteropSse(source(), { aliased: true });
    expect(Buffer.from((await output.next()).value!).toString()).toBe(": ready\n\n");
    release();
    expect(Buffer.from((await output.next()).value!).toString()).toBe(": later\n\n");
  });
  it("passes unrelated streams through without event decoding or copying", async () => {
    const original = Buffer.from(": passthrough\n\n");
    const output = restoreGptInteropSse(chunks(original), { aliased: false });
    expect((await output.next()).value?.buffer).toBe(original.buffer);
  });
  it("bounds a single event and rejects opaque dispatch events without revealing payloads", async () => {
    await expect(
      collect(chunks(Buffer.from("data: " + "x".repeat(65)), 1), 64),
    ).rejects.toMatchObject({ code: "gpt_interop_event_limit" });
    const event = Buffer.from(
      `data: ${JSON.stringify({ type: "response.output_item.done", item: call({ encrypted_function_args: ["SYNTHETIC_OPAQUE"] }) })}\n\n`,
    );
    try {
      await collect(chunks(event, 2));
      throw new Error("Expected opaque rejection");
    } catch (error) {
      expect(error).toMatchObject({ code: "gpt_interop_opaque_dispatch" });
      expect(String(error)).not.toContain("SYNTHETIC_OPAQUE");
    }
  });
});
