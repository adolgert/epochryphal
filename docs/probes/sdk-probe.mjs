import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
const here = new URL(".", import.meta.url).pathname;
const cfg = here + "cfg"; const proj = here + "proj";
const [, , name, scriptJson, mode] = process.argv;
const script = here + `sdk-${name}.json`; writeFileSync(script, scriptJson);
process.env.HARNESS_TEST_SCRIPT = script; process.env.PROBE_LOG = here + `sdk-${name}.log`;
rmSync(process.env.PROBE_LOG, { force: true }); rmSync(script + ".requests.jsonl", { force: true });
const settingsManager = SettingsManager.inMemory({ defaultProvider: "scripted", defaultModel: "scripted-1", compaction: { enabled: false }, retry: { enabled: false } });
const resourceLoader = new DefaultResourceLoader({ cwd: proj, agentDir: cfg, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
  additionalExtensionPaths: [here + "probe-ext.ts", here + "scripted-model.ts"] });
await resourceLoader.reload();
const sessDir = here + "sessions"; mkdirSync(sessDir, { recursive: true });
const sessionManager = mode === "file" ? SessionManager.create(proj, sessDir) : SessionManager.inMemory(proj);
const { session } = await createAgentSession({ cwd: proj, agentDir: cfg, settingsManager, resourceLoader, sessionManager });
const t0 = Date.now(); const log = (m) => console.log(`[${Date.now() - t0}ms] ${m}`);
log(`model=${session.model?.provider}/${session.model?.id} file=${session.sessionFile}`);
session.subscribe((e) => { if (["agent_start", "agent_settled", "tool_execution_start"].includes(e.type)) log(`event ${e.type} ${e.toolName ?? ""} ${e.aborted ?? ""}`); });
log("before bind: scripted model? " + !!session.modelRuntime.getModel("scripted", "scripted-1"));
await session.bindExtensions({});
const sm = session.modelRuntime.getModel("scripted", "scripted-1");
log("after bind: scripted model? " + !!sm);
await session.setModel(sm); log(`model now ${session.model?.provider}/${session.model?.id}`);
const p = session.prompt(process.argv[5] ?? "hello");
if (name === "steerrpc") { await new Promise(r => setTimeout(r, 100)); log("steer -> " + await session.steer("control steer", undefined, { source: "rpc" })); }
if (name === "steer") { await new Promise(r => setTimeout(r, 100)); log("steer -> " + await session.steer("please steer")); }
if (name === "followup") { await new Promise(r => setTimeout(r, 100)); log("followUp -> " + await session.followUp("a follow up")); }
if (name === "abort") { await new Promise(r => setTimeout(r, 100)); await session.abort(); log("aborted"); }
await p; log("prompt resolved"); if (process.env.PROBE_DELAY) { await new Promise(r => setTimeout(r, +process.env.PROBE_DELAY)); log("delayed"); }
await session.waitForIdle?.(); log("idle");
log("log:\n" + (existsSync(process.env.PROBE_LOG) ? readFileSync(process.env.PROBE_LOG, "utf8").split("\n").map(l => l.slice(0, 160)).join("\n") : ""));
const req = script + ".requests.jsonl";
log("requests: " + (existsSync(req) ? readFileSync(req, "utf8").trim().split("\n").length : 0));
session.dispose();
