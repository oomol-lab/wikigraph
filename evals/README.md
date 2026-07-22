# Manual LLM Evals

This directory holds hand-run evaluation entry points that call a real model.

## `pnpm eval:llm`

Run the summarize compressor regression sample against your configured LLM:

```bash
pnpm eval:llm -- --llm '{"provider":"openai","model":"gpt-4.1"}'
```

Notes:

- This is not part of `pnpm test`, `pnpm test:run`, or CI.
- It may incur model usage cost.
- The output is intended for human inspection, not snapshot stability.
- Keep the bundled samples sanitized; if you need a new regression case, add a new case here rather than pasting sensitive source text.
