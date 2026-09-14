import { expect, test } from "vitest";
import { issueBranch, issuePrompt } from "./worktree-dialog";
const issue = {
  id: "1",
  identifier: "ENG-42",
  title: "Fix / café `menu`…",
  url: "https://linear.app/test/issue/ENG-42/fix",
  description: "Use arrows.\nPreserve focus.",
  state: { name: "Todo" },
};
test("issue branches are safe and editable starting points", () => {
  expect(issueBranch(issue)).toBe("eng-42-fix-cafe-menu");
  expect(issueBranch({ ...issue, title: "😀" })).toBe("eng-42");
  expect(issueBranch({ ...issue, title: "a".repeat(200) }).length).toBeLessThan(
    90,
  );
});
test("agent drafts include the selected ticket context", () => {
  expect(issuePrompt(issue)).toBe(
    "Work on ENG-42: Fix / café `menu`…\nhttps://linear.app/test/issue/ENG-42/fix\n\nUse arrows.\nPreserve focus.",
  );
});
