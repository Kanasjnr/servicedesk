---
# One line. Becomes the link text in the README index.
title: "<What goes wrong, in the user's words>"
# One sentence naming the situation. Becomes the "Covers" cell in the README index.
when_to_use: "<The error or situation that should bring a reader here>"
audience: "developers support-agents"
owner: "mn-servicedesk"
# The day the investigation was written up. All dates are UTC.
compiled: "YYYY-MM-DD"
# The last day a person re-read the runbook against its sources. The daily check does not move it.
last_reviewed: "YYYY-MM-DD"
# Exact substrings a user would paste. Triage greps for these, and the README lookup is built from them.
# For a failure with no message, such as a hang, list the phrases or method names a reporter would write.
error_strings:
  - "<exact error text>"
# Events that make this runbook wrong and that no Key identifiers row can see.
review_when:
  - "<what would have to change, and what to re-check>"
---

<!--
HOW TO USE THIS TEMPLATE

Copy it to runbooks/<area>-<short-topic>-runbook/<area>-<short-topic>-runbook.md, fill it, and delete every comment. A runbook is this one file, plus a scripts/ folder if a step needs a script. There is no evidence file and no separate list of facts.

The reader is mid-incident: a developer, a support engineer, or an agent working in a user's environment. They pay for every word before the first command, and an agent pays on every run. Keep the file under 2,000 words after the front matter.

Three rules keep it from going stale:

1. Store fewer facts. If the docs, a repo or an issue already holds a fact, link it and repeat nothing. A fact you do not store cannot go wrong.
2. Write conditions, not statements about the world. "If the error names the old host, the config has not moved" stays true. "The old host returns 410" is false the day the host changes. A date in a step is a sign of a statement.
3. Every fact you do store is a row in Key identifiers, with a public source and the exact text that must be in it. A script tests the rows daily. Trace each fact to a source you opened today: memory is not a source, for a person or for an agent.

Link other runbooks, scripts and repo files by their full GitHub URL, `https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/...`, not a relative path: a runbook is often read outside the repo, pasted to an agent or indexed on its own, where a relative path has nothing to resolve against. Links to files your pull request adds 404 until it merges.

A claim with no source says so in place: measured, reported by someone named, inferred, or not tested. The investigation, the measurements, the corrections and the advice you retired belong in the pull request and git history, not in a file beside the runbook. Link an issue or a commit under Reference material if a reader may want them.

Before writing: check that the problem recurs or took real investigation, and grep runbooks/ for the error text. Extend the runbook that owns a mechanism instead of explaining it twice. If the docs already cover the fix, write only what they leave out.

BEFORE YOU OPEN THE PULL REQUEST

1. Add the runbook to the README index and its strings to the Error-string lookup:
   node runbooks/authoring/check-runbook.mjs runbooks/<name>-runbook --print-readme-rows
2. Run the check. It must exit 0, with every fact as "holds":
   node runbooks/authoring/check-runbook.mjs runbooks/<name>-runbook
3. Cold read. Give a fresh agent or a colleague this file and nothing else, with two or three user reports written the way users write: the main symptom, a look-alike, and a confusing case. Ask for the steps they would take for each, then lists of every question the file did not answer, guess, contradiction, unsafe step, dead end, and fact without a source. Fix each one in the runbook. The check cannot do this part.
4. In the pull request, lead with any decision a reviewer must make. Then say what you verified today, what you corrected, and what you could not check.

WHEN A FACT CHANGES

The runbook-facts workflow opens an issue naming the source that stopped matching. Read the source, re-read the steps that rely on that row, fix the one place the fact lives, and say what was wrong in the commit message. When restructuring an older runbook, move facts instead of rewriting them, and label anything you cannot re-verify.
-->

# Runbook: <title>

<Two or three sentences: what breaks, why in one clause, and what the fix is. A reader decides here whether to keep reading.>

Each fact is in Key identifiers with its source. A claim marked **measured**, **reported**, **inferred** or **not tested** has none, so trust it less.

## Symptom

<!-- The exact text a user would paste, each row routed to a step. Put the same strings in error_strings. -->

| If you see | Go to |
|---|---|
| `<exact error text>` | Diagnose 1 |

### Not this runbook

<!-- The look-alikes: how to tell each apart and where it goes instead. Symptoms overlap, and a wrong match that touches mainnet costs real money. -->

- **<Look-alike>.** <How to tell.> See <link>.

## Root cause

<!-- The mechanism in a few sentences, enough for a reader to confirm it matches their case. Function names are fine. No line numbers, commit hashes or measurement tables. -->

1. **<Mechanism>.** <One or two sentences.>

## Before you start

<!-- Scope every safety statement to the steps it covers. If a fix discards anything, say what must be held first. A token or a seed is never asked for: see AGENTS.md. -->

- **You need** <tools, access, versions>.
- **Safety.** <Which steps are read-only, which sign or submit, and what the user must run themselves.>

## Diagnose

<!-- Each step: a command, the output to expect, and what each outcome means. The command must print what the expectation names. Every branch ends at a step, another runbook, or Stop and escalate. A command that looks for a secret counts matches or cuts the value off, and never prints it: an agent's transcript is a log. -->

1. **<Question the step answers>**

   ```sh
   <command>
   ```

   Expect <output>. <Other outcome> means <what>, go to <where>.

## Remediation

<!-- Least invasive first. Every option states its trade-off. Anything that signs or submits defaults to a dry run and is run by the user. -->

1. **<Fix>.** <Steps.>

   *Trade-off:* <what it costs>.

## Confirm fixed

<!-- What the reader must observe before calling it done. Observations, not "the steps ran". Cover every row of the Symptom table. -->

- <Observable result and how to see it.>

## Stop and escalate

<!-- Which results rule this cause out, what never to do as a workaround, and what to hand over. Include each symptom surviving its own fix, and a source that disagrees with its row. -->

Open an issue at the [servicedesk front door](https://github.com/midnightntwrk/servicedesk/issues/new/choose) when:

- <Condition that means this runbook's cause is ruled out.>
- A source in Key identifiers disagrees with its row and no step covers that.

Include <the outputs that let the next person start where you stopped>. Remove any token first.

## Key identifiers

<!--
One row per fact and source. The source cell holds one reference in backticks, and "Must contain" holds the exact text in backticks, as small as the fact depends on: a signature or a constant name, not a whole block.

  `github:<owner>/<repo>/<path>`   a file on the default branch of a public repo
  `npm:<package>/<path>`           a file in the package's latest published release
  `npm:<package>@<version>/<path>` a file in that exact release
  `issue:<owner>/<repo>#<n>`       must contain `open` or `closed`

Pin an npm row to a version when the fact is about the version that works with a network today: latest is often ahead of it, so an unpinned row can hold while the supported version says something else. Leave it unpinned when the reader installs latest and you want to hear when a release changes the fact.

The text cannot contain a backtick. Write a pipe as \|. Use an issue row for "this fix has not shipped". A row with no such reference is not tested, so keep those for sources that need a login.
-->

Each row names a public source and text it must contain: a repo file (`github:`), a published package file (`npm:`), or an issue's state (`issue:`). [check-runbook.mjs](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/authoring/check-runbook.mjs) tests every row daily against each source's newest version, or the npm version a row pins. For your installed version, look under `node_modules/<package>/<path>`. If a source disagrees with a row, the source is right.

| Fact this runbook relies on | Source of truth | Must contain |
|---|---|---|
| <fact> | `github:<owner>/<repo>/<path>` | `<exact text>` |
| <fact> | `npm:<package>/<path>` | `<exact text>` |
| <a fix has not shipped> | `issue:<owner>/<repo>#<n>` | `open` |

## Reference material

<!-- Only what a reader may need and no row covers: the issue or commit that records a measurement, and any script. A script is Node with no install, says in its header what it reads and that it signs nothing, and exits 0 clean, 2 finding, 1 could not run. -->

- **Measurements:** <the issue or commit where the numbers behind a "measured" claim are recorded>
- **Script:** [scripts/<name>.mjs](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/<area>-<short-topic>-runbook/scripts/<name>.mjs) <what it does>
