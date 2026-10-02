import { readFileSync, writeFileSync } from "node:fs";

const [mode, ...args] = process.argv.slice(2);
switch (mode) {
  case "stdout":
    process.stdout.write(args[0]);
    break;
  case "stderr":
    process.stderr.write(args[0]);
    break;
  case "exit":
    process.exitCode = Number(args[0]);
    break;
  case "sleep":
    setTimeout(() => {}, Number(args[0]));
    break;
  case "cwd":
    process.stdout.write(process.cwd());
    break;
  case "env":
    process.stdout.write(process.env[args[0]] ?? "");
    break;
  case "stdin":
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) process.stdout.write(chunk);
    break;
  case "attempt": {
    const [counterPath, errorText, successfulAttempt] = args;
    let count = 0;
    try {
      count = Number(readFileSync(counterPath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    count++;
    writeFileSync(counterPath, String(count));
    if (count >= Number(successfulAttempt)) {
      process.stdout.write("success");
    } else {
      process.stderr.write(errorText);
      process.exitCode = 1;
    }
    break;
  }
  default:
    throw new Error("Unknown test fixture mode: " + mode);
}
