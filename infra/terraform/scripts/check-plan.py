#!/usr/bin/env python3
"""Fail a Terraform plan that would replace a stateful resource.

    terraform show -json tf.plan > plan.json
    python infra/terraform/scripts/check-plan.py plan.json

CLAUDE.md §4 and ARCHITECTURE §9.5: a plan touching `aws_cognito_user_pool`,
`aws_rds_cluster`, a KMS key or a state bucket stops and gets a human.
Replacement of a stateful resource is never routine.

WHY THIS IS A SCRIPT AND NOT `prevent_destroy`. ARCHITECTURE §9.5a rules out
`prevent_destroy`: it cannot be parameterized, so it blocks `scripts/down.sh`,
and one-command teardown is a requirement. The protection is instead: the
persistent/ephemeral stack split, `down.sh --all` needing a typed confirmation,
and this check. This is the part that runs on every pull request.

WHAT COUNTS AS A REPLACEMENT. Terraform encodes it as an `actions` list of
["delete", "create"] or ["create", "delete"] (the latter is
create_before_destroy). A bare ["delete"] is a plain destroy — also flagged for
these types, because a destroy of the user pool loses every user just as
completely as a replacement does. ["update"] and ["create"] are fine: adopting
the pool for the first time is a create, and turning on deletion protection is
an update.

THE OVERRIDE is deliberately awkward. Setting TALON_ALLOW_STATEFUL_REPLACE to a
non-empty string downgrades the failure to a warning, and the value is required
to be a reason of at least 20 characters, printed into the log. A flag that can
be flipped with `true` gets flipped with `true`.
"""
import json
import os
import sys

# Matched as a prefix, so `aws_kms_key` also catches `aws_kms_replica_key`, and
# `aws_s3_bucket` catches the state bucket regardless of which sub-resource of
# it a future stack declares.
PROTECTED = (
    'aws_cognito_user_pool',
    'aws_rds_cluster',
    'aws_db_instance',
    'aws_kms_key',
    'aws_kms_replica_key',
    'aws_s3_bucket',
    'aws_dynamodb_table',
)

DESTRUCTIVE = ('delete',)


def is_protected(resource_type):
    # Exact match or a `_`-delimited extension, so `aws_cognito_user_pool` and
    # `aws_cognito_user_pool_client` are BOTH matched — replacing the client
    # mints a new client id and breaks every running API instance. That is not
    # as bad as losing the pool, and it is still not routine.
    return any(resource_type == p or resource_type.startswith(p + '_')
               for p in PROTECTED)


def main(path):
    try:
        plan = json.load(open(path))
    except (OSError, ValueError) as exc:
        sys.exit(f'check-plan: could not read {path}: {exc}')

    findings = []
    for change in plan.get('resource_changes', []):
        actions = change.get('change', {}).get('actions', [])
        if not is_protected(change.get('type', '')):
            continue
        if not any(a in DESTRUCTIVE for a in actions):
            continue
        kind = 'REPLACE' if 'create' in actions else 'DESTROY'
        findings.append((kind, change['type'], change['address'],
                         change.get('change', {}).get('replace_paths') or []))

    if not findings:
        print('check-plan: no stateful resource is replaced or destroyed.')
        return 0

    print('check-plan: STATEFUL RESOURCE CHANGE DETECTED\n')
    for kind, rtype, address, paths in findings:
        print(f'  {kind}  {address}  ({rtype})')
        for p in paths:
            print(f'         forced by: {".".join(str(s) for s in p)}')
    print()
    print('  A replacement of aws_cognito_user_pool DESTROYS EVERY USER IN IT.')
    print('  A replacement of a state bucket or lock table loses the state file.')
    print('  CLAUDE.md non-negotiable: this gets a human, not a rerun.')
    print()

    reason = os.environ.get('TALON_ALLOW_STATEFUL_REPLACE', '')
    if len(reason.strip()) >= 20:
        print(f'  OVERRIDDEN. Reason on the record: {reason.strip()}')
        return 0
    if reason:
        print('  TALON_ALLOW_STATEFUL_REPLACE is set but its value is not a '
              'reason. Give at least 20 characters explaining why.')
    return 1


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    sys.exit(main(sys.argv[1]))
