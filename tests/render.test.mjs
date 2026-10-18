import assert from "node:assert/strict";
import { test } from "node:test";

import {
  renderProposalResult,
  renderReviewResult,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult,
  renderTaskResult,
  renderTestGapsResult,
  renderTransferResult
} from "../plugins/grok/scripts/lib/render.mjs";

test("renderProposalResult says nothing was applied and how to apply", () => {
  const proposal = {
    summary: "Change the log text.",
    patch: "diff --git a/app.js b/app.js\n",
    tests_to_run: ["node app.js"],
    risks: ["None known."]
  };
  const ok = renderProposalResult(
    {
      parsed: { result: proposal, rawOutput: "", parseError: null },
      check: { patchFile: "/s/jobs/task-1.patch", ok: true, output: "", stat: " app.js | 2 +-" },
      grokSessionId: "s1",
      warning: null
    },
    { jobId: "task-1" }
  );
  assert.match(ok, /grok changed no file/);
  assert.match(ok, /git apply --check: OK — not applied yet/);
  assert.match(ok, /git apply --ignore-whitespace "\/s\/jobs\/task-1\.patch"/);
  assert.match(ok, /`node app\.js`/);
  assert.match(ok, /None known\./);

  const failed = renderProposalResult(
    {
      parsed: { result: proposal, rawOutput: "", parseError: null },
      check: { patchFile: "/s/jobs/task-2.patch", ok: false, output: "error: patch failed: app.js:1", stat: "" },
      grokSessionId: null,
      warning: null
    },
    { jobId: "task-2" }
  );
  assert.match(failed, /git apply --check: FAILED — error: patch failed/);
  assert.match(failed, /Do not apply this patch/);
  assert.match(failed, /--resume-last --propose/);

  // A run that failed (non-zero grok status) must not invite applying, even
  // when the patch itself checked out.
  const reportedFailure = renderProposalResult(
    {
      parsed: { result: proposal, rawOutput: "", parseError: null },
      check: { patchFile: "/s/jobs/task-3.patch", ok: true, output: "", stat: " app.js | 2 +-" },
      grokSessionId: "s3",
      warning: null,
      failure: "max turns reached"
    },
    { jobId: "task-3" }
  );
  assert.match(reportedFailure, /Grok reported a failure: max turns reached/);
  assert.match(reportedFailure, /Do not apply this patch/);
  assert.doesNotMatch(reportedFailure, /Review the patch, then apply it/);
});

test("renderTestGapsResult marks every gap as a prediction", () => {
  const rendered = renderTestGapsResult(
    {
      result: {
        summary: "One gap.",
        gaps: [
          {
            mutation: "Skip cleanup of the prompt file",
            file: "lib/grok.mjs",
            line: 270,
            surviving_tests: ["runGrokHeadless parses streaming output"],
            breaking_tests: [],
            confidence: 0.7,
            suggested_test: "Assert the prompt file is gone after the run."
          }
        ]
      },
      rawOutput: "",
      parseError: null
    },
    { targetLabel: "working tree diff", grokSessionId: "s1", warning: null }
  );
  assert.match(rendered, /Vorhersage, nicht gemessen/);
  assert.match(rendered, /lib\/grok\.mjs:270/);
  assert.match(rendered, /Stays green: runGrokHeadless parses streaming output/);
  assert.match(rendered, /Breaks: \(none predicted\)/);
  assert.match(rendered, /70%/);
});

test("renderReviewResult shows verdict and findings", () => {
  const rendered = renderReviewResult(
    {
      result: {
        verdict: "needs-attention",
        summary: "Do not ship.",
        findings: [
          {
            severity: "high",
            title: "Race in job store",
            body: "Concurrent writers clobber state.json.",
            file: "lib/state.mjs",
            line_start: 10,
            line_end: 20,
            confidence: 0.8,
            recommendation: "Use atomic rename."
          }
        ],
        next_steps: ["Fix the race"]
      },
      rawOutput: "",
      parseError: null
    },
    { reviewLabel: "Review", targetLabel: "working tree diff", grokSessionId: "sess-1" }
  );

  assert.match(rendered, /Verdict: needs-attention/);
  assert.match(rendered, /\[high\] Race in job store/);
  assert.match(rendered, /lib\/state\.mjs:10-20/);
  assert.match(rendered, /grok --resume sess-1/);
  assert.match(rendered, /Fix the race/);
});

test("renderReviewResult reports parse failures with raw output", () => {
  const rendered = renderReviewResult(
    { result: null, rawOutput: "not json", parseError: "grok returned no structured output." },
    { reviewLabel: "Review", targetLabel: "working tree diff", grokSessionId: null }
  );
  assert.match(rendered, /did not return valid structured output/);
  assert.match(rendered, /not json/);
});

test("renderTaskResult includes mode and session resume hint", () => {
  const rendered = renderTaskResult(
    { rawOutput: "All tests pass.", failureMessage: null, grokSessionId: "sess-2" },
    { title: "Grok Task", jobId: "task-1", write: true }
  );
  assert.match(rendered, /write-enabled/);
  assert.match(rendered, /grok --resume sess-2/);
  assert.match(rendered, /All tests pass\./);
});

test("renderTaskResult and renderReviewResult show a warning when grok sent one", () => {
  const task = renderTaskResult(
    { rawOutput: "partial", failureMessage: null, grokSessionId: null, warning: "grok hit its turn limit; the answer may be incomplete." },
    { title: "Grok Task", jobId: null, write: false }
  );
  assert.match(task, /Warning: grok hit its turn limit/);

  const review = renderReviewResult(
    { result: { verdict: "approve", summary: "Fine.", findings: [], next_steps: [] }, rawOutput: "", parseError: null },
    { reviewLabel: "Review", targetLabel: "working tree diff", grokSessionId: null, warning: "grok hit its turn limit; the answer may be incomplete." }
  );
  assert.match(review, /Warning: grok hit its turn limit/);
});

test("renderStatusReport handles empty and populated job lists", () => {
  assert.match(renderStatusReport({ jobs: [], totalJobs: 0, activeJobs: 0 }), /No jobs recorded/);
  const rendered = renderStatusReport({
    totalJobs: 2,
    activeJobs: 1,
    jobs: [
      { id: "task-1", status: "running", title: "Grok Task", summary: "investigate", updatedAt: "t1" },
      { id: "review-1", status: "completed", title: "Grok Review", summary: "review", updatedAt: "t0" }
    ]
  });
  assert.match(rendered, /task-1 \[running\]/);
  assert.match(rendered, /review-1 \[done\]/);
});

test("renderStoredJobResult prefers stored rendering", () => {
  assert.equal(
    renderStoredJobResult({ id: "x", status: "completed" }, { rendered: "stored output\n" }),
    "stored output\n"
  );
  assert.match(
    renderStoredJobResult({ id: "x", status: "running" }, null),
    /still running/
  );
});

test("renderSetupReport lists next steps when not ready", () => {
  const rendered = renderSetupReport({
    ready: false,
    node: { available: true, version: "v22" },
    grok: { available: false, version: null },
    auth: { loggedIn: false, method: null },
    nextSteps: ["Install the Grok CLI"]
  });
  assert.match(rendered, /Ready: no/);
  assert.match(rendered, /Install the Grok CLI/);
});

test("renderSetupReport separates login file, API key and live probe", () => {
  const unverified = renderSetupReport({
    ready: true,
    verified: null,
    node: { available: true, version: "v22" },
    grok: { available: true, version: "grok 1.0.46" },
    auth: { loggedIn: true, method: "oauth", authFile: "/h/.grok/auth.json", apiKeySet: true },
    probe: null,
    nextSteps: []
  });
  assert.match(unverified, /Login file: present/);
  assert.match(unverified, /XAI_API_KEY: set \(not used by the grok CLI/);
  assert.match(unverified, /Live probe: not run/);

  const failed = renderSetupReport({
    ready: false,
    verified: false,
    node: { available: true, version: "v22" },
    grok: { available: true, version: "grok 1.0.46" },
    auth: { loggedIn: true, method: "oauth", authFile: "/h/.grok/auth.json", apiKeySet: false },
    probe: { ok: false, stopReason: "Cancelled", costUsd: null, error: "grok stopped the run (stopReason: Cancelled)." },
    nextSteps: []
  });
  assert.match(failed, /Live probe: FAILED/);

  // A failed probe without an error text must not print "null".
  const noError = renderSetupReport({
    ready: false,
    verified: false,
    node: { available: true, version: "v22" },
    grok: { available: true, version: "grok 1.0.46" },
    auth: { loggedIn: true, method: "oauth", authFile: "/h/.grok/auth.json", apiKeySet: false },
    probe: { ok: false, stopReason: null, costUsd: null, error: null },
    nextSteps: []
  });
  assert.match(noError, /Live probe: FAILED — no answer/);
  assert.doesNotMatch(noError, /null/);

  const ok = renderSetupReport({
    ready: true,
    verified: true,
    node: { available: true, version: "v22" },
    grok: { available: true, version: "grok 1.0.46" },
    auth: { loggedIn: true, method: "oauth", authFile: "/h/.grok/auth.json", apiKeySet: false },
    probe: { ok: true, stopReason: "end_turn", costUsd: 0.0312, error: null },
    nextSteps: []
  });
  assert.match(ok, /Live probe: OK \(cost \$0\.0312\)/);
});

test("renderTransferResult prints the resume command", () => {
  const rendered = renderTransferResult({
    grokSessionId: "abc",
    messageCount: 9,
    resumeCommand: "grok --resume abc"
  });
  assert.match(rendered, /grok --resume abc/);
  assert.match(rendered, /Imported messages: 9/);
});
