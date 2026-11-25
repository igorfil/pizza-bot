"""Run with: python3 -m unittest discover -s experimental/fleet/plugins/lib (Python 3.11+)."""

import unittest

from fleet_plugin import agent_fields, contract_event, failure


class ContractEvents(unittest.TestCase):
    def test_reads_status_artifact_and_error_lines(self):
        lines = ['{"status": "step 1"}', '{"artifact": {"name": "r", "text": "hi"}}', '{"error": "boom"}']
        self.assertEqual(
            [contract_event(l) for l in lines],
            [[{"status": "step 1"}], [{"artifact": {"name": "r", "text": "hi"}}], [{"error": "boom"}]],
        )

    def test_ignores_lines_that_arent_events(self):
        self.assertEqual([contract_event(l) for l in ["Resolved 3 packages", "[1]", '{"progress": 1}']], [[], [], []])


class Failure(unittest.TestCase):
    def test_a_clean_exit_succeeds(self):
        self.assertIsNone(failure(0, False, "noise"))

    def test_an_error_event_already_says_why(self):
        self.assertIsNone(failure(1, True, "Traceback"))

    def test_a_crash_reports_the_last_stderr_line(self):
        self.assertEqual(failure(1, False, "KeyError: x"), "KeyError: x")

    def test_a_crash_without_stderr_reports_the_code(self):
        self.assertEqual(failure(2, False, None), "exited with code 2")

    def test_a_signal_says_so(self):
        self.assertEqual(failure(-9, False, None), "killed by a signal")


class AgentFields(unittest.TestCase):
    def test_sends_only_what_the_runner_reads_and_skips_empty_fields(self):
        agent = {"id": "a", "name": "A", "description": "", "input": None, "timeoutSecs": 30, "command": "x", "dir": "/a"}
        self.assertEqual(agent_fields(agent), {"id": "a", "name": "A", "description": "", "timeoutSecs": 30})


if __name__ == "__main__":
    unittest.main()
