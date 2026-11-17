# pi-vertex-video

A standalone native [Pi](https://github.com/earendil-works/pi) extension for full-video analysis through **Google Cloud Vertex AI using Application Default Credentials (ADC) only**. It registers exactly one tool: `vertex_video_analyze`.

No pi-web-access dependency, Gemini Developer API, API-key authentication, provider fallback, frame extraction, transcoding, cloud upload, commands, login flow, or settings mutation. The original local file, including its audio track when present, is sent as one base64 `inlineData` part with its video MIME type, alongside your analysis prompt. Vertex performs its own media decoding and sampling; complete byte delivery is not a claim that the model examines every frame.

## Package and loading

Requires Node.js 22+ and Pi. Tested host version: `@earendil-works/pi-coding-agent@1.5.2`. The host supplies Pi and TypeBox; `google-auth-library` is the only runtime dependency. Compiled `dist/index.js` is included for Git-package loading, and CI checks it matches the source.

For a later, separately authorized installation:

```sh
pi install git:github.com/1yian/pi-vertex-video
```

Or build a reviewed source checkout and try it for one invocation:

```sh
npm ci
npm run build
pi -e ./dist/index.js
```

`pi install` changes the user's package settings. Neither installation nor production inference was performed in developing or validating this change. No npm release has been published. Pin a reviewed Git commit for controlled deployment.

## Explicit configuration

Set these in the environment of the Pi process. There are no inferred project, location, model, or quota-project defaults:

- `PI_VERTEX_PROJECT`: Google Cloud project ID or project number that owns the Vertex request.
- `PI_VERTEX_LOCATION`: `global` or a regional name such as `us-central1`. Multi-region shortcuts and arbitrary URLs are not supported.
- `PI_VERTEX_MODEL`: an explicit Google publisher Gemini model ID, for example `gemini-3.5-flash`. Availability and retirement must be checked for your project and region. This is not automatically selected or substituted.
- `PI_VERTEX_QUOTA_PROJECT`: explicit quota project ID/number, or the literal `none`. A project sends `x-goog-user-project`; `none` omits that header and leaves service-side attribution in effect. ADC `quota_project_id` and `GOOGLE_CLOUD_QUOTA_PROJECT` do not override this choice for the Vertex request.

Example configuration only, not a provisioning command:

```sh
export PI_VERTEX_PROJECT='your-approved-project'
export PI_VERTEX_LOCATION='global'
export PI_VERTEX_MODEL='gemini-3.5-flash'
export PI_VERTEX_QUOTA_PROJECT='your-approved-quota-project'
```

ADC is resolved by Google's auth library from an explicitly supplied `GOOGLE_APPLICATION_CREDENTIALS` file, the existing well-known ADC file, or an existing workload/metadata identity. The Cloud Platform OAuth scope is requested. Supply only trusted ADC configuration: credential files can direct Google's auth library to external identity providers or credential executables. This extension does not create credentials, run login or gcloud, select a gcloud project, grant IAM, enable APIs, configure billing, or alter credential files. `GEMINI_API_KEY` and `GOOGLE_API_KEY` are never used.

The identity needs Vertex model access and `aiplatform.endpoints.predict`; explicit quota attribution may require `serviceusage.services.use` on that quota project. No permission or model entitlement is inferred from successful ADC discovery.

## Native tool

```json
{
  "path": "./recording.mov",
  "prompt": "Describe the action and explain what is audible, with timestamps."
}
```

`path` and `prompt` are required strings. Paths are local, absolute or relative to Pi's working directory; a leading `@` is accepted. Prompt must be nonblank and at most 16,384 UTF-8 bytes. There are no URL, GCS, extracted-frame or summary inputs.

Supported extension-to-MIME mappings: `.mp4` → `video/mp4`, `.mov` → `video/quicktime`, `.webm` → `video/webm`, `.mpeg` → `video/mpeg`, `.mpg` → `video/mpg`, `.flv` → `video/x-flv`, `.wmv` → `video/wmv`, `.3gp` → `video/3gpp`. Matching is case-insensitive. A supported filename is not proof of a valid container or codec; the extension does not inspect codecs or claim to validate media duration. Vertex decoder errors remain errors, never a frame-based fallback.

The tool returns the first candidate's non-thought analysis text. Empty, invalid, blocked, or malformed responses are errors. Non-`STOP` finishes are visibly labeled potentially incomplete. Analysis text is limited to 48,000 UTF-8 bytes or 1,900 lines; explicit truncation and incomplete-finish notices may follow. Result details include project, location, model, MIME, raw video byte count and encoded request byte count, not credentials or video data. Maximum output-token request: 8,192.

## Bounds and failures

Application safety bounds, independently lowerable with positive integer environment values:

- `PI_VERTEX_MAX_VIDEO_BYTES`: default and maximum 94,371,840 (90 MiB).
- `PI_VERTEX_MAX_REQUEST_BYTES`: default and maximum 134,217,728 (128 MiB), including **base64 and JSON**, not just the original file.
- `PI_VERTEX_TIMEOUT_MS`: default and maximum 180,000 ms for the tool operation, including ADC acquisition and the response body.

The request size is checked before allocating the file buffer or obtaining ADC, and checked again on the serialized request. Base64 costs `4 × ceil(videoBytes / 3)` bytes, plus prompt/JSON overhead. No media is silently trimmed to fit. Requests are serialized within Pi to bound concurrent memory use; processing a large inline video still requires several times its file size in RAM. Cancellation aborts ADC token transport and the Vertex HTTP request, and bounds waits for ADC discovery even when discovery itself is not abortable. Local file operations are bounded by the file-size cap and checked between reads; CPU serialization and a single OS file read cannot be preempted mid-operation.

Vertex requests go only to `https://aiplatform.googleapis.com/v1/...` for `global` or `https://LOCATION-aiplatform.googleapis.com/v1/...` regionally, using `projects/PROJECT/locations/LOCATION/publishers/google/models/MODEL:generateContent`. Authorization is a Bearer ADC access token. Redirects are refused. No custom production endpoint, fake-token mode, retry, or provider switch is exposed. ADC's own identity-provider endpoints remain governed by trusted ADC configuration.

Errors distinguish missing/invalid configuration or ADC, unsupported extensions, missing/empty/nonregular files, local raw/encoded bounds, HTTP 400 media/model constraints, 401 token rejection, 403 permission/quota-project access, 404 model/location/retirement, 413 provider size limits, 429 quota/capacity, service/network failures, timeout and cancellation. Raw OAuth errors and service response bodies are not echoed, to avoid credential or prompt leakage. Responses are bounded to 2 MiB before JSON parsing. Nothing is retried automatically by this tool.

## Current provider constraints and evidence

Documentation checked 2026-11-17, not a production inference result:

- Google's [Gemini 3.5 Flash model page](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/3-5-flash) names `gemini-3.5-flash`, video input including the MIME types above, a 256 MB maximum inline video part, approximately 45 minutes of video with audio or one hour without audio, and a 500 MiB compressed GenerateContent input limit. The extension's 90 MiB/128 MiB uncompressed bounds are intentionally lower. Other model, location, rollout and token-context limits can be stricter.
- [GenerateContent REST reference](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/model-reference/inference) defines inline media, MIME and candidate response parts. This package uses the Vertex `v1` REST protocol, not the Developer API's Files API or upload limits.
- [Locations](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/locations) documents global versus regional endpoint routing. `global` is not a regional data-residency guarantee.
- [Quota project documentation](https://docs.cloud.google.com/docs/quotas/set-quota-project) documents `x-goog-user-project`.
- The [Gemini 2.5 Flash page](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/2-5-flash) warns retirement on October 20, 2026. An older integration's model name is not used as a default or evidence of current Vertex availability.

Model entitlement, supported codecs, semantic quality, actual billing/quota behavior, production ADC identities and Google-side acceptance of large files have **not** been tested. A successful local protocol test cannot establish those facts. Installation and any CNP-only production runtime check require separate authorization and an explicitly approved project, identity, location, model, quota choice and owned media.

## Validation

```sh
npm ci
npm run lint
npm run typecheck
npm run build
npm run test:e2e
npm audit
```

The E2Es require `ffmpeg`, `ffprobe`, `tar` and Node.js. They pack and extract the compiled package, expose only its declared runtime dependency locally (Pi and TypeBox must resolve from the host), load it by its real `pi.extensions` manifest in an isolated real Pi CLI subprocess, and drive model-generated native tool calls over RPC. A loopback OpenAI fixture supplies deterministic tool calls and consumes actual tool results. A test-only fetch bridge routes only allowlisted Google OAuth/Vertex requests to the owned local protocol server. It rejects non-fixture ADC, and a socket guard refuses every connection except that server's literal loopback address and port. The bridge adapts to Pi's installed fetch implementation without replacing the loopback model path. None of this test machinery is shipped in the package or exposed by production configuration.

Generated audiovisual MOV footage exceeds 55 MiB and has verified video and audio streams. Tests compare the full delivered byte hash, MIME, prompt, auth/quota headers, endpoint, exact encoded-request size, caller-visible output, invalid configuration/arguments/ADC, key non-dependency, response validation, actionable HTTP failures, deadline expiry and native cancellation during both ADC and Vertex operations. Tests use owned child PIDs only, no fixed sleeps, live fleet homes or real credentials. CI runs static/build/artifact-drift and independent native E2Es on Node 22 and 24, without paid inference.

MIT licensed. This standalone implementation was written fresh; no pi-web-access source code was copied. The superseded public integration was consulted only as historical evidence, not imported as a dependency.
