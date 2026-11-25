# Skill packages

## CYF archive maintenance native package (2026-11-05)

`archive-maintenance/` is the **2.0.0 INSTRUCTION** package: SKILL.md plus the existing deterministic UTF-8 parser. It contains no legacy execution manifest and does not activate the old archive-job reconciler. Native execution still requires actual tools and API authorization; package installation is not evidence of a published book.

Source `6b7035038b7e4af8a86d449df66d3587ceeef7f0`, Flow `5264702/152`: six focused tests passed and the skill-only ZIP was produced/uploaded on the worker. SHA-256 `d272bc3f1bd24fb215e1f23323ceb985a16cf3f756029ff0ca196a083e8f31a2`. No Runtime application build or restart was needed.

CYF's authorized owner published the package through the normal reviewed publication API, linked it to the “典籍管理” position, and appointed 吴用. The position installation completed; profile and real UI show “典籍维护” installed/ready. This does **not** establish archive conversation tools or 《三国演义》 publication. Operational evidence: CYF `docs/implementation/handoffs/ARCHIVE-MANAGEMENT-CHAT-20261105.md`.

## Historical executable preparations (not the current install path)

Candidate: **1.1.1**, prepared only. This folder does not register/approve/install a production skill.
The exact package SHA-256 and manifest SHA-256 are in `archive-maintenance-1.1.1-package.json`.
Rebuild with `python3 package-archive-maintenance.py`; different bytes at a versioned ZIP are refused.

- 1.1.0 is retained byte-for-byte as a failed preparation record: its SKILL.md top-level version did not satisfy the installer's required metadata.version. Do not approve/install it.
- 1.1.1 corrects that identity metadata, with a new immutable version/hash. Book text is never bundled.
- The package implements the native archive source/result contract, not a generic shell/URL importer. UTF-8 Chinese/Markdown headings and optional preface are supported; source/body hashes are deterministic.
- The host executes the measured installed local script without Runtime credentials/provider keys. Backend job/position/resource grants own all write/publish decisions.
- Preparation, reviewed package-catalog registration, installation receipt, runtime execution and publication are distinct gates. Tests use an isolated test-only approved row and no marketplace order.
- Production registration must use the existing reviewed package/catalog workflow and content-addressed package store. No direct production SQL, credential or automatic activation is included here.

## Audio transcription candidate (2026-11-16)

`audio-transcription/` is an INSTRUCTION1.0.0 candidate with a dependency-free Node24.14+ multipart transcription helper, scoped configuration, source hashes, provider receipts/usage and durable no-auto-replay marker. See its [SKILL.md](audio-transcription/SKILL.md) and [configuration](audio-transcription/configuration.md). It requires an owner-authorized HTTP transcription provider and installed network/configuration; Realtime-only service is not sufficient. Existing document-workbench remains the document-output capability. Source/test/package preparation does not publish a marketplace product, purchase/install for 花荣, or prove real transcription. Task689 and prior unknown ASR effect are not replayed by this addition.

The optional operator tool in `tools/audio-transcription/` supplies a local
faster-whisper/pyannote HTTP service for the same 1.0.0 package; it is not bundled
with the skill and requires separate protected deployment and scoped configuration.

## Offline image processing candidate (2026-11-25)

`image-process/` is an offline-only `INSTRUCTION` skill. Prepare the standalone
`image-process` 1.0.0 and native-operation `image-generate`/`image-edit` 2.0.0
packages with `python3 conf/skills/package-image-process.py <output-directory>`.
The variants both bundle the same local processor and no provider script.
Publishing and installing each package are separate catalog operations.

For 2.0.0 native operations, configure `nativeImage` with the exact installed
variant ZIP digest(s), `mountPinnedSkill: true`, and an image model. Use the
existing Agent chat connection for the Images API. Only the verified package
is mounted: no skill configuration or sandbox network is enabled by this
setting. Standalone `image-process` does not need `nativeImage` at all.

The native tool returns a read-only per-execution source path and a candidate
reference. The Agent reads installed instructions and decides whether to run
the processor; the Bridge does not call `resize` or interpret dimensions or
background. Only the selected result is submitted. A local retry reuses the
same source. The original opaque picture is not recolored; use the image
model for semantic background changes. This is not a production release receipt.
