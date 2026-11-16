# Private offline speech adapter

Operator-deployed tool service, **not** part of the distributed skill ZIP or CYF
API/bridge business logic. It serves the already purchased audio-transcription
1.0.0 client without another marketplace purchase. No platform wallet/task APIs.

`service.py --config /private/service.json` uses Python3.11 with faster-whisper1.2.1,
pyannote.audio4.0.7, torch2.8.0+cpu and their pinned offline dependency closure.
Provision legitimately downloaded, SHA-verified local Whisper-small and
community-1 directories first. No Hugging Face token is needed at runtime.

Private operator config (0600) contains `apiKey` (new service-specific secret),
`asrModel`, `asrManifest`, `diarizationModel`, `diarizationManifest`, `state`
(private cache), and `port` (loopback only). Manifests list `files` with
`name`, `size`, `sha256`; cache identity includes manifest and adapter bytes.
Keep weights/venv read-only; allow writes only to the private state directory.

Expose via authenticated HTTPS over an operator-controlled SSH tunnel/reverse
proxy, with response buffering disabled. The endpoint is
`POST /v1/audio/transcriptions`; model `faster-whisper-small-community-1`.
The service sends JSON whitespace heartbeats during inference, not a deadline or
fabricated progress. Exact audio/language/model cache reuse avoids duplicate CPU
work after disconnect. Different service users need isolated credentials/state;
this deployment is single-owner, not a public multi-tenant ASR platform.

Use existing installation configuration with endpoint pointing to the HTTPS base,
`model` above, `language: "zh"`, `responseFormat: "diarized_json"`, the private
service key, and only that exact HTTPS origin. Anonymous speaker clusters are not
real identities. Word-level maximum-overlap assignment can still be uncertain;
ASR text and speaker boundaries require review. `usage: null` is not a claim that
platform execution has no cost. No prompt/expected text is supplied to ASR.

`python -m unittest discover -s tools/audio-transcription -p test_service.py -v`
checks protocol/auth/cache/alignment with fixtures; it does not prove real speech
recognition. Real-audio regression and API-owned artifact delivery are separate.
