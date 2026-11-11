#!/usr/bin/env python3
"""Self-check for coord. Run: python3 ~/.claude/bin/coord_test.py"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

COORD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "coord")


class Coord(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = self.tmp.name
        sess = os.path.join(d, "sessions")
        os.mkdir(sess)
        self.procs = {}
        for sid in "abc":
            p = subprocess.Popen(["sleep", "60"])
            self.procs[sid] = p
            with open(os.path.join(sess, f"{p.pid}.json"), "w") as fh:
                json.dump({"pid": p.pid, "sessionId": sid, "name": "s-" + sid}, fh)
        self.env = dict(os.environ, COORD_DIR=os.path.join(d, "coord"), COORD_SESSIONS=sess)
        self.dir = os.path.join(d, "app")
        os.mkdir(self.dir)
        self.file = os.path.join(self.dir, "f.txt")
        open(self.file, "w").close()

    def tearDown(self):
        for p in self.procs.values():
            p.kill()
            p.wait()
        self.tmp.cleanup()

    def co(self, sid, *args, stdin=None):
        r = subprocess.run([sys.executable, COORD, *args], env=dict(self.env, COORD_SID=sid),
                           input=stdin, capture_output=True, text=True, timeout=10)
        return r.returncode, r.stdout + r.stderr

    def hook(self, event, sid, path=None):
        return self.co(sid, event, stdin=json.dumps({"session_id": sid, "tool_input": {"file_path": path}}))

    def test_queue_lend_back_and_dead_session(self):
        k = "device:phone"
        self.assertEqual(self.co("a", "claim", k)[0], 0)
        code, out = self.co("b", "claim", k)
        self.assertEqual(code, 3)
        self.assertIn("s-a", out)
        self.assertEqual(self.co("c", "claim", k)[0], 3)
        self.assertEqual(self.co("b", "lend", k)[0], 1)  # only the holder lends

        code, out = self.co("a", "lend", k, "logcat only")
        self.assertIn("s-b is borrowing", out)
        code, out = self.co("b", "wait", k)
        self.assertEqual(code, 0)
        self.assertIn("logcat only", out)

        self.assertEqual(self.co("a", "back", k)[0], 3)  # b still has it on loan
        self.assertEqual(self.co("b", "yield", k)[0], 0)
        self.assertEqual(self.co("a", "wait", k)[0], 0)

        code, out = self.co("a", "release", k)
        self.assertIn("s-c has it now", out)  # b went to the back when it yielded
        self.assertEqual(self.co("c", "wait", k)[0], 0)

        self.procs["c"].kill()
        self.procs["c"].wait()
        self.assertEqual(self.co("b", "wait", k)[0], 0)  # dead session's place is dropped

    def test_edit_hook_blocks_other_session_until_turn_ends(self):
        self.assertEqual(self.hook("hook-edit", "a", self.file)[0], 0)
        self.assertEqual(self.hook("hook-edit", "a", self.file)[0], 0)
        code, out = self.hook("hook-edit", "b", self.file)
        self.assertEqual(code, 2)
        self.assertIn("s-a", out)
        self.assertEqual(self.co("b", "claim", self.file)[0], 3)
        self.hook("hook-stop", "a")
        self.assertEqual(self.co("b", "wait", self.file)[0], 0)
        self.assertEqual(self.hook("hook-edit", "b", self.file)[0], 0)
        self.assertEqual(self.hook("hook-edit", "a", self.file)[0], 2)

    def test_folder_claim_blocks_edits_inside_and_survives_stop(self):
        self.assertEqual(self.co("a", "claim", self.dir, "refactor")[0], 0)
        code, out = self.hook("hook-edit", "b", self.file)
        self.assertEqual(code, 2)
        self.assertIn("refactor", out)
        self.hook("hook-stop", "a")
        self.assertEqual(self.hook("hook-edit", "b", self.file)[0], 2)
        self.assertEqual(self.hook("hook-edit", "a", self.file)[0], 0)

    def test_stop_frees_edit_claims_on_deleted_or_never_created_files(self):
        gone = os.path.join(self.dir, "gone.txt")
        never = os.path.join(self.dir, "never.txt")
        self.assertEqual(self.hook("hook-edit", "a", gone)[0], 0)
        self.assertEqual(self.hook("hook-edit", "a", never)[0], 0)
        open(gone, "w").close()
        os.remove(gone)
        self.hook("hook-stop", "a")
        self.assertEqual(self.hook("hook-edit", "b", gone)[0], 0)
        self.assertEqual(self.hook("hook-edit", "b", never)[0], 0)

    def test_hook_fails_open_on_garbage(self):
        r = subprocess.run([sys.executable, COORD, "hook-edit"], env=self.env, input="not json",
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 0)

    def test_session_start_injects_protocol_with_this_path(self):
        code, out = self.co("a", "hook-start")
        self.assertEqual(code, 0)
        self.assertIn("Sharing files, apps and devices", out)
        self.assertNotIn("{coord}", out)
        self.assertIn(os.path.basename(COORD), out)


if __name__ == "__main__":
    unittest.main()
