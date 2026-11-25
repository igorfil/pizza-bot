"""Run with: python3 -m unittest discover -s experimental/fleet/plugins/python (Python 3.11+)."""

import json
import os
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path

import plugin

PLUGIN = Path(__file__).parent / "plugin.py"


class ContractEvents(unittest.TestCase):
    def test_reads_status_artifact_and_error_lines(self):
        lines = ['{"status": "step 1"}', '{"artifact": {"name": "r", "text": "hi"}}', '{"error": "boom"}']
        self.assertEqual(
            [plugin.contract_event(l) for l in lines],
            [{"status": "step 1"}, {"artifact": {"name": "r", "text": "hi"}}, {"error": "boom"}],
        )

    def test_ignores_lines_that_arent_events(self):
        self.assertEqual([plugin.contract_event(l) for l in ["Resolved 3 packages", "[1]", '{"progress": 1}']], [None, None, None])


class Failure(unittest.TestCase):
    def test_a_clean_exit_succeeds(self):
        self.assertIsNone(plugin.failure(0, False, "noise"))

    def test_an_error_event_already_says_why(self):
        self.assertIsNone(plugin.failure(1, True, "Traceback"))

    def test_a_crash_reports_the_last_stderr_line(self):
        self.assertEqual(plugin.failure(1, False, "KeyError: x"), "KeyError: x")

    def test_a_crash_without_stderr_reports_the_code(self):
        self.assertEqual(plugin.failure(2, False, None), "exited with code 2")


class DefaultCommand(unittest.TestCase):
    def test_a_script_with_inline_dependencies_runs_with_uv(self):
        with tempfile.TemporaryDirectory() as d:
            Path(d, "agent.py").write_text("# /// script\n# dependencies = []\n# ///\n")
            self.assertEqual(plugin.default_command(Path(d)), "uv run --quiet agent.py")

    def test_a_plain_script_runs_with_this_python(self):
        with tempfile.TemporaryDirectory() as d:
            Path(d, "agent.py").write_text("print()\n")
            self.assertTrue(plugin.default_command(Path(d)).endswith(" agent.py"))


AGENTS = {
    "echo": (
        'name = "Echo"\n[input]\nlabel = "Text"\n',
        """
        import json, sys
        task = json.load(sys.stdin)
        print(json.dumps({"status": "echoing"}), flush=True)
        print(json.dumps({"artifact": {"name": "reply", "text": task["input"]}}), flush=True)
        """,
    ),
    "crash": ('name = "Crash"\n', 'import sys\nprint("it broke", file=sys.stderr)\nsys.exit(1)\n'),
    "sleepy": ('name = "Sleepy"\n', "import time\ntime.sleep(60)\n"),
}


class PluginProcess(unittest.TestCase):
    """Drives plugin.py the way the runner does: requests in, replies and run events out."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        for agent_id, (manifest, script) in AGENTS.items():
            folder = Path(self.dir.name, agent_id)
            folder.mkdir()
            (folder / "agent.toml").write_text(manifest)
            (folder / "agent.py").write_text(textwrap.dedent(script))
        env = {**os.environ, "PYTHON_AGENTS_DIR": self.dir.name}
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

    def run_task(self, task_id, agent, text=""):
        self.request("run", taskId=task_id, contextId="c", agent=agent, input=text)
        return [l for l in self.read_until(lambda l: l.get("done")) if "id" not in l]

    def test_lists_the_agents_in_its_folder(self):
        rid = self.request("agents")
        reply = self.read_until(lambda l: l.get("id") == rid)[-1]
        self.assertEqual([(a["id"], a["name"]) for a in reply["result"]["agents"]], [("crash", "Crash"), ("echo", "Echo"), ("sleepy", "Sleepy")])

    def test_runs_an_agent_and_relays_its_events(self):
        self.assertEqual(
            self.run_task("t1", "echo", "hello"),
            [
                {"taskId": "t1", "status": "echoing"},
                {"taskId": "t1", "artifact": {"name": "reply", "text": "hello"}},
                {"taskId": "t1", "done": True},
            ],
        )

    def test_a_crashed_agent_fails_with_its_last_stderr_line(self):
        self.assertEqual(self.run_task("t2", "crash"), [{"taskId": "t2", "error": "it broke"}, {"taskId": "t2", "done": True}])

    def test_refuses_an_agent_it_doesnt_have(self):
        rid = self.request("run", taskId="t3", agent="nope")
        self.assertIn("nope", self.read_until(lambda l: l.get("id") == rid)[-1]["error"])

    def test_cancel_stops_a_run_without_reporting_it_failed(self):
        self.request("run", taskId="t4", contextId="c", agent="sleepy", input="")
        time.sleep(0.5)
        started = time.monotonic()
        self.request("cancel", taskId="t4")
        events = [l for l in self.read_until(lambda l: l.get("done")) if "id" not in l]
        self.assertEqual((events, time.monotonic() - started < 5), ([{"taskId": "t4", "done": True}], True))


if __name__ == "__main__":
    unittest.main()
