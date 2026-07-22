import { describe, expect, it, vi } from "vitest";

import type {
  LLMessage,
  LLM,
  LLMRequestOptions,
} from "../../external/llm/index.js";
import { CompressionRequester } from "./compressor.js";

interface RequestCall<S extends string> {
  readonly messages: readonly LLMessage[];
  readonly options: LLMRequestOptions<S> | undefined;
}

describe("editor/compressor", () => {
  it("returns only structured compressed text after self-talk derailment", async () => {
    const calls: RequestCall<"compress">[] = [];
    const llm = createFakeLlm<"compress">({
      calls,
      responses: [
        [
          "My approach is to keep the highlighted facts and remove filler.",
          "---",
          "<final>只保留正文。</final>",
        ].join("\n"),
        "<final>只保留正文。</final>",
      ],
    });
    const requester = new CompressionRequester(llm, "compress", 0.2);

    await expect(
      requester.request({
        markedText: '<chunk retention="detailed">只保留正文。</chunk>',
        targetLength: 12,
      }),
    ).resolves.toBe("只保留正文。");

    expect(calls).toHaveLength(2);
    const retryMessages = calls[1]?.messages;

    expect(retryMessages?.[retryMessages.length - 1]?.content).toContain(
      "Return exactly one <final>...</final> block",
    );
  });

  it("keeps revision history in the same final-tag protocol", async () => {
    const calls: RequestCall<"compress">[] = [];
    const llm = createFakeLlm<"compress">({
      calls,
      responses: ["<final>修订后的正文。</final>"],
    });
    const requester = new CompressionRequester(llm, "compress", 0.2);

    await requester.request({
      markedText: "原文",
      previousCompressedText: "上一版正文。",
      revisionFeedback: "补充缺失信息。",
      targetLength: 10,
    });

    const initialMessages = calls[0]?.messages;

    expect(initialMessages?.[2]).toMatchObject({
      content: "<final>上一版正文。</final>",
      role: "assistant",
    });
    expect(initialMessages?.[3]).toMatchObject({
      content: "补充缺失信息。",
      role: "user",
    });
  });

  it("rejects output that escapes the final tag wrapper", async () => {
    const calls: RequestCall<"compress">[] = [];
    const llm = createFakeLlm<"compress">({
      calls,
      responses: [
        "前言 <final>坏输出</final>",
        "前言 <final>坏输出</final>",
        "前言 <final>坏输出</final>",
      ],
    });
    const requester = new CompressionRequester(llm, "compress", 0.2);

    await expect(
      requester.request({
        markedText: '<chunk retention="detailed">只保留正文。</chunk>',
        targetLength: 12,
      }),
    ).rejects.toThrow(
      "Compression response must be exactly one <final>...</final> block.",
    );

    expect(calls).toHaveLength(3);
  });
});

function createFakeLlm<S extends string>(input: {
  readonly calls: RequestCall<S>[];
  readonly responses: string[];
}): LLM<S> {
  const request = vi.fn(
    async (
      messagesOrOperation:
        | readonly LLMessage[]
        | ((
            request: (
              messages: readonly LLMessage[],
              options?: LLMRequestOptions<S>,
            ) => Promise<string>,
          ) => Promise<string>),
      options?: LLMRequestOptions<S>,
    ) => {
      if (typeof messagesOrOperation === "function") {
        return await messagesOrOperation(async (messages, requestOptions) => {
          input.calls.push({ messages, options: requestOptions });
          const response = input.responses.shift();

          if (response === undefined) {
            throw new Error("Unexpected LLM request");
          }

          return await Promise.resolve(response);
        });
      }

      input.calls.push({ messages: messagesOrOperation, options });
      const response = input.responses.shift();

      if (response === undefined) {
        throw new Error("Unexpected LLM request");
      }

      return response;
    },
  );

  return {
    loadSystemPrompt: vi.fn((templateName: string) => templateName),
    request,
  } as unknown as LLM<S>;
}
