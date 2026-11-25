"""Run with: python3 -m unittest discover -s experimental/fleet/plugins/docker (Python 3.11+)."""

import json
import os
import stat
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path

import plugin

PLUGIN = Path(__file__).parent / "plugin.py"

# Stands in for the docker CLI: `run` speaks the agent contract (or sleeps for the "sleepy" image), `kill` stops that run.
FAKE_DOCKER = """\
#!/usr/bin/env python3
import json, os, signal, sys, time
state = os.environ["FAKE_DOCKER_STATE"]
args = sys.argv[1:]
if args[0] == "version":
    print("29.0")
elif args[0] == "kill":
    os.kill(int(open(os.path.join(state, args[1])).read()), signal.SIGTERM)
elif args[0] == "run":
    name = args[args.index("--name") + 1]
    open(os.path.join(state, name), "w").write(str(os.getpid()))
    open(os.path.join(state, "last-run.json"), "w").write(json.dumps(args))
    task = json.load(sys.stdin)
    if "sleepy" in args:
        time.sleep(60)
    print(json.dumps({"artifact": {"name": "reply", "text": "got " + task["input"]}}), flush=True)
"""


class RunCommand(unittest.TestCase):
    def test_runs_the_image_interactively_with_its_env_args_and_command(self):
        agent = {"image": "me/agent:1", "command": ["python", "agent.py"], "args": ["--network", "none"], "env": {"MODEL": "m"}}
        self.assertEqual(
            plugin.run_command(agent, "t1")[1:],
            ["run", "--rm", "-i", "--init", "--name", "fleet-t1", "--env", "MODEL=m", "--env", "FLEET_TASK_ID=t1", "--network", "none", "me/agent:1", "python", "agent.py"],
        )

    def test_names_the_container_after_the_run_in_characters_docker_accepts(self):
        self.assertEqual(plugin.container_name("schedule:laptop/a:2026-11-25"), "fleet-schedule-laptop-a-2026-11-25")


class LoadAgent(unittest.TestCase):
    def test_an_agent_without_an_image_is_skipped(self):
        with tempfile.TemporaryDirectory() as d:
            Path(d, "agent.toml").write_text('name = "No image"\n')
            self.assertIsNone(plugin.load_agent(Path(d)))


class PluginProcess(unittest.TestCase):
    """Drives plugin.py with a fake docker, the way the runner does."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        root = Path(self.dir.name)
        (root / "state").mkdir()
        docker = root / "docker"
        docker.write_text(FAKE_DOCKER)
        docker.chmod(docker.stat().st_mode | stat.S_IEXEC)
        for agent_id, image in [("echo", "me/echo:1"), ("sleepy", "sleepy")]:
            (root / "agents" / agent_id).mkdir(parents=True)
            (root / "agents" / agent_id / "agent.toml").write_text(f'name = "{agent_id}"\nimage = "{image}"\n[env]\nMODEL = "m"\n')
        env = {**os.environ, "DOCKER_AGENTS_DIR": str(root / "agents"), "DOCKER": f"{sys.executable} {docker}", "FAKE_DOCKER_STATE": str(root / "state")}
        self.state = root / "state"
        self.proc = subprocess.Popen([sys.executable, PLUGIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=env)
        self.next_id = 0

    def tearDown(self):
        self.proc.stdin.close()
        self.proc.wait(timeout=15)
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

    def reply(self, method, **params):
        rid = self.request(method, **params)
        return self.read_until(lambda l: l.get("id") == rid)[-1]

    def test_is_healthy_when_the_daemon_answers(self):
        self.assertEqual(self.reply("health")["result"], {"ok": True, "detail": "Docker 29.0, 2 agents"})

    def test_runs_the_container_and_relays_what_it_says(self):
        self.request("run", taskId="t1", contextId="c", agent="echo", input="hi")
        events = [l for l in self.read_until(lambda l: l.get("done")) if "id" not in l]
        args = json.loads((self.state / "last-run.json").read_text())
        self.assertEqual(
            (events, args[args.index("--name") + 1], "MODEL=m" in args),
            ([{"taskId": "t1", "artifact": {"name": "reply", "text": "got hi"}}, {"taskId": "t1", "done": True}], "fleet-t1", True),
        )

    def test_cancel_kills_the_container(self):
        self.request("run", taskId="t2", contextId="c", agent="sleepy", input="")
        while not (self.state / "fleet-t2").exists():
            time.sleep(0.1)
        started = time.monotonic()
        self.request("cancel", taskId="t2")
        events = [l for l in self.read_until(lambda l: l.get("done")) if "id" not in l]
        self.assertEqual((events, time.monotonic() - started < 5), ([{"taskId": "t2", "done": True}], True))


if __name__ == "__main__":
    unittest.main()
