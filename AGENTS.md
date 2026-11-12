# JuyiAI Runtime development

Read README.md and the affected component guide before changing code. In the JuyiAI integration checkout, also follow ../AGENTS.md, ../api/docs/interface-standard.md and ../specs/juyiting-skill-execution/responsibility-boundaries.md.

API owns business authorization and completion facts; Runtime/bridge owns local execution, identity, filesystem/session isolation and protocol adaptation. Do not duplicate API business state machines.

Keep conf/codex-bridge and conf/cyf-agent-runtime-v1 adjacent. Do not rename protocol identifiers or production paths as part of branding. Build on ordinary disk, not tmpfs. Validate affected Node/Python tests and shell syntax. Deployment, enrollment and production state changes are separate from source commits. Never commit credentials, private HOME, sessions or production logs.
