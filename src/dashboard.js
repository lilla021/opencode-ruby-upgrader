import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { dashboardPage } from "./dashboard-page.js";
import { readRun } from "./run-state.js";

const MAX_RUN_FILES = 250;
const MAX_RUN_BYTES = 1024 * 1024;

function localCommitLinks(root) {
  try {
    const output = execFileSync("git", ["log", "--max-count=250", "--format=%H%x1f%B%x1e"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 2 * 1024 * 1024 });
    return output.split("\x1e").reduce((links, entry) => {
      const [sha, message] = entry.split("\x1f");
      const match = message?.match(/^Ruby-Upgrade-Report:\s+(.+)$/m);
      if (sha && match) (links[match[1].trim()] ??= []).push(sha);
      return links;
    }, {});
  } catch { return {}; }
}

export function readUpgradeRuns(root = process.cwd()) {
  const directory = path.join(root, ".ruby-upgrades", "runs");
  if (!fs.existsSync(directory)) return [];
  const commits = localCommitLinks(root);
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .slice(0, MAX_RUN_FILES)
    .flatMap((entry) => {
      const filePath = path.join(directory, entry.name);
      try {
        if (fs.statSync(filePath).size > MAX_RUN_BYTES) return [];
        const relativePath = path.join(".ruby-upgrades", "runs", entry.name);
        const parsed = readRun(root, relativePath);
        return [{ ...parsed, file: entry.name, localCommits: commits[relativePath] ?? [] }];
      }
      catch { return []; }
    })
    .sort((a, b) => String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? "")));
}

export function startDashboard({ root = process.cwd(), port = 0 } = {}) {
  const server = http.createServer((request, response) => {
    const securityHeaders = {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    };
    if (request.method !== "GET") {
      response.writeHead(405, { ...securityHeaders, allow: "GET", "content-type": "text/plain; charset=utf-8" });
      return response.end("Method not allowed");
    }
    if (request.url === "/api/runs") {
      response.writeHead(200, { ...securityHeaders, "content-type": "application/json; charset=utf-8" });
      return response.end(JSON.stringify(readUpgradeRuns(root)));
    }
    if (request.url === "/" || request.url === "/index.html") {
      response.writeHead(200, { ...securityHeaders, "content-type": "text/html; charset=utf-8" });
      return response.end(dashboardPage);
    }
    response.writeHead(404, { ...securityHeaders, "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}
