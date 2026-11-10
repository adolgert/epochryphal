import { spawn } from "node:child_process";
const here = new URL(".", import.meta.url).pathname;
const p = spawn("pi", ["--no-extensions", "-e", here + "probe-ext.ts", "-e", here + "scripted-model.ts", "--model", "scripted/scripted-1", "--mode", "rpc",
  "--no-context-files", "--no-skills", "--no-prompt-templates", "--offline", "--no-session"], { cwd: here + "proj", stdio: ["pipe", "pipe", "inherit"] });
let buf = ""; const t0 = Date.now(); let settled = 0;
const send = (o) => p.stdin.write(JSON.stringify(o) + "\n");
p.stdout.on("data", (d) => {
  buf += d; let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1); const r = JSON.parse(line);
    if (["response", "extension_ui_request", "agent_settled", "agent_start"].includes(r.type)) console.log(`[${Date.now() - t0}]`, line.slice(0, 200));
    if (r.type === "extension_ui_request") {
      if (r.method === "select") send({ type: "extension_ui_response", id: r.id, value: "b" });
      else if (r.method === "confirm") send({ type: "extension_ui_response", id: r.id, confirmed: true });
      else if (r.method === "input") send({ type: "extension_ui_response", id: r.id, value: "typed" });
    }
    if (r.type === "agent_settled" && ++settled === 1) setTimeout(() => p.stdin.end(), 100);
  }
});
send({ id: "1", type: "prompt", message: "/probe-dialog" });
setTimeout(() => send({ id: "2", type: "prompt", message: "/probe-cmd send" }), 300);
setTimeout(() => p.kill(), 5000);
