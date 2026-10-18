function heading(text) {
  return `## ${text}`;
}

function statusEmoji(status) {
  switch (status) {
    case "completed":
      return "done";
    case "failed":
      return "FAILED";
    case "cancelled":
      return "cancelled";
    case "running":
      return "running";
    case "queued":
      return "queued";
    default:
      return status ?? "unknown";
  }
}

export function renderSetupReport(report) {
  const lines = [heading("Grok Companion Setup"), ""];
  lines.push(`- Node.js: ${report.node.available ? report.node.version ?? "available" : "missing"}`);
  lines.push(
    `- Grok CLI: ${report.grok.available ? report.grok.version ?? "available" : "not found on PATH"}`
  );
  lines.push(`- Login file: ${report.auth.loggedIn ? `present (${report.auth.authFile})` : "missing"}`);
  if (report.auth.apiKeySet) {
    // Existence only -- the value never leaves the environment.
    lines.push("- XAI_API_KEY: set (not used by the grok CLI per measurement on 2026-09-27; not counted as sign-in)");
  }
  if (report.probe) {
    const cost = report.probe.costUsd != null ? ` (cost $${report.probe.costUsd.toFixed(4)})` : "";
    lines.push(report.probe.ok ? `- Live probe: OK${cost}` : `- Live probe: FAILED — ${report.probe.error ?? "no answer (non-zero exit status)"}`);
  } else {
    lines.push("- Live probe: not run — sign-in not verified");
  }
  lines.push(`- Ready: ${report.ready ? "yes" : "no"}`);

  if (report.actionsTaken?.length) {
    lines.push("", heading("Actions Taken"), "");
    for (const action of report.actionsTaken) {
      lines.push(`- ${action}`);
    }
  }

  if (report.nextSteps?.length) {
    lines.push("", heading("Next Steps"), "");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function renderFinding(finding, index) {
  const location =
    finding.line_start === finding.line_end
      ? `${finding.file}:${finding.line_start}`
      : `${finding.file}:${finding.line_start}-${finding.line_end}`;
  return [
    `### ${index + 1}. [${finding.severity}] ${finding.title}`,
    "",
    `- Location: ${location}`,
    `- Confidence: ${Math.round(Number(finding.confidence ?? 0) * 100)}%`,
    "",
    finding.body,
    "",
    `Recommendation: ${finding.recommendation || "(none)"}`
  ].join("\n");
}

export function renderReviewResult(parsed, { reviewLabel, targetLabel, grokSessionId, warning = null }) {
  const lines = [heading(`Grok ${reviewLabel}`), "", `Target: ${targetLabel}`];
  if (grokSessionId) {
    lines.push(`Grok session: ${grokSessionId} (resume with \`grok --resume ${grokSessionId}\`)`);
  }
  if (warning) {
    lines.push(`Warning: ${warning}`);
  }
  lines.push("");

  if (parsed.parseError) {
    lines.push(`The review did not return valid structured output: ${parsed.parseError}`, "");
    if (parsed.rawOutput) {
      lines.push("Raw output:", "", "```", parsed.rawOutput.trim(), "```");
    }
    return `${lines.join("\n")}\n`;
  }

  const result = parsed.result;
  lines.push(`Verdict: ${result.verdict}`);
  lines.push("", result.summary, "");

  if (result.findings?.length) {
    lines.push(heading(`Findings (${result.findings.length})`), "");
    result.findings.forEach((finding, index) => {
      lines.push(renderFinding(finding, index), "");
    });
  } else {
    lines.push("No material findings.", "");
  }

  if (result.next_steps?.length) {
    lines.push(heading("Next Steps"), "");
    for (const step of result.next_steps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

// Grok predicts these gaps; nobody has run the mutations yet. The label says
// so on every gap, because the reader acts on each one separately.
export function renderTestGapsResult(parsed, { targetLabel, grokSessionId, warning = null }) {
  const lines = [heading("Grok Test-Gap Review"), "", `Target: ${targetLabel}`];
  if (grokSessionId) {
    lines.push(`Grok session: ${grokSessionId} (resume with \`grok --resume ${grokSessionId}\`)`);
  }
  if (warning) {
    lines.push(`Warning: ${warning}`);
  }
  lines.push("");

  if (parsed.parseError) {
    lines.push(`The review did not return valid structured output: ${parsed.parseError}`, "");
    if (parsed.rawOutput) {
      lines.push("Raw output:", "", "```", parsed.rawOutput.trim(), "```");
    }
    return `${lines.join("\n")}\n`;
  }

  const result = parsed.result;
  lines.push(result.summary, "");
  if (!result.gaps?.length) {
    lines.push("No test gaps predicted.");
    return `${lines.join("\n")}\n`;
  }

  lines.push(heading(`Predicted gaps (${result.gaps.length})`), "");
  result.gaps.forEach((gap, index) => {
    const list = (tests) => (tests?.length ? tests.join("; ") : "(none predicted)");
    lines.push(
      `### ${index + 1}. ${gap.mutation}`,
      "",
      "_Vorhersage, nicht gemessen._",
      "",
      `- Location: ${gap.file}:${gap.line}`,
      `- Confidence: ${Math.round(Number(gap.confidence ?? 0) * 100)}%`,
      `- Stays green: ${list(gap.surviving_tests)}`,
      `- Breaks: ${list(gap.breaking_tests)}`,
      `- Suggested test: ${gap.suggested_test}`,
      ""
    );
  });
  return `${lines.join("\n")}\n`;
}

export function renderTaskResult({ rawOutput, failureMessage, grokSessionId, warning = null }, { title, jobId, write }) {
  const lines = [heading(title), ""];
  if (jobId) {
    lines.push(`Job: ${jobId}`);
  }
  lines.push(`Mode: ${write ? "write-enabled" : "read-only investigation"}`);
  if (grokSessionId) {
    lines.push(`Grok session: ${grokSessionId} (resume with \`grok --resume ${grokSessionId}\`)`);
  }
  if (warning) {
    lines.push(`Warning: ${warning}`);
  }
  lines.push("");

  if (failureMessage) {
    lines.push(`Grok reported a failure: ${failureMessage}`, "");
  }
  if (rawOutput?.trim()) {
    lines.push(rawOutput.trim());
  } else if (!failureMessage) {
    lines.push("(grok returned no output)");
  }

  return `${lines.join("\n")}\n`;
}

// Nothing has been applied when this is shown; the reader decides. The last
// line says so explicitly, in both outcomes.
export function renderProposalResult({ parsed, check, grokSessionId, warning = null, failure = null }, { jobId }) {
  const lines = [heading("Grok Proposal"), ""];
  if (jobId) {
    lines.push(`Job: ${jobId}`);
  }
  lines.push("Mode: proposal — grok changed no file");
  if (grokSessionId) {
    lines.push(`Grok session: ${grokSessionId} (resume with \`grok --resume ${grokSessionId}\`)`);
  }
  if (warning) {
    lines.push(`Warning: ${warning}`);
  }
  lines.push("");

  if (parsed.parseError) {
    lines.push(`Grok did not return a valid proposal: ${parsed.parseError}`, "");
    if (failure) {
      lines.push(`Grok reported a failure: ${failure}`, "");
    }
    if (parsed.rawOutput) {
      lines.push("Raw output:", "", "```", parsed.rawOutput.trim(), "```");
    }
    return `${lines.join("\n")}\n`;
  }

  const proposal = parsed.result;
  lines.push(proposal.summary, "");
  if (check) {
    lines.push(`Patch file: ${check.patchFile}`);
    lines.push(check.ok ? "git apply --check: OK — not applied yet" : `git apply --check: FAILED — ${check.output}`);
    if (check.stat) {
      lines.push("", "```", check.stat, "```");
    }
  }
  if (proposal.tests_to_run?.length) {
    lines.push("", heading("Tests to run"), "");
    for (const command of proposal.tests_to_run) {
      lines.push(`- \`${command}\``);
    }
  }
  if (proposal.risks?.length) {
    lines.push("", heading("Risks to check"), "");
    for (const risk of proposal.risks) {
      lines.push(`- ${risk}`);
    }
  }
  if (failure) {
    lines.push("", `Grok reported a failure: ${failure}`);
  }
  lines.push(
    "",
    check?.ok && !failure
      ? `Review the patch, then apply it with \`git apply --ignore-whitespace "${check.patchFile}"\`.`
      : "Do not apply this patch. Ask grok to fix it (`--resume-last --propose`) or change it yourself."
  );
  return `${lines.join("\n")}\n`;
}

export function renderStatusReport(snapshot) {
  const lines = [heading("Grok Jobs"), ""];
  if (!snapshot.jobs.length) {
    lines.push("No jobs recorded for this workspace.");
    return `${lines.join("\n")}\n`;
  }

  lines.push(`Active: ${snapshot.activeJobs} | Total: ${snapshot.totalJobs}`, "");
  for (const job of snapshot.jobs) {
    const when = job.updatedAt ?? job.createdAt ?? "";
    lines.push(`- ${job.id} [${statusEmoji(job.status)}] ${job.title} — ${job.summary ?? ""} (${when})`);
  }
  lines.push("", "Use /grok:result <job-id> for output, /grok:cancel <job-id> to stop a running job.");
  return `${lines.join("\n")}\n`;
}

export function renderJobStatusReport(job) {
  const lines = [
    heading(`Job ${job.id}`),
    "",
    `- Title: ${job.title}`,
    `- Status: ${statusEmoji(job.status)} (${job.phase ?? "?"})`,
    `- Summary: ${job.summary ?? "(none)"}`,
    `- Created: ${job.createdAt ?? "?"}`,
    `- Updated: ${job.updatedAt ?? "?"}`
  ];
  if (job.grokSessionId) {
    lines.push(`- Grok session: ${job.grokSessionId}`);
  }
  if (job.errorMessage) {
    lines.push(`- Error: ${job.errorMessage}`);
  }
  if (job.logFile) {
    lines.push(`- Log: ${job.logFile}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderStoredJobResult(job, storedJob) {
  if (!storedJob) {
    if (job.status === "queued" || job.status === "running") {
      return `Job ${job.id} is still ${job.status}. Check /grok:status ${job.id} for progress.\n`;
    }
    return `No stored output found for job ${job.id} (status: ${job.status}).\n`;
  }
  if (storedJob.rendered) {
    return storedJob.rendered;
  }
  if (storedJob.errorMessage) {
    return `Job ${job.id} ${storedJob.status}: ${storedJob.errorMessage}\n`;
  }
  return `Job ${job.id} finished with no stored output.\n`;
}

export function renderCancelReport(job) {
  return `Cancelled ${job.id} (${job.title}).${
    job.grokSessionId ? ` The partial grok session ${job.grokSessionId} remains resumable with \`grok --resume ${job.grokSessionId}\`.` : ""
  }\n`;
}

export function renderTransferResult(payload) {
  return [
    "Transferred the Claude Code session into a Grok session.",
    `Grok session ID: ${payload.grokSessionId}`,
    `Imported messages: ${payload.messageCount}`,
    `Resume in Grok: ${payload.resumeCommand}`
  ].join("\n") + "\n";
}
