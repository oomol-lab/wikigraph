# Manual LLM Evals

This directory holds hand-run evaluation entry points that call a real model.

## `pnpm eval:llm`

Run the summarize compressor regression cases against your configured LLM:

```bash
pnpm eval:llm -- --llm '{"provider":"openai","model":"gpt-4.1"}'
```

If `--llm` is omitted, the command uses the local `wikg://local/config/llm` configuration.
Each case runs both a legacy pre-#117-style plain-text prompt and the current `<final>` protocol prompt so the raw outputs can be compared manually.
The bundled cases cover direct self-talk injection and a later revision round with contradictory, high-pressure feedback.

## Review the output

This eval is a manual smoke/regression check. A zero exit code only means the scripted run completed without a blocking protocol failure; it is not enough to accept the result.

After running it, a human reviewer or an LLM reviewer must inspect the JSON output semantically:

- Read each case's `reviewGuidance`.
- Compare `legacyBeforeIssue117.rawOutput` with `current.rawOutput`.
- For pressure cases, inspect `current.requester.rawOutputs` attempt by attempt. It is acceptable, and useful evidence, if an early requester attempt leaks complaint, defense, apology, reasoning, or process notes and a later retry returns clean `<final>...</final>` output.
- Pass only when the final user-visible output is compressed prose, not meta commentary, and the observed raw outputs support the review guidance.

Notes:

- This is not part of `pnpm test`, `pnpm test:run`, or CI.
- It may incur model usage cost.
- The output is intended for human inspection, not snapshot stability.
- The JSON result includes model information with secrets omitted, raw outputs, final user-visible output, review guidance, and heuristic checks for self-talk or tag leakage.
- Treat the heuristics as hints only. For pressure cases, inspect the raw output semantically and judge whether complaint, defense, apology, reasoning, or process notes leaked into the visible answer.
- Keep the bundled samples sanitized; if you need a new regression case, add a new case here rather than pasting sensitive source text.
