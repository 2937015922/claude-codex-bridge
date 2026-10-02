#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  defaultRuntimeDirectory,
  gatewayRequest,
  portOpen,
  readRuntimeConfig,
  rollbackInstallation,
} from "./install-native-gateway.mjs";

export function parseControlArguments(argv) {
  const options = { configFile: path.join(defaultRuntimeDirectory(), "gateway.json") };
  let configSpecified = false;
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (["--status", "--stop", "--rollback", "--help"].includes(value)) {
      if (options.action) throw new Error("Select one action");
      options.action = value.slice(2);
    } else if (value === "--config-file" && argv[index + 1] && !argv[index + 1].startsWith("--")) {
      if (configSpecified) throw new Error("Duplicate config option");
      configSpecified = true;
      options.configFile = argv[++index];
    } else throw new Error("Unknown or incomplete control option");
  }
  options.action ||= "help";
  if (!path.isAbsolute(options.configFile)) throw new Error("Configuration path must be absolute");
  return options;
}
export async function gatewayStatus(config) {
  try {
    const health = await gatewayRequest(config, "/health");
    if (health.ready !== true || !Array.isArray(health.models))
      throw new Error("Invalid gateway health response");
    const publicText = (value) =>
      String(value || "")
        .replaceAll(config.token, "[redacted]")
        .slice(0, 80);
    const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : undefined);
    return {
      status: "ready",
      port: config.port,
      version: publicText(health.version),
      models: health.models.filter((model) => typeof model === "string").map(publicText),
      active: count(health.active),
      queued: count(health.queued),
      gptRequests: count(health.gptRequests),
      claudeRequests: count(health.claudeRequests),
      failures: count(health.failures),
    };
  } catch {
    return { status: (await portOpen(config.port)) ? "unreachable" : "stopped", port: config.port };
  }
}
export async function stopGateway(config) {
  if (!(await portOpen(config.port))) return { status: "stopped", port: config.port };
  const result = await gatewayRequest(config, "/shutdown", "POST");
  if (result.stopping !== true) throw new Error("Gateway shutdown was not acknowledged");
  const deadline = Date.now() + 10000;
  while (await portOpen(config.port)) {
    if (Date.now() > deadline)
      throw new Error("Gateway shutdown was requested but exit was not confirmed");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { status: "stopped", port: config.port };
}
async function main() {
  const options = parseControlArguments(process.argv.slice(2));
  if (options.action === "help") {
    console.log(
      "Native gateway control: --status | --stop | --rollback [--config-file ABSOLUTE]. Status never starts a gateway. Stop affects only the authenticated configured loopback endpoint; rollback removes only this gateway activation.",
    );
    return;
  }
  if (options.action === "rollback") {
    console.log(JSON.stringify(await rollbackInstallation(options.configFile), null, 2));
    return;
  }
  const config = await readRuntimeConfig(options.configFile);
  console.log(
    JSON.stringify(
      options.action === "status" ? await gatewayStatus(config) : await stopGateway(config),
      null,
      2,
    ),
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error(
      "Native gateway control failed; no credentials or raw server response were printed.",
    );
    process.exitCode = 1;
  });
