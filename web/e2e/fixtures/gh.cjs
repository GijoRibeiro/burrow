#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const { join } = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "api") {
  if (args.some((arg) => arg.startsWith("user/repos?"))) {
    if (!args.includes("--paginate")) process.exit(1);
    const repos = Array.from({ length: 65 }, (_, i) => ({
      fullName: `fixture/repo-${String(i).padStart(2, "0")}`,
      name: `repo-${String(i).padStart(2, "0")}`,
      description: `Repository ${i} for the team`,
      private: i % 2 === 0,
      archived: false,
    }));
    repos.push({
      fullName: "team/burrow",
      name: "burrow",
      description: "A home for your terminal companions",
      private: true,
      archived: false,
    });
    repos.push({
      fullName: "team/slow",
      name: "slow",
      description: "A large clone",
      private: false,
      archived: false,
    });
    process.stdout.write(repos.map((repo) => JSON.stringify(repo)).join("\n"));
  } else process.stdout.write(JSON.stringify({ login: "fixture-user" }));
} else if (args[0] === "repo" && args[1] === "clone") {
  if (args[2].endsWith("/slow")) {
    process.stderr.write("Receiving objects: 12% (12/100)\r");
    setInterval(() => {}, 1000);
  } else {
    execFileSync(
      "git",
      [
        "clone",
        "--progress",
        join(process.env.CLOOVIES_E2E_ROOT, "Checkout"),
        args[3],
      ],
      { stdio: "inherit" },
    );
  }
} else process.exit(1);
