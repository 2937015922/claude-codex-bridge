import { GatewayError } from "./runner.js";

export const GPT_COLLABORATION_ALIAS = "native_collaboration";
export const MAX_GPT_SSE_EVENT_BYTES = 8 * 1024 * 1024;
const NATIVE_NAMESPACE = "collaboration";
const DISPATCH_FUNCTIONS = new Set(["spawn_agent", "send_message", "followup_task"]);
const ALIAS_INSTRUCTIONS =
  "The collaboration tools are exposed as native_collaboration in this request. Use native_collaboration for those tool calls; it is an alias for collaboration in the original instructions and conversation.";
type RecordValue = Record<string, unknown>;

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function failure(message: string, code: string, status = 502): never {
  throw new GatewayError(message, status, code);
}

/** Only namespace selectors are changed; argument strings and opaque history stay untouched. */
function mapChoice(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(mapChoice);
  if (!record(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === "namespace" && child === NATIVE_NAMESPACE
        ? GPT_COLLABORATION_ALIAS
        : mapChoice(child),
    ]),
  );
}

export interface GptInteropRequest {
  body: Buffer;
  aliased: boolean;
}

/** Unrelated requests retain their exact bytes. An existing alias fails rather than merging tools. */
export function prepareGptInteropRequest(body: Buffer): GptInteropRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    failure("GPT request body is not valid JSON", "gpt_interop_invalid_request", 400);
  }
  if (!record(parsed))
    failure("GPT request body must be an object", "gpt_interop_invalid_request", 400);
  const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
  const collaborations = tools.filter(
    (tool) => record(tool) && tool.type === "namespace" && tool.name === NATIVE_NAMESPACE,
  );
  if (!collaborations.length) return { body, aliased: false };
  if (
    collaborations.length !== 1 ||
    tools.some(
      (tool) => record(tool) && tool.type === "namespace" && tool.name === GPT_COLLABORATION_ALIAS,
    )
  ) {
    failure(
      "GPT collaboration alias conflicts with another tool namespace",
      "gpt_interop_alias_collision",
      400,
    );
  }
  const mappedTools = tools.map((tool) => {
    if (!record(tool) || tool.type !== "namespace" || tool.name !== NATIVE_NAMESPACE) return tool;
    if (!Array.isArray(tool.tools))
      failure("Collaboration namespace tools are invalid", "gpt_interop_invalid_request", 400);
    return {
      ...tool,
      name: GPT_COLLABORATION_ALIAS,
      tools: tool.tools.map((child) => {
        if (
          !record(child) ||
          child.type !== "function" ||
          !DISPATCH_FUNCTIONS.has(String(child.name))
        )
          return child;
        const parameters = child.parameters;
        if (
          !record(parameters) ||
          !record(parameters.properties) ||
          !record(parameters.properties.message)
        ) {
          failure(
            "Collaboration dispatch message schema is unsupported",
            "gpt_interop_invalid_request",
            400,
          );
        }
        return {
          ...child,
          parameters: {
            ...parameters,
            properties: {
              ...parameters.properties,
              message: { ...parameters.properties.message, encrypted: false },
            },
          },
        };
      }),
    };
  });
  const mappedInput = Array.isArray(parsed.input)
    ? parsed.input.map((item) =>
        record(item) && item.type === "function_call" && item.namespace === NATIVE_NAMESPACE
          ? { ...item, namespace: GPT_COLLABORATION_ALIAS }
          : item,
      )
    : parsed.input;
  if (
    parsed.instructions !== undefined &&
    parsed.instructions !== null &&
    typeof parsed.instructions !== "string"
  ) {
    failure("GPT instructions must be text", "gpt_interop_invalid_request", 400);
  }
  const request = {
    ...parsed,
    tools: mappedTools,
    ...(parsed.input === undefined ? {} : { input: mappedInput }),
    ...(parsed.tool_choice === undefined ? {} : { tool_choice: mapChoice(parsed.tool_choice) }),
    instructions: parsed.instructions
      ? `${parsed.instructions}\n\n${ALIAS_INSTRUCTIONS}`
      : ALIAS_INSTRUCTIONS,
  };
  return { body: Buffer.from(JSON.stringify(request)), aliased: true };
}

function restoreItem(item: unknown): unknown {
  if (!record(item) || item.type !== "function_call" || item.namespace !== GPT_COLLABORATION_ALIAS)
    return item;
  const restored: RecordValue = { ...item, namespace: NATIVE_NAMESPACE };
  if (DISPATCH_FUNCTIONS.has(String(item.name))) {
    const opaque = item.encrypted_function_args;
    if (
      opaque !== undefined &&
      opaque !== null &&
      (!Array.isArray(opaque) || opaque.length !== 0)
    ) {
      failure(
        "GPT returned opaque collaboration dispatch arguments",
        "gpt_interop_opaque_dispatch",
      );
    }
    restored.encrypted_function_args = [];
  }
  return restored;
}

/** Applies to non-stream Responses objects and individual SSE envelopes. */
export function restoreGptInteropJsonResponse(value: unknown, aliased: boolean): unknown {
  if (!aliased || !record(value)) return value;
  const direct = restoreItem(value);
  if (direct !== value) return direct;
  let result = value;
  const replace = (key: string, mapped: unknown) => {
    if (mapped !== value[key]) {
      if (result === value) result = { ...value };
      result[key] = mapped;
    }
  };
  if (Object.hasOwn(value, "item")) replace("item", restoreItem(value.item));
  if (Array.isArray(value.output)) {
    const output = value.output;
    const mapped = output.map(restoreItem);
    if (mapped.some((item, index) => item !== output[index])) replace("output", mapped);
  }
  if (record(value.response))
    replace("response", restoreGptInteropJsonResponse(value.response, true));
  return result;
}

function restoreEvent(raw: string): string {
  const lines: { text: string; ending: string }[] = [];
  const matches = /([^\r\n]*)(\r\n|\r|\n|$)/g;
  let match: RegExpExecArray | null;
  while ((match = matches.exec(raw)) && match[0]) lines.push({ text: match[1], ending: match[2] });
  const dataIndices: number[] = [];
  const data: string[] = [];
  lines.forEach((line, index) => {
    const text = index === 0 ? line.text.replace(/^\uFEFF/, "") : line.text;
    if (text !== "data" && !text.startsWith("data:")) return;
    dataIndices.push(index);
    data.push(text === "data" ? "" : text.slice(5).replace(/^ /, ""));
  });
  if (!dataIndices.length) return raw;
  let event: unknown;
  try {
    event = JSON.parse(data.join("\n"));
  } catch {
    return raw;
  }
  const mapped = restoreGptInteropJsonResponse(event, true);
  if (mapped === event) return raw;
  const first = dataIndices[0];
  const rest = new Set(dataIndices.slice(1));
  return lines
    .map((line, index) => {
      if (rest.has(index)) return "";
      if (index !== first) return line.text + line.ending;
      const bom = line.text.startsWith("\uFEFF") ? "\uFEFF" : "";
      return `${bom}data: ${JSON.stringify(mapped)}${line.ending}`;
    })
    .join("");
}

export interface GptInteropSseOptions {
  aliased: boolean;
  maxEventBytes?: number;
}

/** Streams each completed SSE event; never buffers the full response. */
export async function* restoreGptInteropSse(
  source: AsyncIterable<Uint8Array>,
  options: GptInteropSseOptions,
): AsyncGenerator<Uint8Array> {
  if (!options.aliased) {
    for await (const chunk of source) yield chunk;
    return;
  }
  const limit = options.maxEventBytes ?? MAX_GPT_SSE_EVENT_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error("Invalid GPT SSE event buffer limit");
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let eventLines: string[] = [];
  let line = "";
  let eventBytes = 0;
  let pendingCr = false;
  function append(text: string) {
    eventBytes += Buffer.byteLength(text);
    if (eventBytes > limit)
      failure("GPT SSE event exceeded the buffer limit", "gpt_interop_event_limit");
    line += text;
  }
  function finishLine(ending: string): Uint8Array | undefined {
    eventBytes += Buffer.byteLength(ending);
    if (eventBytes > limit)
      failure("GPT SSE event exceeded the buffer limit", "gpt_interop_event_limit");
    const empty = line.length === 0;
    eventLines.push(line + ending);
    line = "";
    if (!empty) return;
    const output = Buffer.from(restoreEvent(eventLines.join("")));
    eventLines = [];
    eventBytes = 0;
    return output;
  }
  function* feed(text: string): Generator<Uint8Array> {
    let offset = 0;
    if (pendingCr && text.length) {
      pendingCr = false;
      const ending = text[0] === "\n" ? "\r\n" : "\r";
      if (text[0] === "\n") offset = 1;
      const output = finishLine(ending);
      if (output) yield output;
    }
    for (let index = offset; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code !== 10 && code !== 13) continue;
      append(text.slice(offset, index));
      if (code === 13 && index === text.length - 1) {
        pendingCr = true;
        offset = index + 1;
        break;
      }
      let ending = code === 13 ? "\r" : "\n";
      if (code === 13 && text[index + 1] === "\n") {
        ending = "\r\n";
        index++;
      }
      const output = finishLine(ending);
      if (output) yield output;
      offset = index + 1;
    }
    append(text.slice(offset));
  }
  for await (const chunk of source) {
    let text: string;
    try {
      text = decoder.decode(chunk, { stream: true });
    } catch {
      failure("GPT SSE contained invalid UTF-8", "gpt_interop_invalid_sse");
    }
    yield* feed(text);
  }
  let tail: string;
  try {
    tail = decoder.decode();
  } catch {
    failure("GPT SSE contained invalid UTF-8", "gpt_interop_invalid_sse");
  }
  yield* feed(tail);
  if (pendingCr) {
    const output = finishLine("\r");
    if (output) yield output;
  }
  if (eventLines.length || line.length) yield Buffer.from(restoreEvent(eventLines.join("") + line));
}
