import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const analysis =
  "The owned test pattern has an audible sine tone. Protocol fixture analysis, not inference.";

async function json(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

function sse(response, delta, finish) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(
    `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`,
  );
}

async function runCase(directory, artifact, video, scenario = {}) {
  const home = await mkdtemp(join(directory, "home-"));
  await mkdir(join(home, "agent"));
  const adc = {
    type: "authorized_user",
    client_id: "fixture-client",
    client_secret: "fixture-secret",
    refresh_token: "fixture-refresh",
    quota_project_id: "ignored-adc-quota",
  };
  await writeFile(join(home, "adc.json"), scenario.badAdc ? "{}" : JSON.stringify(adc));
  const received = { tokens: [], vertex: [], llm: [] };
  let child;
  let protocolError;
  let sawAuth;
  const authStarted = new Promise((resolveStarted) => {
    sawAuth = resolveStarted;
  });
  let sawVertex;
  const vertexStarted = new Promise((resolveStarted) => {
    sawVertex = resolveStarted;
  });
  const sockets = new Set();
  const server = createServer(async (request, response) => {
    try {
      const data = await json(request);
      if (request.url === "/protocol") {
        response.setHeader("content-type", "application/json");
        if (request.headers["x-original-origin"] === "https://oauth2.googleapis.com") {
          received.tokens.push(data);
          sawAuth();
          assert.match(
            typeof data.body === "string" ? data.body : JSON.stringify(data.body),
            /fixture-refresh/,
          );
          if (scenario.authFailure) {
            response.writeHead(400);
            response.end(
              JSON.stringify({
                error: "invalid_grant",
                error_description: "fixture-secret must not leak",
              }),
            );
          } else if (!scenario.authHang && !scenario.cancelAtAuth) {
            response.end(
              JSON.stringify({
                access_token: "fixture-access-token",
                token_type: "Bearer",
                expires_in: 3600,
              }),
            );
          }
          return;
        }
        const body = typeof data.body === "string" ? JSON.parse(data.body) : data.body;
        const inline = body.contents[0].parts[0].inlineData;
        const bytes = Buffer.from(inline.data, "base64");
        received.vertex.push({
          uri: data.uri,
          origin: request.headers["x-original-origin"],
          headers: data.headers,
          mime: inline.mimeType,
          hash: hash(bytes),
          bytes: bytes.length,
          prompt: body.contents[0].parts[1].text,
          requestBytes: Buffer.byteLength(JSON.stringify(body)),
          keys: Object.keys(body),
          parts: body.contents[0].parts.length,
        });
        sawVertex();
        if (scenario.hang || scenario.cancel) return;
        response.writeHead(scenario.status ?? 200);
        response.end(
          scenario.raw ??
            JSON.stringify(
              scenario.payload ??
                (scenario.status
                  ? { error: { status: "FIXTURE_ERROR" } }
                  : {
                      candidates: [
                        {
                          content: {
                            parts: [{ thought: true, text: "private thought" }, { text: analysis }],
                          },
                          finishReason: "STOP",
                        },
                      ],
                    }),
            ),
        );
        return;
      }
      assert.equal(request.url, "/v1/chat/completions");
      received.llm.push(data);
      const result = data.messages.findLast((message) => message.role === "tool");
      if (result)
        sse(response, { role: "assistant", content: `Caller received: ${result.content}` }, "stop");
      else {
        assert.deepEqual(
          data.tools.map((tool) => tool.function.name),
          ["vertex_video_analyze"],
        );
        sse(
          response,
          {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "video-1",
                type: "function",
                function: {
                  name: "vertex_video_analyze",
                  arguments: JSON.stringify(
                    scenario.args ?? {
                      path: video,
                      prompt: "Describe the video and its audio exactly.",
                    },
                  ),
                },
              },
            ],
          },
          "tool_calls",
        );
      }
    } catch (error) {
      protocolError = error;
      response.writeHead(500);
      response.end(JSON.stringify({ error: "Protocol assertion failed" }));
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  await writeFile(
    join(home, "agent/models.json"),
    JSON.stringify({
      providers: {
        fixture: {
          baseUrl: `${baseUrl}/v1`,
          api: "openai-completions",
          apiKey: "dummy-local-only",
          models: [
            {
              id: "fixture",
              name: "fixture",
              reasoning: false,
              input: ["text"],
              contextWindow: 200000,
              maxTokens: 16384,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
  await writeFile(
    join(home, "agent/settings.json"),
    JSON.stringify({
      defaultTools: ["vertex_video_analyze"],
      retry: { enabled: false },
      compaction: { enabled: false },
    }),
  );
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: directory,
    PI_CODING_AGENT_DIR: join(home, "agent"),
    NODE_OPTIONS: `--import=${join(root, "test/intercept.mjs")}`,
    PI_VERTEX_FIXTURE_GUARD: "isolated-dummy-adc-only",
    PI_VERTEX_FIXTURE_URL: baseUrl,
    GOOGLE_APPLICATION_CREDENTIALS: join(home, scenario.missingAdc ? "missing.json" : "adc.json"),
    GOOGLE_CLOUD_QUOTA_PROJECT: "ignored-env-quota",
    PI_VERTEX_PROJECT: "fixture-project",
    PI_VERTEX_LOCATION: "global",
    PI_VERTEX_MODEL: "gemini-3.5-flash",
    PI_VERTEX_QUOTA_PROJECT: "fixture-quota",
    ...scenario.env,
  };
  const events = [];
  let stderr = "";
  try {
    child = spawn(
      process.execPath,
      [
        cli,
        "--mode",
        "rpc",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-builtin-tools",
        "--extension",
        artifact,
        "--provider",
        "fixture",
        "--model",
        "fixture",
        "--thinking",
        "off",
      ],
      { cwd: home, env, stdio: ["pipe", "pipe", "pipe"] },
    );
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    let pending = "";
    const complete = new Promise((resolveComplete, reject) => {
      child.on("error", reject);
      child.on("exit", (code, signal) =>
        reject(new Error(`Pi exited ${code}/${signal}: ${stderr}`)),
      );
      child.stdout.on("data", (chunk) => {
        pending += chunk.toString();
        for (;;) {
          const newline = pending.indexOf("\n");
          if (newline === -1) break;
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          events.push(event);
          if (event.type === "agent_settled") resolveComplete();
        }
      });
    });
    child.stdin.write(
      `${JSON.stringify({ id: "run", type: "prompt", message: "Use the video analysis tool." })}\n`,
    );
    if (scenario.cancel || scenario.cancelAtAuth) {
      await Promise.race([
        scenario.cancelAtAuth ? authStarted : vertexStarted,
        complete,
        new Promise((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error("No Vertex request before cancellation")),
            20000,
          );
          timer.unref();
        }),
      ]);
      child.stdin.write(`${JSON.stringify({ id: "cancel", type: "abort" })}\n`);
    }
    await Promise.race([
      complete,
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Pi deadline: ${stderr}\n${JSON.stringify(events).slice(-8000)}`)),
          45000,
        );
        timer.unref();
      }),
    ]);
    if (protocolError) throw protocolError;
    const tool = events.find((event) => event.type === "tool_execution_end");
    assert.ok(tool, `No native tool result: ${stderr}\n${JSON.stringify(events)}`);
    const text = tool.result.content.map((part) => part.text ?? "").join("\n");
    if (!scenario.cancel && !scenario.cancelAtAuth) {
      const final = events.findLast(
        (event) => event.type === "message_end" && event.message.role === "assistant",
      );
      assert.match(
        final.message.content.map((part) => part.text ?? "").join(""),
        /Caller received:/,
      );
      assert.ok(
        received.llm[1].messages.some(
          (message) => message.role === "tool" && message.content.includes(text),
        ),
      );
    }
    return { received, text, isError: tool.isError, events, stderr, details: tool.result.details };
  } finally {
    if (child && child.exitCode === null) {
      child.stdin.end();
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 3000);
      await once(child, "exit");
      clearTimeout(force);
    }
    for (const socket of sockets) socket.destroy();
    await new Promise((resolveClosed) => server.close(resolveClosed));
  }
}

test("built package in real isolated Pi: native full-video protocol and failures", {
  timeout: 240000,
}, async (t) => {
  const directory = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "vertex-e2e-"));
  try {
    const stage = join(directory, "stage");
    await mkdir(stage);
    for (const path of ["package.json", "README.md", "LICENSE", "dist"])
      await cp(join(root, path), join(stage, path), { recursive: true, dereference: true });
    execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", directory], {
      cwd: stage,
      stdio: "pipe",
    });
    execFileSync("tar", [
      "-xzf",
      join(directory, "1yian-pi-vertex-video-0.1.0.tgz"),
      "-C",
      directory,
    ]);
    const artifact = join(directory, "package");
    await symlink(await realpath(join(root, "node_modules")), join(artifact, "node_modules"));
    const manifest = JSON.parse(await readFile(join(artifact, "package.json")));
    assert.deepEqual(manifest.pi, { extensions: ["./dist/index.js"] });
    assert.deepEqual(Object.keys(manifest.dependencies), ["google-auth-library"]);
    assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], "*");
    assert.deepEqual((await readdir(artifact)).sort(), [
      "LICENSE",
      "README.md",
      "dist",
      "node_modules",
      "package.json",
    ]);
    const small = join(directory, "owned.mp4");
    execFileSync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=64x64:rate=2",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=8000",
      "-t",
      "1",
      "-c:v",
      "mpeg4",
      "-c:a",
      "aac",
      small,
    ]);
    const large = join(directory, "owned-av.mov");
    execFileSync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=1024x1024:rate=30",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000",
      "-t",
      "1",
      "-c:v",
      "rawvideo",
      "-pix_fmt",
      "uyvy422",
      "-c:a",
      "pcm_s16le",
      "-threads",
      "1",
      large,
    ]);
    const largeBytes = await readFile(large);
    assert.ok(largeBytes.length > 55 * 1024 * 1024);
    const streams = JSON.parse(
      execFileSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", large]),
    );
    assert.deepEqual(
      streams.streams.map((stream) => stream.codec_type),
      ["video", "audio"],
    );
    await t.test("complete audiovisual bytes, MIME, prompt, auth and explicit quota", async () => {
      const result = await runCase(directory, artifact, large);
      assert.equal(result.isError, false, `${result.text}\n${result.stderr}`);
      assert.equal(result.text, analysis);
      assert.equal(result.received.tokens.length, 1);
      assert.equal(result.received.vertex.length, 1);
      const capture = result.received.vertex[0];
      assert.equal(capture.hash, hash(largeBytes));
      assert.equal(capture.bytes, largeBytes.length);
      assert.equal(capture.mime, "video/quicktime");
      assert.equal(capture.prompt, "Describe the video and its audio exactly.");
      assert.equal(capture.headers.authorization, "Bearer fixture-access-token");
      assert.equal(capture.headers["x-goog-user-project"], "fixture-quota");
      assert.equal(capture.headers["content-type"], "application/json");
      assert.equal(capture.parts, 2);
      assert.deepEqual(capture.keys, ["contents", "generationConfig"]);
      assert.equal(capture.origin, "https://aiplatform.googleapis.com");
      assert.equal(
        capture.uri,
        "/v1/projects/fixture-project/locations/global/publishers/google/models/gemini-3.5-flash:generateContent",
      );
      assert.ok(capture.requestBytes - 4 * Math.ceil(largeBytes.length / 3) < 512);
      assert.ok(capture.requestBytes < 128 * 1024 * 1024);
      console.log(
        JSON.stringify({
          fixtureBytes: largeBytes.length,
          sha256: capture.hash,
          encodedRequestBytes: capture.requestBytes,
          overheadBytes: capture.requestBytes - 4 * Math.ceil(largeBytes.length / 3),
          streams: streams.streams.map((stream) => stream.codec_type),
        }),
      );
    });
    await t.test("regional endpoint, mp4 MIME, explicit no quota, unused API keys", async () => {
      const result = await runCase(directory, artifact, small, {
        env: {
          PI_VERTEX_LOCATION: "us-central1",
          PI_VERTEX_QUOTA_PROJECT: "none",
          GEMINI_API_KEY: "must-not-use",
          GOOGLE_API_KEY: "must-not-use",
        },
      });
      assert.equal(result.text, analysis);
      assert.equal(
        result.received.vertex[0].origin,
        "https://us-central1-aiplatform.googleapis.com",
      );
      assert.equal(result.received.vertex[0].mime, "video/mp4");
      assert.equal(result.received.vertex[0].headers["x-goog-user-project"], undefined);
      assert.equal(result.received.vertex[0].hash, hash(await readFile(small)));
    });
    await writeFile(join(directory, "empty.mp4"), "");
    await mkdir(join(directory, "directory.mp4"));
    for (const [name, scenario, expected] of [
      ["missing tool argument", { args: { path: small } }, /prompt/],
      [
        "unexpected tool argument",
        { args: { path: small, prompt: "Describe", endpoint: "http://attacker.invalid" } },
        /endpoint/,
      ],
      [
        "missing local file",
        { args: { path: join(directory, "absent.mp4"), prompt: "Describe" } },
        /ENOENT|no such file/,
      ],
      [
        "empty local file",
        { args: { path: join(directory, "empty.mp4"), prompt: "Describe" } },
        /nonempty regular file/,
      ],
      [
        "nonregular local file",
        { args: { path: join(directory, "directory.mp4"), prompt: "Describe" } },
        /nonempty regular file/,
      ],
      ["missing config", { env: { PI_VERTEX_PROJECT: "" } }, /Set PI_VERTEX_PROJECT explicitly/],
      [
        "invalid location",
        { env: { PI_VERTEX_LOCATION: "https://attacker.invalid" } },
        /Set PI_VERTEX_LOCATION explicitly/,
      ],
      [
        "missing quota choice",
        { env: { PI_VERTEX_QUOTA_PROJECT: "" } },
        /Set PI_VERTEX_QUOTA_PROJECT explicitly/,
      ],
      [
        "unsupported format",
        { args: { path: "not.mkv", prompt: "Describe" } },
        /Unsupported video extension/,
      ],
      ["blank prompt", { args: { path: small, prompt: "   " } }, /nonblank prompt/],
      [
        "oversize prompt",
        { args: { path: small, prompt: "a".repeat(16385) } },
        /16384 UTF-8 bytes/,
      ],
      ["video limit", { env: { PI_VERTEX_MAX_VIDEO_BYTES: "1" } }, /local video limit/],
      [
        "base64 request limit",
        { env: { PI_VERTEX_MAX_REQUEST_BYTES: "1024" } },
        /base64 plus JSON/,
      ],
      ["invalid limit", { env: { PI_VERTEX_MAX_VIDEO_BYTES: "99999999999" } }, /integer from 1 to/],
      ["missing ADC", { missingAdc: true }, /ADC authentication failed/],
      [
        "invalid ADC",
        { badAdc: true, env: { GEMINI_API_KEY: "must-not-use", GOOGLE_API_KEY: "must-not-use" } },
        /ADC authentication failed/,
      ],
      ["ADC refresh rejected", { authFailure: true }, /ADC authentication failed/],
    ])
      await t.test(name, async () => {
        const result = await runCase(directory, artifact, small, scenario);
        assert.equal(result.isError, true);
        assert.match(result.text, expected);
        assert.equal(result.received.vertex.length, 0);
        assert.doesNotMatch(result.text, /fixture-secret|must-not-use/);
        assert.equal(result.received.tokens.length, scenario.authFailure ? 1 : 0);
      });
    for (const [status, expected] of [
      [400, /MIME\/codec/],
      [401, /ADC token rejected/],
      [403, /aiplatform.endpoints.predict/],
      [404, /model ID and location/],
      [413, /request size/],
      [429, /quota or capacity/],
      [503, /service availability/],
    ])
      await t.test(`Vertex HTTP ${status}`, async () => {
        const result = await runCase(directory, artifact, small, { status });
        assert.equal(result.isError, true);
        assert.match(result.text, expected);
        assert.match(result.text, /No fallback or automatic retry/);
        assert.equal(result.received.vertex.length, 1);
        assert.equal(result.received.tokens.length, 1);
      });
    for (const [name, scenario, expected] of [
      ["invalid JSON", { raw: "no json" }, /invalid JSON/],
      ["invalid candidate", { payload: { candidates: [{}] } }, /no analysis candidate/],
      [
        "blocked response",
        { payload: { promptFeedback: { blockReason: "SAFETY" } } },
        /safety policy/,
      ],
      ["empty text", { payload: { candidates: [{ content: { parts: [] } }] } }, /no analysis text/],
      ["oversize response", { raw: "x".repeat(2 * 1024 * 1024 + 1) }, /2 MiB safety limit/],
      [
        "Vertex timeout",
        { hang: true, env: { PI_VERTEX_TIMEOUT_MS: "1000" } },
        /timed out after 1000 ms/,
      ],
      [
        "ADC timeout",
        { authHang: true, env: { PI_VERTEX_TIMEOUT_MS: "1000" } },
        /timed out after 1000 ms/,
      ],
    ])
      await t.test(name, async () => {
        const result = await runCase(directory, artifact, small, scenario);
        assert.equal(result.isError, true);
        assert.match(result.text, expected);
        assert.equal(result.received.vertex.length, scenario.authHang ? 0 : 1);
      });
    await t.test("native RPC cancellation of an in-flight Vertex request", async () => {
      const result = await runCase(directory, artifact, small, { cancel: true });
      assert.equal(result.isError, true);
      assert.match(result.text, /cancelled|aborted/i);
      assert.equal(result.received.vertex.length, 1);
    });
    await t.test("native RPC cancellation during ADC token acquisition", async () => {
      const start = performance.now();
      const result = await runCase(directory, artifact, small, { cancelAtAuth: true });
      assert.equal(result.isError, true);
      assert.match(result.text, /cancelled|aborted/i);
      assert.equal(result.received.tokens.length, 1);
      assert.equal(result.received.vertex.length, 0);
      assert.ok(
        performance.now() - start < 10000,
        "ADC cancellation must not wait for 180s deadline",
      );
    });
    await t.test("encoded request boundary is enforced exactly before authentication", async () => {
      const measured = await runCase(directory, artifact, small);
      const size = measured.received.vertex[0].requestBytes;
      const allowed = await runCase(directory, artifact, small, {
        env: { PI_VERTEX_MAX_REQUEST_BYTES: String(size) },
      });
      assert.equal(allowed.text, analysis);
      assert.equal(allowed.received.vertex[0].requestBytes, size);
      const refused = await runCase(directory, artifact, small, {
        env: { PI_VERTEX_MAX_REQUEST_BYTES: String(size - 1) },
      });
      assert.match(refused.text, /base64 plus JSON/);
      assert.equal(refused.received.tokens.length, 0);
      assert.equal(refused.received.vertex.length, 0);
    });
    await t.test("oversize sparse local video rejected before ADC or upload", async () => {
      const oversized = join(directory, "oversized.mp4");
      await writeFile(oversized, "");
      await truncate(oversized, 90 * 1024 * 1024 + 1);
      const result = await runCase(directory, artifact, oversized);
      assert.match(result.text, /local video limit/);
      assert.equal(result.received.tokens.length, 0);
      assert.equal(result.received.vertex.length, 0);
    });
    await t.test("bounded and explicitly incomplete output", async () => {
      const result = await runCase(directory, artifact, small, {
        payload: {
          candidates: [
            { content: { parts: [{ text: "a".repeat(50000) }] }, finishReason: "MAX_TOKENS" },
          ],
        },
      });
      assert.match(result.text, /Analysis truncated/);
      assert.match(result.text, /MAX_TOKENS; analysis may be incomplete/);
      assert.ok(Buffer.byteLength(result.text) < 49000);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
