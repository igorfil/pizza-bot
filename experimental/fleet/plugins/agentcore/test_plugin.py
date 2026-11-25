"""Run with: uv run --with boto3 python -m unittest discover -s experimental/fleet/plugins/agentcore
(the Stubber tests need boto3 and are skipped without it)."""

import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

import plugin

PLUGIN = Path(__file__).parent / "plugin.py"
ARN = "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/support_agent-AbC123"
AGENT = {"id": "support", "arn": ARN, "qualifier": "DEFAULT", "region": "us-west-2", "payload_key": "prompt"}

try:
    import boto3
    from botocore.response import StreamingBody
    from botocore.stub import Stubber
except ImportError:
    boto3 = None


class Arn(unittest.TestCase):
    def test_reads_the_region_from_the_runtime_arn(self):
        self.assertEqual([plugin.region_of(ARN), plugin.region_of("arn:aws:s3:::bucket"), plugin.region_of("nope")], ["us-west-2", None, None])


class Sessions(unittest.TestCase):
    def test_one_conversation_is_one_session_long_enough_for_agentcore(self):
        a, b, other = plugin.session_id("support", "c1"), plugin.session_id("support", "c1"), plugin.session_id("support", "c2")
        self.assertEqual((a == b, a == other, len(a) >= 33), (True, False, True))


class Replies(unittest.TestCase):
    def test_takes_the_text_from_a_json_reply(self):
        self.assertEqual([plugin.reply_text("hi"), plugin.reply_text({"result": "ok"}), plugin.reply_text({"n": 1})], ["hi", "ok", '{"n": 1}'])

    def test_streamed_text_becomes_one_reply_and_contract_events_pass_through(self):
        lines = ["data: {\"status\": \"thinking\"}", ": keepalive", 'data: "Hel"', 'data: "lo"']
        self.assertEqual(list(plugin.stream_events(lines)), [{"status": "thinking"}, {"artifact": {"name": "reply", "text": "Hello"}}])

    def test_a_json_error_reply_fails_the_run(self):
        response = {"contentType": "application/json", "response": io.BytesIO(b'{"error": "quota"}')}
        self.assertEqual(list(plugin.relay(response)), [{"error": "quota"}])


class LoadAgent(unittest.TestCase):
    def test_an_agent_without_a_runtime_arn_is_skipped(self):
        with tempfile.TemporaryDirectory() as d:
            Path(d, "agent.toml").write_text('name = "No ARN"\n')
            self.assertIsNone(plugin.load_agent(Path(d)))

    def test_takes_the_region_from_the_arn(self):
        with tempfile.TemporaryDirectory() as d:
            Path(d, "agent.toml").write_text(f'name = "Support"\nruntime_arn = "{ARN}"\n')
            agent = plugin.load_agent(Path(d))
            self.assertEqual((agent["region"], agent["qualifier"]), ("us-west-2", "DEFAULT"))


@unittest.skipIf(boto3 is None, "needs boto3")
class AgainstTheApiModel(unittest.TestCase):
    """botocore's Stubber checks every call against the real bedrock-agentcore API model."""

    def setUp(self):
        self.client = boto3.client("bedrock-agentcore", region_name="us-west-2", aws_access_key_id="x", aws_secret_access_key="x")
        self.stub = Stubber(self.client)
        self.original = plugin.client
        plugin.client = lambda _region: self.client

    def tearDown(self):
        plugin.client = self.original

    def body(self, payload: bytes) -> StreamingBody:
        return StreamingBody(io.BytesIO(payload), len(payload))

    def test_invokes_the_runtime_in_the_conversations_session(self):
        session = plugin.session_id("support", "c1")
        expected = {"agentRuntimeArn": ARN, "qualifier": "DEFAULT", "runtimeSessionId": session, "payload": json.dumps({"prompt": "hi"}).encode()}
        self.stub.add_response("invoke_agent_runtime", {"response": self.body(b'{"result": "hello"}'), "contentType": "application/json", "statusCode": 200}, expected)
        out = io.StringIO()
        with self.stub, redirect_stdout(out):
            code = plugin.invoke(AGENT, session, "hi")
        events = [json.loads(l) for l in out.getvalue().splitlines()]
        self.assertEqual((code, events[1:]), (0, [{"artifact": {"name": "reply", "text": "hello"}}]))

    def test_a_refused_call_fails_the_run_with_the_reason(self):
        self.stub.add_client_error("invoke_agent_runtime", service_error_code="AccessDeniedException", service_message="not allowed")
        out = io.StringIO()
        with self.stub, redirect_stdout(out):
            code = plugin.invoke(AGENT, plugin.session_id("support", "c1"), "hi")
        self.assertEqual((code, "not allowed" in json.loads(out.getvalue().splitlines()[-1])["error"]), (1, True))

    def test_cancel_stops_the_session(self):
        session = plugin.session_id("support", "c1")
        self.stub.add_response("stop_runtime_session", {"runtimeSessionId": session, "statusCode": 200}, {"agentRuntimeArn": ARN, "runtimeSessionId": session, "qualifier": "DEFAULT"})
        with self.stub:
            plugin.stop_session(AGENT, session)
        self.stub.assert_no_pending_responses()


class PluginProcess(unittest.TestCase):
    def test_lists_the_runtimes_it_was_given(self):
        with tempfile.TemporaryDirectory() as d:
            Path(d, "support").mkdir()
            Path(d, "support", "agent.toml").write_text(f'name = "Support"\nruntime_arn = "{ARN}"\n[input]\nlabel = "Question"\n')
            proc = subprocess.run(
                [sys.executable, PLUGIN],
                input=json.dumps({"id": 1, "method": "agents", "params": {}}) + "\n",
                capture_output=True,
                text=True,
                env={**os.environ, "AGENTCORE_AGENTS_DIR": d},
                timeout=30,
            )
        reply = json.loads(proc.stdout.splitlines()[0])
        self.assertEqual(reply["result"]["agents"], [{"id": "support", "name": "Support", "description": "", "input": {"label": "Question"}}])


if __name__ == "__main__":
    unittest.main()
