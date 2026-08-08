"""Offline contract tests for scripts/up.sh's bootstrap orchestration."""

from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "scripts" / "up.sh"
WINDOWS_GIT_BASH = Path(r"C:\Program Files\Git\bin\bash.exe")
BASH = str(WINDOWS_GIT_BASH) if WINDOWS_GIT_BASH.exists() else shutil.which("bash")


class BootstrapScriptTests(unittest.TestCase):
    def setUp(self) -> None:
        if BASH is None:
            self.skipTest("bash is not installed")
        self.temp = tempfile.TemporaryDirectory()
        mock_dir = Path(self.temp.name)
        self.log = mock_dir / "calls.log"
        self.repo = mock_dir / "repo"
        self.script = self.repo / "scripts" / "up.sh"
        self.script.parent.mkdir(parents=True)
        shutil.copy2(SCRIPT, self.script)
        checker = self.repo / "infra" / "terraform" / "scripts" / "check-backend.py"
        checker.parent.mkdir(parents=True)
        shutil.copy2(ROOT / "infra" / "terraform" / "scripts" / "check-backend.py", checker)
        (self.repo / "infra" / "terraform" / "global" / "state").mkdir(parents=True)
        for stack_name in ("iam", "persistent", "ephemeral"):
            source = ROOT / "infra" / "terraform" / "stacks" / stack_name / "backend.tf.example"
            target = self.repo / "infra" / "terraform" / "stacks" / stack_name / "backend.tf.example"
            target.parent.mkdir(parents=True)
            shutil.copy2(source, target)
        self.aws = self._mock("aws", r'''#!/usr/bin/env bash
echo "aws $*" >> "$MOCK_LOG"
if [[ "$1 $2" == "sts get-caller-identity" ]]; then echo 123456789012; exit 0; fi
if [[ "$1 $2" == "s3api head-bucket" ]]; then exit "${MOCK_BUCKET_EXISTS:-1}"; fi
if [[ "$1 $2" == "dynamodb describe-table" ]]; then exit "${MOCK_TABLE_EXISTS:-1}"; fi
exit 0
''')
        self.docker = self._mock(
            "docker", '#!/usr/bin/env bash\necho "docker $*" >> "$MOCK_LOG"\nexit 0\n'
        )
        self.terraform = self._mock("terraform", r'''#!/usr/bin/env bash
echo "terraform $*" >> "$MOCK_LOG"
if [[ "$1" == "version" ]]; then echo '{"terraform_version":"1.15.8"}'; exit 0; fi
chdir="${1#-chdir=}"
key=""
bucket=""
region=""
table=""
for arg in "$@"; do
  [[ "$arg" == -backend-config=key=* ]] && key="${arg#-backend-config=key=}"
  [[ "$arg" == -backend-config=bucket=* ]] && bucket="${arg#-backend-config=bucket=}"
  [[ "$arg" == -backend-config=region=* ]] && region="${arg#-backend-config=region=}"
  [[ "$arg" == -backend-config=dynamodb_table=* ]] && table="${arg#-backend-config=dynamodb_table=}"
done
if [[ -n "$key" ]]; then
  mkdir -p "$chdir/.terraform"
  printf '{"backend":{"type":"s3","config":{"bucket":"%s","key":"%s","region":"%s","dynamodb_table":"%s"}}}' "$bucket" "$key" "$region" "$table" > "$chdir/.terraform/terraform.tfstate"
fi
exit 0
''')

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _mock(self, name: str, body: str) -> str:
        path = Path(self.temp.name) / name
        path.write_text(body, encoding="utf-8", newline="\n")
        path.chmod(0o755)
        return path.as_posix()

    def run_script(self, *, existing: bool, bootstrap_only: bool = True) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env.update({
            "MOCK_LOG": str(self.log),
            "MOCK_BUCKET_EXISTS": "0" if existing else "1",
            "MOCK_TABLE_EXISTS": "0" if existing else "1",
            "TALON_AWS_BIN": self.aws,
            "TALON_DOCKER_BIN": self.docker,
            "TALON_TERRAFORM_BIN": self.terraform,
        })
        command = [BASH, self.script.as_posix()]
        if bootstrap_only:
            command.append("--bootstrap-only")
        return subprocess.run(command, cwd=self.repo, env=env, text=True, capture_output=True, check=False)

    def test_first_run_creates_and_uses_distinct_remote_state_keys(self) -> None:
        result = self.run_script(existing=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        calls = self.log.read_text(encoding="utf-8")
        self.assertIn("-var=adopt_state_bucket=false", calls)
        self.assertIn("-var=adopt_state_lock_table=false", calls)
        self.assertIn("-backend-config=key=iam/terraform.tfstate", calls)
        self.assertIn("-backend-config=key=persistent/terraform.tfstate", calls)
        self.assertIn("-backend-config=key=ephemeral/terraform.tfstate", calls)

    def test_fresh_clone_adopts_existing_backend_resources(self) -> None:
        result = self.run_script(existing=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        calls = self.log.read_text(encoding="utf-8")
        self.assertIn("-var=adopt_state_bucket=true", calls)
        self.assertIn("-var=adopt_state_lock_table=true", calls)

    def test_unknown_option_fails_before_bootstrap(self) -> None:
        env = os.environ.copy()
        result = subprocess.run(
            [BASH, self.script.as_posix(), "--unknown"], cwd=self.repo, env=env,
            text=True, capture_output=True, check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Usage:", result.stderr)


if __name__ == "__main__":
    unittest.main()
