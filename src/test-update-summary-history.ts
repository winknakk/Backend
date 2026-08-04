import assert from "assert";
import { appendSummaryHistory, parseSummaryHistory } from "./shared/summaryHistory";

function run(): void {
  assert.deepStrictEqual(parseSummaryHistory(""), []);
  assert.deepStrictEqual(parseSummaryHistory("Legacy detail"), ["Legacy detail"]);
  assert.deepStrictEqual(parseSummaryHistory("- First detail\n- Second detail"), [
    "First detail",
    "Second detail",
  ]);

  assert.deepStrictEqual(appendSummaryHistory("", "First detail"), {
    runningSummary: "- First detail",
    appended: true,
    itemCount: 1,
  });
  assert.deepStrictEqual(appendSummaryHistory("Legacy detail", "New detail"), {
    runningSummary: "- Legacy detail\n- New detail",
    appended: true,
    itemCount: 2,
  });
  assert.deepStrictEqual(appendSummaryHistory("- First detail\n- Second detail", "Third detail"), {
    runningSummary: "- First detail\n- Second detail\n- Third detail",
    appended: true,
    itemCount: 3,
  });
  assert.deepStrictEqual(appendSummaryHistory("- First detail\n- Second detail", " second   detail "), {
    runningSummary: "- First detail\n- Second detail",
    appended: false,
    itemCount: 2,
  });

  console.log("Update summary history tests passed");
}

run();
