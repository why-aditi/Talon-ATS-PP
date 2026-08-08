#!/usr/bin/env python3
"""Fail unless a stack was initialised against the S3 backend.

    terraform -chdir=<stack> init -backend-config=...
    python infra/terraform/scripts/check-backend.py <stack> [expected-state-key]

WHY THIS EXISTS. `terraform init` with no backend block and no -backend-config
does not fail. It succeeds, quietly, with LOCAL state — and on a CI runner that
state file is created empty, used for one plan, and thrown away with the runner.
Every downstream step then behaves exactly as if it had worked:

  - the plan shows `create` for everything, because state is empty;
  - check-plan.py passes, because it flags `delete` and there is none;
  - `terraform apply` succeeds, and mints a second Cognito user pool;
  - the state recording that pool is discarded seconds later.

Nothing in that sequence is red. The failure is invisible until someone counts
the pools. So the backend is asserted rather than assumed, from the file
Terraform itself writes at init time (`.terraform/terraform.tfstate`), which
records the backend that was actually selected — not the one the workflow
intended to select.

WHY THE KEY IS CHECKED TOO. `stacks/iam` and `stacks/persistent` are separate
stacks precisely because they have different lifetimes (ARCHITECTURE §9.6). Two
stacks sharing one state key silently makes each one's apply propose the
destruction of the other's resources.
"""
import json
import os
import sys


def fail(msg):
    print('check-backend: ' + msg)
    print()
    print('  A stack initialised without -backend-config uses LOCAL state.')
    print('  On a CI runner that state is empty, unshared, and discarded when')
    print('  the job ends: the plan reads as "create everything" and an apply')
    print('  mints duplicate infrastructure that nothing then tracks.')
    print('  See infra/terraform/stacks/*/README.md for the init command.')
    return 1


def main(stack_dir, expected_key=None):
    path = os.path.join(stack_dir, '.terraform', 'terraform.tfstate')

    # Absent, not empty: with no backend block Terraform writes no such file at
    # all. This is the shape the shipped workflow produced on every run.
    if not os.path.exists(path):
        return fail(f'{path} does not exist, so `terraform init` selected the '
                    'local backend.')

    try:
        with open(path) as fh:
            data = json.load(fh)
    except (OSError, ValueError) as exc:
        return fail(f'could not read {path}: {exc}')

    backend = (data or {}).get('backend') or {}
    kind = backend.get('type')
    if kind != 's3':
        return fail(f'backend type is {kind!r}, expected \'s3\'.')

    config = backend.get('config') or {}
    bucket = config.get('bucket')
    key = config.get('key')

    if not bucket:
        return fail('backend is s3 but no bucket is configured.')

    if expected_key is not None and key is not None and key != expected_key:
        return fail(f'state key is {key!r}, expected {expected_key!r}. Two '
                    'stacks sharing a key share their state, and each apply '
                    'then proposes destroying the other stack.')

    print(f'check-backend: s3://{bucket}/{key} '
          f'(region={config.get("region")}, lock={config.get("dynamodb_table")})')
    return 0


if __name__ == '__main__':
    if len(sys.argv) not in (2, 3):
        sys.exit(__doc__)
    sys.exit(main(*sys.argv[1:]))
