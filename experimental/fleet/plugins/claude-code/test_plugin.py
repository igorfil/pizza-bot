"""Run with: python3 -m unittest discover -s experimental/fleet/plugins/claude-code (Python 3.11+)."""

import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import plugin

PLUGIN = Path(__file__).parent / "plugin.py"

AGENT = {"model": None, "allowed_tools": [], "permission_mode": None, "system_prompt": None, "max_turns": None}

# Stands in for `claude`: prints what `claude -p --output-format stream-json` prints, and records its arguments.
FAKE_CLAUDE = """\
#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
if args == ["--version"]:
    print("2.1.0 (Claude Code)")
    sys.exit(0)
log = os.path.join(os.environ["FAKE_CLAUDE_STATE"], "calls.jsonl")
open(log, "a").write(json.dumps(args) + "\\n")
session = args[args.index("--resume") + 1] if "--resume" in args else "s-1"
prompt = args[args.index("-p") + 1]
for line in [
    {"type": "system", "subtype": "init", "model": "sonnet", "session_id": session},
    {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Read"}]}, "session_id": session},
    {"type": "result", "subtype": "success", "is_error": False, "result": "answer to " + prompt, "session_id": session},
]:
    print(json.dumps(line), flush=True)
"""


class Command(unittest.TestCase):
    def test_asks_for_streamed_json_with_the_agents_settings(self):
        agent = {**AGENT, "model": "opus", "allowed_tools": ["Read", "Grep"], "max_turns": 3}
        self.assertEqual(
            plugin.claude_command(agent, "hi", None)[1:],
            ["-p", "hi", "--output-format", "stream-json", "--verbose", "--model", "opus", "--allowedTools", "Read,Grep", "--max-turns", "3"],
        )

    def test_resumes_the_conversation_of_a_follow_up(self):
        self.assertEqual(plugin.claude_command(AGENT, "and?", "s-9")[-2:], ["--resume", "s-9"])

    def test_an_empty_input_still_sends_a_prompt(self):
        self.assertEqual(plugin.claude_command(AGENT, "", None)[2], plugin.NO_INPUT)


class Translate(unittest.TestCase):
    def test_reports_progress_tools_and_the_final_answer(self):
        lines = [
            {"type": "system", "subtype": "init", "model": "sonnet"},
            {"type": "assistant", "message": {"content": [{"type": "text", "text": "Let me look.\nmore"}]}},
            {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Grep"}]}},
            {"type": "result", "subtype": "success", "is_error": False, "result": "Done."},
        ]
        self.assertEqual(
            [e for l in lines for e in plugin.translate(json.dumps(l))],
            [
                {"status": "Claude Code started (sonnet)"},
                {"status": "Let me look."},
                {"status": "using Grep"},
                {"artifact": {"name": "reply", "text": "Done."}},
                {"status": "answered"},
            ],
        )

    def test_a_failed_result_is_an_error(self):
        self.assertEqual(plugin.translate(json.dumps({"type": "result", "subtype": "error_max_turns", "is_error": True})), [{"error": "Claude Code stopped: error_max_turns"}])

    def test_hands_on_the_session_id(self):
        seen = []
        plugin.translate(json.dumps({"type": "system", "subtype": "hook_started", "session_id": "s-7"}), seen.append)
        self.assertEqual(seen, ["s-7"])

    def test_ignores_what_isnt_stream_json(self):
        self.assertEqual(plugin.translate("warning: something"), [])


class PluginProcess(unittest.TestCase):
    """Drives plugin.py with a fake claude, the way the runner does."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        root = Path(self.dir.name)
        claude = root / "claude"
        claude.write_text(FAKE_CLAUDE)
        claude.chmod(claude.stat().st_mode | stat.S_IEXEC)
        (root / "agents" / "ask").mkdir(parents=True)
        (root / "agents" / "ask" / "agent.toml").write_text('name = "Ask"\nproject = "."\n')
        env = {
            **os.environ,
            "CLAUDE_CODE_AGENTS_DIR": str(root / "agents"),
            "CLAUDE_CODE_STATE": str(root / "sessions.json"),
            "CLAUDE": f"{sys.executable} {claude}",
            "FAKE_CLAUDE_STATE": str(root),
        }
        self.root = root
        self.proc = subprocess.Popen([sys.executable, PLUGIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=env)
        self.next_id = 0

    def tearDown(self):
        self.proc.stdin.close()
        self.proc.wait(timeout=10)
        self.proc.stdout.close()
        self.dir.cleanup()

    def request(self, method, **params):
        self.next_id += 1
        self.proc.stdin.write(json.dumps({"id": self.next_id, "method": method, "params": params}) + "\n")
        self.proc.stdin.flush()
        return self.next_id

    def read_until(self, stop):
        lines = []
        while True:
            line = json.loads(self.proc.stdout.readline())
            lines.append(line)
            if stop(line):
                return lines

    def run_task(self, task_id, context_id, text):
        self.request("run", taskId=task_id, contextId=context_id, agent="ask", input=text)
        return [l for l in self.read_until(lambda l: l.get("done")) if "id" not in l]

    def calls(self):
        return [json.loads(l) for l in (self.root / "calls.jsonl").read_text().splitlines()]

    def test_relays_a_run(self):
        self.assertEqual(
            self.run_task("t1", "c1", "hi"),
            [
                {"taskId": "t1", "status": "Claude Code started (sonnet)"},
                {"taskId": "t1", "status": "using Read"},
                {"taskId": "t1", "artifact": {"name": "reply", "text": "answer to hi"}},
                {"taskId": "t1", "status": "answered"},
                {"taskId": "t1", "done": True},
            ],
        )

    def test_a_follow_up_resumes_its_conversation_and_a_new_one_doesnt(self):
        self.run_task("t1", "c1", "first")
        self.run_task("t2", "c1", "follow-up")
        self.run_task("t3", "c2", "unrelated")
        self.assertEqual(["--resume" in c for c in self.calls()], [False, True, False])


if __name__ == "__main__":
    unittest.main()
