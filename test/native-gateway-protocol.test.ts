import { describe, expect, it } from "vitest";
import {
  CLAUDE_DECISION_SCHEMA,
  ProtocolError,
  decisionToResponse,
  parseClaudeDecision,
  prepareResponsesRequest,
  responseToSse,
  responseToSseEvents,
  type ClaudeDecision,
} from "../src/native-gateway/protocol.js";

const functionTool = {
  type: "function",
  name: "lookup_synthetic",
  description: "Read a fictional value.",
  parameters: {
    type: "object",
    properties: { key: { type: "string", minLength: 2 } },
    required: ["key"],
    additionalProperties: false,
  },
};
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS6cAAAAASUVORK5CYII=";
function request(overrides: Record<string, unknown> = {}) {
  return {
    model: "claude-opus",
    input: "Find a synthetic value",
    tools: [functionTool],
    ...overrides,
  };
}
const call = (input = '{"key":"demo"}', toolId = "tool_0"): ClaudeDecision => ({
  kind: "tool_calls",
  text: "",
  calls: [{ tool_id: toolId, input }],
});

describe("native gateway Responses protocol", () => {
  it("preserves native agent_message authors, recipients, ordered text, and routes", () => {
    const metadata = { turn_id: "SYNTHETIC_PRIVATE_AGENT_TURN", create_time: 123.25 };
    const dispatched = {
      type: "agent_message",
      id: "agent_msg_synthetic",
      author: "parent_agent",
      recipient: "child_agent",
      content: [
        { type: "input_text", text: "Read the fictional tool value.\nPreserve this second line." },
        { type: "input_text", text: "然后报告合成结果 🌆" },
      ],
      internal_chat_message_metadata_passthrough: metadata,
    };
    const report = {
      type: "agent_message",
      author: "child_agent",
      recipient: "parent_agent",
      content: [{ type: "input_text", text: "Synthetic result is 42." }],
    };
    const prepared = prepareResponsesRequest(request({ input: [dispatched, report] }));
    expect(prepared.history[0]).toMatchObject({
      type: "agent_message",
      id: "agent_msg_synthetic",
      author: "parent_agent",
      recipient: "child_agent",
      content: dispatched.content,
    });
    expect(prepared.history[1]).toEqual(report);
    expect(prepared.prompt).toContain('"author":"parent_agent","recipient":"child_agent"');
    expect(prepared.prompt).toContain("然后报告合成结果 🌆");
    expect(prepared.prompt).not.toContain("SYNTHETIC_PRIVATE_AGENT_TURN");
    expect(
      (prepared.originalRequest.input as Array<Record<string, unknown>>)[0]
        .internal_chat_message_metadata_passthrough,
    ).toEqual(metadata);
  });

  it.each([
    { content: [{ type: "encrypted_content", encrypted_content: "SYNTHETIC_TASK_CIPHERTEXT" }] },
    {
      content: [
        { type: "input_text", text: "A visible fragment" },
        { type: "encrypted_content", encrypted_content: "SYNTHETIC_RESULT_CIPHERTEXT" },
      ],
    },
  ])("rejects encrypted agent tasks/results instead of dropping them: %j", ({ content }) => {
    expect(() =>
      prepareResponsesRequest(
        request({
          input: [
            { type: "agent_message", author: "parent_agent", recipient: "child_agent", content },
          ],
        }),
      ),
    ).toThrow("Encrypted agent task/result content cannot be transferred");
  });

  it.each([
    { author: 7, recipient: "child_agent", content: [] },
    { author: "parent_agent", recipient: null, content: [] },
    { author: "parent_agent", recipient: "child_agent", content: "synthetic text" },
    {
      author: "parent_agent",
      recipient: "child_agent",
      content: [{ type: "input_text", text: 42 }],
    },
    {
      author: "parent_agent",
      recipient: "child_agent",
      content: [{ type: "input_image", image_url: "synthetic" }],
    },
  ])("rejects malformed agent_message protocol: %j", (message) => {
    expect(() =>
      prepareResponsesRequest(request({ input: [{ type: "agent_message", ...message }] })),
    ).toThrow(ProtocolError);
  });

  it("preserves native client_metadata locally without sending operational data to Claude", () => {
    const clientMetadata = {
      session_id: "SYNTHETIC_PRIVATE_SESSION_MARKER",
      nested_operational_data: {
        workspace: "SYNTHETIC_PRIVATE_WORKSPACE_MARKER",
        flags: [true, 7, null],
      },
    };
    const prepared = prepareResponsesRequest(request({ client_metadata: clientMetadata }));
    expect(prepared.originalRequest.client_metadata).toEqual(clientMetadata);
    expect(prepared.prompt).not.toContain("client_metadata");
    expect(prepared.prompt).not.toContain("SYNTHETIC_PRIVATE_SESSION_MARKER");
    expect(JSON.stringify(prepared.content)).not.toContain("SYNTHETIC_PRIVATE_WORKSPACE_MARKER");
    expect(() => prepareResponsesRequest(request({ client_metadata: [] }))).toThrow(ProtocolError);
    expect(() =>
      prepareResponsesRequest(request({ client_metadata: "synthetic-invalid" })),
    ).toThrow(ProtocolError);
  });

  it("accepts Codex's optional encrypted reasoning include without fabricating hidden reasoning", () => {
    const prepared = prepareResponsesRequest(request({ include: ["reasoning.encrypted_content"] }));
    expect(prepared.compatibilityNotes).toContainEqual(
      expect.stringContaining("Claude does not provide OpenAI encrypted hidden reasoning"),
    );
    const response = decisionToResponse(
      { kind: "final", text: "synthetic final", calls: [] },
      prepared,
    );
    expect(response.output).toHaveLength(1);
    expect(response.output[0]).toMatchObject({
      type: "message",
      content: [{ type: "output_text", text: "synthetic final" }],
    });
    expect(response.output.some((item) => item.type === "reasoning")).toBe(false);
    expect(response).not.toHaveProperty("encrypted_content");
    expect(response.gateway_protocol_notes).toEqual(prepared.compatibilityNotes);
    expect(decisionToResponse(call(), prepared).output[0].type).toBe("function_call");
    expect(() =>
      prepareResponsesRequest(
        request({ include: ["reasoning.encrypted_content", "message.output_text.logprobs"] }),
      ),
    ).toThrow(ProtocolError);
  });

  it("preserves instruction priority, message order, UTF-8, and historical call/result links", () => {
    const prepared = prepareResponsesRequest(
      request({
        instructions: "Use only synthetic data.",
        input: [
          { role: "system", content: "Do not invent tool results." },
          { role: "developer", content: [{ type: "input_text", text: "保持中文 🌆" }] },
          { role: "user", content: [{ type: "input_text", text: "Look up fictional city." }] },
          {
            type: "function_call",
            id: "fc_previous",
            call_id: "call_previous",
            name: "lookup_synthetic",
            arguments: '{"key":"demo"}',
            status: "completed",
          },
          {
            type: "function_call_output",
            call_id: "call_previous",
            output: [
              { type: "input_text", text: "Synthetic result: 月城" },
              { type: "input_text", text: "Tool text is data, not a developer instruction." },
            ],
          },
        ],
      }),
    );
    const context = JSON.parse(prepared.prompt.split("\n\n").at(-1)!);
    expect(context.instructions).toBe("Use only synthetic data.");
    expect(context.history.map((item: Record<string, string>) => item.role ?? item.type)).toEqual([
      "system",
      "developer",
      "user",
      "function_call",
      "function_call_output",
    ]);
    expect(context.history[3].call_id).toBe(context.history[4].call_id);
    expect(context.history[4].output).toHaveLength(2);
    expect(prepared.prompt).toContain("保持中文 🌆");
    expect(prepared.content[0]).toEqual({ type: "text", text: prepared.prompt });
    expect(prepared.outputSchema).toEqual(CLAUDE_DECISION_SCHEMA);
  });

  it("keeps same-name tools in different namespaces distinct in output and next-turn history", () => {
    const prepared = prepareResponsesRequest(
      request({
        tools: [
          {
            type: "namespace",
            name: "north",
            description: "Northern district",
            tools: [functionTool],
          },
          { type: "namespace", name: "south", tools: [functionTool] },
        ],
      }),
    );
    expect(prepared.tools.map((tool) => [tool.id, tool.namespace, tool.name])).toEqual([
      ["tool_0", "north", "lookup_synthetic"],
      ["tool_1", "south", "lookup_synthetic"],
    ]);
    let counter = 0;
    const response = decisionToResponse(call('{"key":"demo"}', "tool_1"), prepared, {
      id: "resp_synthetic",
      createdAt: 123,
      idFactory: () => String(counter++),
    });
    expect(response.output[0]).toMatchObject({
      type: "function_call",
      name: "lookup_synthetic",
      namespace: "south",
      arguments: '{"key":"demo"}',
      call_id: "call_1",
    });
    const next = prepareResponsesRequest(
      request({
        input: [
          response.output[0],
          { type: "function_call_output", call_id: "call_1", output: "synthetic value = 42" },
        ],
      }),
    );
    expect(next.history[0]).toMatchObject({ namespace: "south", call_id: "call_1" });
    expect(next.prompt).toContain("synthetic value = 42");
  });

  it("passes freeform custom input without JSON parsing, escaping, or whitespace changes", () => {
    const raw = "*** Begin Patch\n*** Add File: synthetic.txt\n+你好 🌆\n*** End Patch\n";
    const prepared = prepareResponsesRequest(
      request({
        tools: [
          {
            type: "custom",
            name: "apply_patch",
            format: {
              type: "grammar",
              syntax: "lark",
              definition: 'start: "*** Begin Patch" /[\\s\\S]*/',
            },
          },
        ],
      }),
    );
    const response = decisionToResponse(call(raw), prepared, { idFactory: () => "synthetic" });
    expect(response.output[0]).toMatchObject({
      type: "custom_tool_call",
      name: "apply_patch",
      input: raw,
    });
    expect(prepared.prompt).toContain('"syntax":"lark"');
    expect(
      prepareResponsesRequest(
        request({
          input: [
            response.output[0],
            {
              type: "custom_tool_call_output",
              call_id: response.output[0].call_id,
              output: "Synthetic patch accepted",
            },
          ],
        }),
      ).history[0],
    ).toMatchObject({ input: raw });
  });

  it.each(["spawn_agent", "send_message", "followup_task"])(
    "marks Claude's native collaboration.%s arguments as plaintext for Codex dispatch",
    (name) => {
      const tools = [
        {
          type: "namespace",
          name: "collaboration",
          tools: [
            {
              type: "function",
              name,
              parameters: {
                type: "object",
                properties: { message: { type: "string", encrypted: true } },
                required: ["message"],
                additionalProperties: false,
              },
            },
          ],
        },
      ];
      const prepared = prepareResponsesRequest(request({ tools }));
      const argumentsText = JSON.stringify({ message: "Perform the full synthetic task 🌆." });
      const response = decisionToResponse(call(argumentsText), prepared);
      expect(response.output[0]).toMatchObject({
        type: "function_call",
        namespace: "collaboration",
        name,
        arguments: argumentsText,
        encrypted_function_args: [],
      });
      expect(
        responseToSseEvents(response).find((event) => event.type === "response.output_item.done"),
      ).toMatchObject({ item: { encrypted_function_args: [] } });
      const next = prepareResponsesRequest(
        request({
          tools,
          input: [
            response.output[0],
            {
              type: "function_call_output",
              call_id: response.output[0].call_id,
              output: "Synthetic dispatch accepted",
            },
          ],
        }),
      );
      expect(next.history[0]).toMatchObject({
        arguments: argumentsText,
        encrypted_function_args: [],
      });
      expect(next.prompt).toContain("Perform the full synthetic task 🌆.");
    },
  );

  it("does not claim plaintext collaboration dispatch for unrelated tools", () => {
    for (const [namespace, name] of [
      ["collaboration", "list_agents"],
      ["synthetic", "spawn_agent"],
      [undefined, "send_message"],
    ]) {
      const functionDefinition = { ...functionTool, name };
      const tools = namespace
        ? [{ type: "namespace", name: namespace, tools: [functionDefinition] }]
        : [functionDefinition];
      const response = decisionToResponse(call(), prepareResponsesRequest(request({ tools })));
      expect(response.output[0]).not.toHaveProperty("encrypted_function_args");
    }
  });

  it("accepts explicit plaintext function markers and rejects unreadable encrypted arguments", () => {
    const historicalCall = {
      type: "function_call",
      name: "send_message",
      namespace: "collaboration",
      call_id: "call_synthetic_dispatch",
      arguments: '{"message":"The synthetic result is 42."}',
    };
    for (const marker of [undefined, null, []]) {
      const prepared = prepareResponsesRequest(
        request({
          input: [
            {
              ...historicalCall,
              ...(marker === undefined ? {} : { encrypted_function_args: marker }),
            },
          ],
        }),
      );
      expect(prepared.prompt).toContain("The synthetic result is 42.");
    }
    expect(() =>
      prepareResponsesRequest(
        request({ input: [{ ...historicalCall, encrypted_function_args: ["message"] }] }),
      ),
    ).toThrow("Encrypted historical function arguments cannot be transferred");
    expect(() =>
      prepareResponsesRequest(
        request({ input: [{ ...historicalCall, encrypted_function_args: "synthetic-invalid" }] }),
      ),
    ).toThrow(ProtocolError);
  });

  it("attaches images as actual Claude blocks in both user content and tool results", () => {
    const image = {
      type: "input_image",
      image_url: `data:image/png;base64,${png}`,
      detail: "high",
    };
    const prepared = prepareResponsesRequest(
      request({
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: "Inspect this synthetic pixel" }, image],
          },
          {
            type: "function_call_output",
            call_id: "call_external",
            output: [{ type: "input_text", text: "Synthetic rendered image" }, image],
          },
        ],
      }),
    );
    expect(prepared.content.filter((block) => block.type === "image")).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
      { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
    ]);
    expect(prepared.prompt).toContain('"image_id":"image_0"');
    expect(prepared.prompt).toContain('"image_id":"image_1"');
    expect(prepared.prompt).not.toContain(png);
  });

  it.each([
    { type: "input_image", image_url: "https://example.test/synthetic.png" },
    { type: "input_image", file_id: "file_synthetic" },
    { type: "input_image", image_url: "data:image/svg+xml;base64,PHN2Zz4=" },
    { type: "input_image", image_url: "data:image/png;base64,not-valid-base64" },
    { type: "input_audio", data: "synthetic" },
    { type: "input_file", file_id: "file_synthetic" },
  ])("explicitly rejects unsupported or unreadable content %j", (part) => {
    expect(() =>
      prepareResponsesRequest(request({ input: [{ role: "user", content: [part] }] })),
    ).toThrow(ProtocolError);
  });

  it("exposes unavailable hosted tools while retaining available Codex tools", () => {
    const prepared = prepareResponsesRequest(
      request({ tools: [{ type: "web_search", search_context_size: "low" }, functionTool] }),
    );
    expect(prepared.tools).toHaveLength(1);
    expect(prepared.unsupportedTools).toMatchObject([{ type: "web_search" }]);
    expect(prepared.prompt).toContain('"unavailable_tools"');
    expect(parseClaudeDecision(call(), prepared).calls).toHaveLength(1);
    expect(() =>
      prepareResponsesRequest(
        request({ tools: [{ type: "web_search" }], tool_choice: { type: "web_search" } }),
      ),
    ).toThrow(ProtocolError);
  });

  it("marks unsupported schema constraints unavailable instead of ignoring them", () => {
    const invalidTool = {
      ...functionTool,
      name: "unsupported_synthetic",
      parameters: { ...functionTool.parameters, syntheticUnknownConstraint: true },
    };
    const prepared = prepareResponsesRequest(request({ tools: [invalidTool, functionTool] }));
    expect(prepared.tools).toHaveLength(1);
    expect(prepared.unsupportedTools).toMatchObject([
      {
        name: "unsupported_synthetic",
        reason: expect.stringContaining("syntheticUnknownConstraint"),
      },
    ]);
    expect(() => prepareResponsesRequest(request({ tools: [invalidTool, invalidTool] }))).toThrow(
      "Duplicate tool identity",
    );
  });

  it.each([
    '{"key":"x"}', // minLength
    '{"key":7}', // type
    "{}", // required
    '{"key":"demo","unapproved":true}', // additionalProperties
    '["demo"]',
    "null",
    '{"key":',
  ])("refuses invalid function input before it can reach Codex: %s", (input) => {
    expect(() => parseClaudeDecision(call(input), prepareResponsesRequest(request()))).toThrow(
      ProtocolError,
    );
  });

  it("validates nested refs, anyOf, bounds, and enums without mutating values", () => {
    const parameters = {
      type: "object",
      $defs: { key: { type: "string", enum: ["demo"] } },
      properties: {
        key: { $ref: "#/$defs/key" },
        amount: { anyOf: [{ type: "integer", minimum: 1, maximum: 5 }, { type: "null" }] },
      },
      required: ["key", "amount"],
      additionalProperties: false,
    };
    const prepared = prepareResponsesRequest(request({ tools: [{ ...functionTool, parameters }] }));
    const input = '{ "key": "demo", "amount": null }';
    expect(parseClaudeDecision(call(input), prepared).calls[0].input).toBe(input);
    expect(() => parseClaudeDecision(call('{"key":"wrong","amount":1}'), prepared)).toThrow(
      ProtocolError,
    );
    expect(() => parseClaudeDecision(call('{"key":"demo","amount":9}'), prepared)).toThrow(
      ProtocolError,
    );
  });

  it("accepts Codex encrypted privacy annotations without relaxing the parameter schema", () => {
    const prepared = prepareResponsesRequest(
      request({
        tools: [
          {
            ...functionTool,
            parameters: {
              ...functionTool.parameters,
              properties: { key: { type: "string", minLength: 2, encrypted: true } },
            },
          },
        ],
      }),
    );
    expect(prepared.tools).toHaveLength(1);
    expect(prepared.prompt).toContain('"encrypted":true');
    expect(parseClaudeDecision(call(), prepared)).toBeDefined();
    expect(() => parseClaudeDecision(call('{"key":1}'), prepared)).toThrow(ProtocolError);
  });

  it("preserves visible reasoning summaries while explicitly omitting model-specific ciphertext", () => {
    const prepared = prepareResponsesRequest(
      request({
        input: [
          {
            type: "reasoning",
            id: "rs_synthetic",
            summary: [{ type: "summary_text", text: "Need the fictional value." }],
            encrypted_content: "SYNTHETIC_OPAQUE_CIPHERTEXT",
          },
          { role: "user", content: "What is it?" },
        ],
      }),
    );
    expect(prepared.history[0]).toMatchObject({
      type: "reasoning",
      encrypted_content_omitted: true,
      summary: [{ type: "summary_text", text: "Need the fictional value." }],
    });
    expect(prepared.prompt).not.toContain("SYNTHETIC_OPAQUE_CIPHERTEXT");
    expect(prepared.compatibilityNotes).toContainEqual(
      expect.stringContaining("hidden reasoning was not transferred"),
    );
  });

  it("enforces none, required, named choice, allowed_tools, and sequential calls", () => {
    expect(() =>
      parseClaudeDecision(call(), prepareResponsesRequest(request({ tool_choice: "none" }))),
    ).toThrow(ProtocolError);
    expect(() =>
      parseClaudeDecision(
        { kind: "final", text: "guess", calls: [] },
        prepareResponsesRequest(request({ tool_choice: "required" })),
      ),
    ).toThrow(ProtocolError);
    expect(
      parseClaudeDecision(
        call(),
        prepareResponsesRequest(
          request({ tool_choice: { type: "function", name: "lookup_synthetic" } }),
        ),
      ),
    ).toEqual(call());
    const tools = [functionTool, { ...functionTool, name: "second_synthetic" }];
    const allowed = prepareResponsesRequest(
      request({
        tools,
        tool_choice: {
          type: "allowed_tools",
          mode: "auto",
          tools: [{ type: "function", name: "second_synthetic" }],
        },
      }),
    );
    expect(() => parseClaudeDecision(call(), allowed)).toThrow(ProtocolError);
    expect(parseClaudeDecision(call('{"key":"demo"}', "tool_1"), allowed)).toBeDefined();
    expect(() =>
      parseClaudeDecision(
        { kind: "tool_calls", text: "", calls: [call().calls[0], call().calls[0]] },
        prepareResponsesRequest(request({ parallel_tool_calls: false })),
      ),
    ).toThrow(ProtocolError);
  });

  it.each([
    { kind: "tool_calls", text: "", calls: [] },
    { kind: "final", text: "bad", calls: [call().calls[0]] },
    { kind: "tool_calls", text: "", calls: [{ tool_id: "invented", input: "{}" }] },
    { ...call(), leakedField: "unaccepted" },
    { kind: "final", text: 42, calls: [] },
    null,
  ])("fails closed on malformed model decisions %j", (decision) => {
    expect(() => parseClaudeDecision(decision, prepareResponsesRequest(request()))).toThrow(
      ProtocolError,
    );
  });

  it.each([
    { previous_response_id: "resp_unexpanded" },
    { include: ["message.output_text.logprobs"] },
    { input: [{ type: "compaction", encrypted_content: "SYNTHETIC_COMPACTED_TASK_CONTEXT" }] },
    { input: [{ type: "item_reference", id: "msg_remote" }] },
    { input: [{ role: "user", content: "synthetic", unknownMessageField: true }] },
    { truncation: "auto" },
    { temperature: 0 },
    { text: { format: { type: "json_schema", schema: {} } } },
    { model: "--dangerously-skip-permissions" },
  ])("rejects unsupported protocol instead of silently discarding %j", (overrides) => {
    expect(() => prepareResponsesRequest(request(overrides))).toThrow(ProtocolError);
  });

  it("produces ordered reconstructable SSE with one terminal event for mixed text/custom/function calls", () => {
    const prepared = prepareResponsesRequest(
      request({ tools: [functionTool, { type: "custom", name: "raw_synthetic" }] }),
    );
    const decision: ClaudeDecision = {
      kind: "tool_calls",
      text: "检查合成数据 🌆",
      calls: [call().calls[0], { tool_id: "tool_1", input: "raw\ntext" }],
    };
    const response = decisionToResponse(decision, prepared, {
      id: "resp_synthetic",
      createdAt: 42,
      idFactory: (() => {
        let i = 0;
        return () => `item${i++}`;
      })(),
    });
    const events = responseToSseEvents(response);
    expect(events.map((event) => event.sequence_number)).toEqual(events.map((_, index) => index));
    expect(events.filter((event) => event.type === "response.completed")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "response.completed", response });
    expect(
      events
        .filter((event) => event.type === "response.output_item.done")
        .map((event) => event.item),
    ).toEqual(response.output);
    expect(
      events.find((event) => event.type === "response.function_call_arguments.delta")?.delta,
    ).toBe('{"key":"demo"}');
    expect(
      events.find((event) => event.type === "response.custom_tool_call_input.delta")?.delta,
    ).toBe("raw\ntext");
    const serialized = responseToSse(response);
    const parsed = serialized
      .trim()
      .split("\n\n")
      .map((block) => JSON.parse(block.split("\n")[1].slice(6)));
    expect(parsed).toEqual(events);
  });

  it("reports provider-measured usage and leaves missing usage unknown", () => {
    const prepared = prepareResponsesRequest(request());
    const final: ClaudeDecision = { kind: "final", text: "synthetic value = 42", calls: [] };
    expect(decisionToResponse(final, prepared).usage).toBeNull();
    expect(
      decisionToResponse(final, prepared, {
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 5,
        },
      }).usage,
    ).toEqual({
      input_tokens: 35,
      input_tokens_details: { cached_tokens: 20, cache_write_tokens: 5 },
      output_tokens: 4,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 39,
    });
    expect(() => decisionToResponse(final, prepared, { usage: { input_tokens: -1 } })).toThrow(
      ProtocolError,
    );
  });
});
