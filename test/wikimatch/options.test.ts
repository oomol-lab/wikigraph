import { describe, expect, it } from "vitest";

import {
  countWikimatchCandidateOptions,
  splitCandidateByOptionBudget,
  type WikimatchCandidate,
} from "../../src/wikimatch/index.js";

describe("wikimatch/options", () => {
  it("counts disambiguation meanings as selectable options", () => {
    const candidate = disambiguationCandidate(5);

    expect(countWikimatchCandidateOptions(candidate)).toBe(5);
  });

  it("splits oversized disambiguation options horizontally", () => {
    const chunks = splitCandidateByOptionBudget(disambiguationCandidate(5), 2);

    expect(chunks).toHaveLength(3);
    expect(chunks.map((chunk) => listChunkQids(chunk))).toStrictEqual([
      ["Q1", "Q2"],
      ["Q3", "Q4"],
      ["Q5"],
    ]);
  });
});

function listChunkQids(candidate: WikimatchCandidate): readonly string[] {
  return candidate.qidOptions.flatMap(
    (option) =>
      option.disambiguation?.profile?.meanings.map((meaning) => meaning.qid) ??
      [],
  );
}

function disambiguationCandidate(count: number): WikimatchCandidate {
  return {
    id: "c1",
    qidOptions: [
      {
        disambiguation: {
          checkedAt: "2026-06-27T00:00:00.000Z",
          disambiguationQid: "Q100",
          linkedQids: Array.from({ length: count }, (_, index) => ({
            qid: `Q${index + 1}`,
            title: `Meaning ${index + 1}`,
          })),
          pages: [],
          profile: {
            meanings: Array.from({ length: count }, (_, index) => ({
              information: `Information ${index + 1}`,
              name: `Meaning ${index + 1}`,
              priority: "other",
              qid: `Q${index + 1}`,
            })),
            sourceQid: "Q100",
          },
        },
        isDisambiguation: true,
        label: "Example",
        qid: "Q100",
      },
    ],
    range: {
      end: 7,
      start: 4,
    },
    surface: "Example",
  };
}
