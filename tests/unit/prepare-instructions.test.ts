import { describe, expect, test } from "vitest";
import { INSTRUCTIONS } from "../../convex/prepare";

describe("preparation instructions", () => {
  test("each_message_that_asks_is_its_own_commitment_with_its_own_deadline", () => {
    expect(INSTRUCTIONS).toMatch(/each message that asks the user for something is its own commitment/i);
    expect(INSTRUCTIONS).toMatch(/never merge requests from different messages/i);
    expect(INSTRUCTIONS).toMatch(/its dueAt comes from that message alone/i);
    expect(INSTRUCTIONS).toMatch(/explicitly changes an earlier request's deadline.*updates that request/i);
  });
});
