import { execFileSync } from "node:child_process";
export default function teardown() {
  const socket = process.env.CLOOVIES_E2E_SOCKET;
  if (socket?.startsWith("cw-e2e-")) {
    try {
      execFileSync("tmux", ["-L", socket, "kill-server"]);
    } catch {}
  }
}
