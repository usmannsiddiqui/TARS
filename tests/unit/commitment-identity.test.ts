import { describe, expect, test } from "vitest";
import { commitmentKey } from "../../packages/domain/src/attention";
import { matchCommitments } from "../../packages/domain/src/prepare";

describe("commitment identity", () => {
  test("a_reworded_commitment_continues_the_one_citing_the_same_evidence", () => {
    const stored = [{ text: "Send the budget to Dana", evidenceIds: ["mail-1"] }];
    expect(matchCommitments(stored, [{ text: "Email Dana the budget summary", evidenceIds: ["mail-1"] }])).toEqual([0]);
    expect(matchCommitments(stored, [{ text: "Send the budget to Dana", evidenceIds: ["mail-2"] }])).toEqual([null]);
  });

  test("several_from_one_message_pair_by_shared_words_whatever_their_order", () => {
    const stored = [
      { text: "Send the budget to Dana", evidenceIds: ["mail-1"] },
      { text: "Book the room", evidenceIds: ["mail-1"] },
    ];
    const incoming = [
      { text: "Reserve the meeting room", evidenceIds: ["mail-1"] },
      { text: "Get Dana the budget", evidenceIds: ["mail-1"] },
      { text: "Call the caterer", evidenceIds: ["mail-1"] },
    ];
    expect(matchCommitments(stored, incoming)).toEqual([1, 0, null]);
  });

  test("the_stored_key_wins_over_the_wording", () => {
    expect(commitmentKey({ projectId: "p", text: "Get Dana the budget", key: "p:send the budget to dana" })).toBe("p:send the budget to dana");
    expect(commitmentKey({ projectId: "p", text: "Get  Dana the Budget" })).toBe("p:get dana the budget");
  });
});
