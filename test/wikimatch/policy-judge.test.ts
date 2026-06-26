import { describe, expect, it, vi } from "vitest";

import {
  buildWikimatchWindows,
  judgeWikimatchPolicy,
  parsePolicyResponse,
  type WikimatchCandidate,
} from "../../src/wikimatch/index.js";
import {
  ParsedJsonError,
  type GuaranteedRequest,
} from "../../src/guaranteed/index.js";

describe("wikimatch/policy-judge", () => {
  it("retries with precise business errors when recalled mentions overlap", async () => {
    const input = createInput();
    const request = vi
      .fn<GuaranteedRequest>()
      .mockResolvedValueOnce(
        JSON.stringify({
          decisions: [
            {
              candidateId: "c1",
              decision: "recall",
              qid: "Q1",
            },
            {
              candidateId: "c2",
              decision: "recall",
              qid: "Q2",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          decisions: [
            {
              candidateId: "c1",
              decision: "recall",
              qid: "Q1",
              reason: "整体指代北京大学",
            },
            {
              candidateId: "c2",
              decision: "skip_this_time",
              reason: "北京只是北京大学名称的一部分",
            },
          ],
        }),
      );

    const result = await judgeWikimatchPolicy({
      ...input,
      request,
    });

    expect(result.mentions).toStrictEqual([
      {
        candidateId: "c1",
        qid: "Q1",
        range: {
          end: 9,
          start: 5,
        },
        reason: "整体指代北京大学",
        surface: "北京大学",
      },
    ]);
    expect(result.policyUpdates).toStrictEqual([
      {
        candidateId: "c2",
        decision: "skip_this_time",
        reason: "北京只是北京大学名称的一部分",
        surface: "北京",
      },
    ]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[0].at(-1)?.content).toContain(
      "Decision conflict: candidates c1 and c2 both use decision",
    );
  });

  it("shows disambiguation options in the prompt and rejects disambiguation qid as final grounding", async () => {
    const input = createInput();
    const request = vi.fn<GuaranteedRequest>().mockResolvedValue(
      JSON.stringify({
        decisions: [
          {
            candidateId: "c3",
            decision: "recall",
            qid: "Q48397",
          },
        ],
      }),
    );

    const result = await judgeWikimatchPolicy({
      ...input,
      maxRetries: 0,
      request,
    });

    expect(request.mock.calls[0]?.[0][1]?.content).toContain(
      '"sourceQid": "Q48397"',
    );
    expect(request.mock.calls[0]?.[0][1]?.content).toContain(
      '"hint": "Mercury, the first planet from the Sun"',
    );
    expect(result).toMatchObject({
      fallback: {
        reason: "guaranteed_json_failed",
      },
      mentions: [],
    });
    expect(result.fallback?.issues[0]).toContain(
      "Disambiguation pages cannot be final mention groundings",
    );
  });

  it("can return empty fallback when guaranteed JSON keeps failing", async () => {
    const input = createInput();
    const result = await judgeWikimatchPolicy({
      ...input,
      maxRetries: 0,
      request: vi.fn<GuaranteedRequest>().mockResolvedValue("not json"),
    });

    expect(result.mentions).toStrictEqual([]);
    expect(result.policyUpdates).toStrictEqual([]);
    expect(result.fallback?.reason).toBe("guaranteed_json_failed");
  });

  it("rejects qids outside the candidate option set", () => {
    try {
      parsePolicyResponse(createInput().candidates, {
        decisions: [
          {
            candidateId: "c1",
            decision: "recall",
            qid: "Q404",
          },
        ],
      });
      throw new Error("Expected parsePolicyResponse to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ParsedJsonError);
      expect((error as ParsedJsonError).issues[0]).toContain(
        "Allowed QIDs for",
      );
    }
  });
});

function createInput(): {
  readonly candidates: readonly WikimatchCandidate[];
  readonly policyPrompt: string;
  readonly window: ReturnType<typeof buildWikimatchWindows>[number];
} {
  const text = "张三就读于北京大学。Mercury 是一个有歧义的词。";
  const candidates: WikimatchCandidate[] = [
    {
      id: "c1",
      qidOptions: [
        {
          description: "中国北京市的一所大学",
          label: "北京大学",
          qid: "Q1",
        },
      ],
      range: {
        end: 9,
        start: 5,
      },
      surface: "北京大学",
    },
    {
      id: "c2",
      qidOptions: [
        {
          description: "中国首都",
          label: "北京",
          qid: "Q2",
        },
      ],
      range: {
        end: 7,
        start: 5,
      },
      surface: "北京",
    },
    {
      id: "c3",
      qidOptions: [
        {
          description: "Wikimedia disambiguation page",
          disambiguation: {
            checkedAt: "2026-06-26T00:00:00.000Z",
            disambiguationQid: "Q48397",
            language: "en",
            options: [
              {
                description: "first planet from the Sun",
                hint: "Mercury, the first planet from the Sun",
                label: "Mercury",
                qid: "Q308",
                title: "Mercury (planet)",
              },
            ],
            pageTitle: "Mercury",
            wiki: "enwiki",
          },
          isDisambiguation: true,
          label: "Mercury",
          qid: "Q48397",
        },
      ],
      range: {
        end: 19,
        start: 12,
      },
      surface: "Mercury",
    },
  ];
  const [window] = buildWikimatchWindows({
    candidateBudget: 10,
    candidates,
    contextWords: 30,
    text,
  });

  if (window === undefined) {
    throw new Error("Missing test window");
  }

  return {
    candidates,
    policyPrompt: "只召回专有名词实体。",
    window,
  };
}
