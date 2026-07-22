# Manual LLM Evals

This directory holds hand-run evaluation entry points that call a real model.

## `pnpm eval:llm`

Run the summarize compressor regression sample against your configured LLM:

```bash
pnpm eval:llm -- --llm '{"provider":"openai","model":"gpt-4.1"}'
```

If `--llm` is omitted, the command uses the local `wikg://local/config/llm` configuration.
Each case runs both a legacy pre-#117-style plain-text prompt and the current `<final>` protocol prompt so the raw outputs can be compared manually.

Notes:

- This is not part of `pnpm test`, `pnpm test:run`, or CI.
- It may incur model usage cost.
- The output is intended for human inspection, not snapshot stability.
- The JSON result includes model information with secrets omitted, raw outputs, final user-visible output, and heuristic checks for self-talk or tag leakage.
- Keep the bundled samples sanitized; if you need a new regression case, add a new case here rather than pasting sensitive source text.
