#!/usr/bin/env node
// Refreshes the block between the START/END markers in README.md from PUBLIC data only:
//   - GitHub REST: the user's public, non-fork, non-archived repositories (never private ones),
//     their languages and their recent commits;
//   - korantix.io: liveness of the public health endpoint (status + response time; no version is published).
// Zero dependencies (Node >= 20, global fetch). Writes README.md only when the visible content changed,
// so the scheduled workflow does not create empty commits.
import { readFile, writeFile } from "node:fs/promises";

const USER = process.env.PROFILE_USER || "UmutBecan";
const TOKEN = process.env.GITHUB_TOKEN || "";
const README = process.env.README_PATH || "README.md";
const HEALTH_URL = process.env.HEALTH_URL || "https://korantix.io/api/health";
const START = "<!-- START_DYNAMIC_PORTFOLIO -->";
const END = "<!-- END_DYNAMIC_PORTFOLIO -->";
const STAMP = /^_Last refreshed: .*_$/m;

async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": `${USER}-profile-sync`,
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub ${path} -> HTTP ${res.status}`);
  return res.json();
}

async function health() {
  // No response time in the text: it changes on every run and would create a commit every six hours.
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(10_000), headers: { "user-agent": `${USER}-profile-sync` } });
    return res.ok ? `🟢 Operational · HTTP ${res.status} on \`/api/health\`` : `🟠 Degraded · HTTP ${res.status} on \`/api/health\``;
  } catch {
    return "🔴 Not reachable from GitHub Actions at the last check";
  }
}

const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();

async function build() {
  // /users/:user/repos lists public repositories only, whatever the token can see.
  const repos = (await gh(`/users/${USER}/repos?type=owner&sort=pushed&per_page=100`))
    .filter((r) => !r.fork && !r.archived && !r.private && r.name !== USER);

  const since30 = new Date(Date.now() - 30 * 864e5).toISOString();
  const since7 = Date.now() - 7 * 864e5;
  const langBytes = new Map();
  let commits30 = 0;
  let capped = false;
  const recent = [];

  for (const r of repos) {
    const langs = await gh(`/repos/${USER}/${r.name}/languages`);
    for (const [lang, bytes] of Object.entries(langs)) langBytes.set(lang, (langBytes.get(lang) ?? 0) + bytes);
    const list = await gh(`/repos/${USER}/${r.name}/commits?author=${USER}&since=${since30}&per_page=100`);
    commits30 += list.length;
    if (list.length === 100) capped = true;
    for (const c of list) {
      const when = Date.parse(c.commit.author?.date ?? c.commit.committer?.date ?? 0);
      if (when >= since7) recent.push({ when, repo: r.name, subject: c.commit.message.split("\n")[0] });
    }
  }

  const totalBytes = [...langBytes.values()].reduce((a, b) => a + b, 0) || 1;
  const languages = [...langBytes.entries()].filter(([, b]) => b / totalBytes >= 0.01).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([l, b]) => `${l} ${((b / totalBytes) * 100).toFixed(0)}%`).join(" · ");

  // The curated "Open tools" table above the markers already lists the repositories; this block adds only what changes:
  // product liveness, activity and the most recent commits (no second repository list).
  const focus = recent.sort((a, b) => b.when - a.when).slice(0, 5)
    .map((c) => `- \`${c.repo}\`: ${esc(c.subject)}`);

  return [
    "### Live status and activity",
    "",
    `- [Korantix](https://korantix.io): ${await health()}`,
    `- Public commits in the last 30 days: **${commits30}${capped ? "+" : ""}** · languages by code size: ${languages || "none"}`,
    "",
    "### Current engineering focus (last 7 days)",
    "",
    ...(focus.length ? focus : ["- No public commits in the last 7 days; most work happens in private product repositories."]),
  ].join("\n");
}

const readme = await readFile(README, "utf8");
const a = readme.indexOf(START);
const b = readme.indexOf(END);
if (a < 0 || b < a) throw new Error(`Markers ${START} / ${END} not found in ${README}`);

const body = await build();
const current = readme.slice(a + START.length, b).replace(STAMP, "").trim();
if (current === body.trim()) {
  console.log("profile: no change");
} else {
  const stamp = `_Last refreshed: ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC · public data only · [how](scripts/sync-profile.mjs)_`;
  const next = `${readme.slice(0, a + START.length)}\n${body}\n\n${stamp}\n${readme.slice(b)}`;
  await writeFile(README, next);
  console.log("profile: README updated");
}
