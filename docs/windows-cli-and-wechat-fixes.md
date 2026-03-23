# Windows CLI and WeChat Reply Fixes

This document records the Windows-specific issues that were reproduced while deploying and validating `weixin-ai-bridge`, plus the fixes included in this branch.

## 1. Gemini CLI failed on Windows

### Symptom
- `spawn gemini ENOENT`
- `spawn EINVAL`
- `cmd.exe /c` quoting failures when calling `gemini.cmd`

### Root cause
- The project treated `gemini` as a directly executable binary.
- On Windows, the global npm install exposes `gemini.cmd` / `gemini.ps1` shims instead of a normal executable.
- Direct `spawn` / `execFile` handling for the shim was not stable on Windows.

### Fix
- Add a Windows-specific runner in `src/agents/gemini.ts`.
- Prefer the npm shim path on Windows instead of assuming a native executable.
- On Windows, fall back to a one-shot `ask()` path instead of CLI streaming.

### Result
- Gemini can be launched reliably on Windows through the adapter layer.
- The non-Windows streaming path remains unchanged.

## 2. Codex CLI failed on Windows

### Symptom
- `spawn codex ENOENT`
- `spawn EPERM`

### Root cause
- The project treated `codex` as a directly executable binary.
- `WindowsApps` executables were not reliable when spawned from Node.
- The npm shim path (`codex.cmd`) needed a Windows-specific execution path.

### Fix
- Add a Windows-specific runner in `src/agents/codex.ts`.
- Prefer the npm shim path on Windows instead of relying on `WindowsApps` executables.

### Result
- Codex launches through the adapter layer on Windows without relying on `WindowsApps`.

## 3. QR code display was unreliable on Windows terminals

### Symptom
- QR codes could be generated but were hard to scan in Windows terminals.
- It was difficult to tell whether the login QR content itself was valid.

### Root cause
- The compact QR rendering mode (`small: true`) uses half-block Unicode characters.
- That rendering is not reliable in all Windows terminal environments.

### Fix
- Disable compact QR rendering on Windows.
- Always print the raw `QR content` alongside the rendered code.

### Result
- The QR login flow is easier to validate on Windows.
- Users can still inspect or copy the QR content when rendering looks suspicious.

## 4. WeChat streaming replies were truncated in the client

### Symptom
- Logs showed full model output.
- The WeChat client only showed partial text such as early streaming fragments.

### Root cause
- The bridge depended on iLink streaming message updates being merged and finalized correctly.
- In practice, the final streamed state was not consistently reflected in the client.

### Fix
- Stop using WeChat-side streaming message updates.
- Keep model-side generation behavior, but only use `typing` during generation.
- Send the final reply with normal `sendMessage()` once the full text is available.

### Result
- The WeChat client now receives final complete replies instead of partial streamed fragments.
- Long replies still use the existing chunking behavior.

## 5. OpenAI-compatible `api-base` usage

### Symptom
- Requests failed with duplicated path suffixes such as:
  - `/v1/chat/completions/v1/chat/completions`

### Root cause
- The OpenAI-compatible backend already appends `/v1/chat/completions`.
- Passing a full chat completions path as `api-base` causes double concatenation.

### Fix
- `api-base` should be configured as the provider root, or the `/v1` root when required.
- Do not pass `/chat/completions` as part of `api-base`.

### Result
- Compatible OpenAI-style providers can be configured without path duplication errors.

## Operational notes

- On Windows, prefer npm shim paths for local CLI backends instead of `WindowsApps` executables.
- WeChat replies now use `typing + final send` instead of iLink streaming updates.
