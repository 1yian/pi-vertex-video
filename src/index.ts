import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GoogleAuth } from "google-auth-library";
import { Type } from "typebox";

const formats: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpg",
  ".flv": "video/x-flv",
  ".wmv": "video/wmv",
  ".3gp": "video/3gpp",
};

function config() {
  const required = (name: string, pattern: RegExp) => {
    const value = process.env[name];
    if (!value || !pattern.test(value)) throw new Error(`Set ${name} explicitly to a valid value.`);
    return value;
  };
  const limit = (name: string, fallback: number) => {
    const value = process.env[name];
    if (value === undefined) return fallback;
    const number = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1 || number > fallback) {
      throw new Error(`${name} must be an integer from 1 to ${fallback}.`);
    }
    return number;
  };
  return {
    project: required("PI_VERTEX_PROJECT", /^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{6,20})$/),
    location: required("PI_VERTEX_LOCATION", /^(?:global|[a-z]+-[a-z]+[0-9]{1,2})$/),
    model: required("PI_VERTEX_MODEL", /^gemini-[a-z0-9][a-z0-9.-]{0,99}$/),
    quotaProject: required(
      "PI_VERTEX_QUOTA_PROJECT",
      /^(?:none|[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{6,20})$/,
    ),
    videoBytes: limit("PI_VERTEX_MAX_VIDEO_BYTES", 90 * 1024 * 1024),
    requestBytes: limit("PI_VERTEX_MAX_REQUEST_BYTES", 128 * 1024 * 1024),
    timeoutMs: limit("PI_VERTEX_TIMEOUT_MS", 180_000),
  };
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function boundedText(response: Response, signal: AbortSignal) {
  if (!response.body) throw new Error("Vertex returned an empty response body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2 * 1024 * 1024)
        throw new Error("Vertex response exceeds the 2 MiB safety limit.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function analyze(
  args: { path: string; prompt: string },
  cwd: string,
  callerSignal: AbortSignal | undefined,
) {
  const settings = config();
  if (!args.path.trim() || !args.prompt.trim() || Buffer.byteLength(args.prompt) > 16_384) {
    throw new Error(
      "Provide a local video path and a nonblank prompt of at most 16384 UTF-8 bytes.",
    );
  }
  const path = resolve(cwd, args.path.replace(/^@/, ""));
  const mimeType = formats[extname(path).toLowerCase()];
  if (!mimeType)
    throw new Error("Unsupported video extension. Use mp4, mov, webm, mpeg, mpg, flv, wmv or 3gp.");
  const deadline = AbortSignal.timeout(settings.timeoutMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
  signal.throwIfAborted();
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    let bytes: Buffer;
    const inlineData = { mimeType, data: "" };
    const request = {
      contents: [{ role: "user", parts: [{ inlineData }, { text: args.prompt }] }],
      generationConfig: { maxOutputTokens: 8192 },
    };
    const overhead = Buffer.byteLength(JSON.stringify(request));
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size === 0)
        throw new Error("Video must be a nonempty regular file.");
      if (stat.size > settings.videoBytes)
        throw new Error(`Video exceeds the ${settings.videoBytes}-byte local video limit.`);
      const encodedBytes = 4 * Math.ceil(stat.size / 3) + overhead;
      if (encodedBytes > settings.requestBytes)
        throw new Error(
          `Encoded Vertex request exceeds the ${settings.requestBytes}-byte local request limit (base64 plus JSON).`,
        );
      bytes = Buffer.alloc(stat.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        signal.throwIfAborted();
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, null);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset !== stat.size)
        throw new Error("Video changed while reading. Retry with a stable local file.");
      bytes = bytes.subarray(0, offset);
    } finally {
      await file.close();
    }
    inlineData.data = bytes.toString("base64");
    const body = JSON.stringify(request);
    if (Buffer.byteLength(body) > settings.requestBytes)
      throw new Error("Encoded Vertex request exceeds the local request limit.");
    signal.throwIfAborted();
    const host =
      settings.location === "global"
        ? "aiplatform.googleapis.com"
        : `${settings.location}-aiplatform.googleapis.com`;
    const url = `https://${host}/v1/projects/${settings.project}/locations/${settings.location}/publishers/google/models/${settings.model}:generateContent`;
    let token: string;
    try {
      const auth = new GoogleAuth({
        projectId: settings.project,
        scopes: ["https://www.googleapis.com/auth/cloud-platform"],
        clientOptions: {
          transporterOptions: {
            timeout: settings.timeoutMs,
            signal,
            retry: false,
            fetchImplementation: fetch,
          },
        },
      });
      const credential = await abortable(auth.getClient(), signal);
      signal.throwIfAborted();
      const result = await abortable(credential.getAccessToken(), signal);
      if (!result.token) throw new Error("No access token");
      token = result.token;
    } catch {
      signal.throwIfAborted();
      throw new Error(
        "ADC authentication failed. Supply valid Application Default Credentials with the cloud-platform scope; verify GOOGLE_APPLICATION_CREDENTIALS or the workload identity/metadata environment. No API-key fallback is available.",
      );
    }
    signal.throwIfAborted();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    if (settings.quotaProject !== "none") headers["x-goog-user-project"] = settings.quotaProject;
    const response = await fetch(url, { method: "POST", headers, body, signal, redirect: "error" });
    const raw = await boundedText(response, signal);
    if (!response.ok) {
      const guidance: Record<number, string> = {
        400: "Check model, location, MIME/codec, duration, token context and request limits.",
        401: "ADC token rejected. Refresh or repair the configured ADC identity.",
        403: "Check aiplatform.endpoints.predict permission, Vertex API access, and serviceusage.services.use for the explicit quota project.",
        404: "Check the explicit Vertex model ID and location availability; retired models are not substituted.",
        413: "Vertex rejected the request size. Lower the video/request bounds or use a smaller video.",
        429: "Vertex quota or capacity exhausted. Check the explicit project/quota project and retry later.",
      };
      throw new Error(
        `Vertex HTTP ${response.status}. ${guidance[response.status] ?? "Vertex service failure. Check service availability and explicit project/location/model, then retry."} No fallback or automatic retry was performed.`,
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new Error("Vertex returned invalid JSON.");
    }
    if (!record(payload)) throw new Error("Vertex returned an invalid response object.");
    if (record(payload.promptFeedback) && payload.promptFeedback.blockReason)
      throw new Error("Vertex blocked the video prompt under its safety policy.");
    const candidate = Array.isArray(payload.candidates) ? payload.candidates[0] : undefined;
    if (!record(candidate) || !record(candidate.content) || !Array.isArray(candidate.content.parts))
      throw new Error(
        "Vertex returned no analysis candidate. Check safety policy and model response.",
      );
    const texts: string[] = [];
    for (const part of candidate.content.parts) {
      if (!record(part)) throw new Error("Vertex returned an invalid content part.");
      if (part.thought === true) continue;
      if (typeof part.text === "string") texts.push(part.text);
    }
    const text = texts.join("\n");
    if (!text.trim())
      throw new Error("Vertex returned no analysis text. Check safety policy and model response.");
    const clipped = text.split("\n").slice(0, 1900).join("\n");
    const output = new TextDecoder().decode(Buffer.from(clipped).subarray(0, 48_000), {
      stream: true,
    });
    const notices = [
      output !== text ? "[Analysis truncated at 48000 UTF-8 bytes or 1900 lines.]" : "",
      candidate.finishReason !== "STOP"
        ? `[Vertex finish reason: ${typeof candidate.finishReason === "string" ? candidate.finishReason.slice(0, 80) : "unspecified"}; analysis may be incomplete.]`
        : "",
    ].filter(Boolean);
    return {
      content: [{ type: "text" as const, text: [output, ...notices].join("\n") }],
      details: {
        project: settings.project,
        location: settings.location,
        model: settings.model,
        mimeType,
        videoBytes: bytes.length,
        requestBytes: Buffer.byteLength(body),
      },
    };
  } catch (error) {
    if (callerSignal?.aborted) throw new Error("Vertex video analysis cancelled.");
    if (deadline.aborted)
      throw new Error(
        `Vertex video analysis timed out after ${settings.timeoutMs} ms. No fallback or automatic retry was performed.`,
      );
    if (error instanceof TypeError)
      throw new Error(
        "Vertex network request failed. Check connectivity to the configured Google Vertex endpoint; redirects and provider fallback are disabled.",
      );
    throw error;
  }
}

export default function vertexVideo(pi: ExtensionAPI) {
  pi.registerTool({
    name: "vertex_video_analyze",
    label: "Vertex video analysis",
    executionMode: "sequential",
    description:
      "Analyze a complete local audiovisual video through Vertex AI using ADC only. Sends the original bytes and MIME, never extracted frames. Requires explicit PI_VERTEX_PROJECT, PI_VERTEX_LOCATION, PI_VERTEX_MODEL and PI_VERTEX_QUOTA_PROJECT (project ID or none). Supports mp4/mov/webm/mpeg/mpg/flv/wmv/3gp. Local bounds: 90 MiB video, 128 MiB encoded request, 180s timeout; environment can lower these. Prompt at most 16384 UTF-8 bytes. Analysis text capped at 48000 UTF-8 bytes or 1900 lines; explicit truncation and incomplete-finish notices may follow.",
    parameters: Type.Object(
      {
        path: Type.String({
          minLength: 1,
          description: "Local video path, relative to the Pi working directory or absolute.",
        }),
        prompt: Type.String({
          minLength: 1,
          description: "Analysis question, including audiovisual details of interest.",
        }),
      },
      { additionalProperties: false },
    ),
    async execute(_id, args, signal, _onUpdate, ctx) {
      return analyze(args, ctx.cwd, signal);
    },
  });
}
