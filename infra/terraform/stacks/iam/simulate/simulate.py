#!/usr/bin/env python3
"""Policy assertions for stacks/iam, run through `aws iam simulate-custom-policy`.

    terraform -chdir=infra/terraform/stacks/iam plan \
      -var 'github_repo=OWNER/REPO' -out=tf.plan
    terraform -chdir=infra/terraform/stacks/iam show -json tf.plan > plan.json
    python infra/terraform/stacks/iam/simulate/simulate.py plan.json

Exits non-zero on the first mismatch. Every row here is a row in
docs/specs/002-infrastructure.md §5.1; the two are meant to be read together.

WHY A `child` PRINCIPAL EXISTS, and why it is the most important thing in this
file. Before BL-1 was found, every assertion evaluated the DEPLOY ROLE's own
permissions. Under that test a permissions boundary that is a ceiling but not a
mirror is indistinguishable from a correct one — the deploy role's identity
policy denies the things the boundary forgot, so the simulator says explicitDeny
either way and the gap is invisible.

`child` models what the deploy role can actually build: a role holding inline
{"Action":"*","Resource":"*"} and nothing else, carrying the boundary. Creating
it is permitted, and deliberately so; that is the fixed point the ceiling exists
to make harmless. Because it holds a universal Allow, the ONLY thing that can
deny it is the boundary. Four of six guardrails were unmirrored and this is the
test that would have said so.

If you add a guardrail to role_github_deploy.tf, add a `child` row here in the
same PR. A guardrail with no `child` row is untested against the escalation that
matters.
"""
import json
import os
import subprocess
import sys

ACCT = None  # filled from the plan's account-bearing ARNs
HERE = os.path.dirname(os.path.abspath(__file__))
REQ = os.path.join(HERE, '.request.json')


# ---------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------

def aws_json(*args):
    p = subprocess.run(['aws'] + list(args) + ['--output', 'json'],
                       capture_output=True, text=True)
    if p.returncode != 0:
        sys.exit('aws ' + ' '.join(args) + ' failed:\n' + p.stderr)
    return json.loads(p.stdout)


def managed(arn):
    """Default version document of an AWS-managed policy, fetched live."""
    pol = aws_json('iam', 'get-policy', '--policy-arn', arn)['Policy']
    ver = aws_json('iam', 'get-policy-version', '--policy-arn', arn,
                   '--version-id', pol['DefaultVersionId'])['PolicyVersion']
    return json.dumps(ver['Document'])


def load_plan(path):
    d = json.load(open(path))
    return {r['address']: r['values']
            for r in d['planned_values']['root_module']['resources']}


# ---------------------------------------------------------------------------
# Simulator
# ---------------------------------------------------------------------------

def context(region='us-east-1', boundary=None, passed_to=None):
    """aws:RequestedRegion is ALWAYS supplied. AWS populates it on every real
    request, but simulate-custom-policy leaves it absent unless told, and an
    absent key makes StringNotEquals true — which would deny every action and
    read as a suspiciously clean pass."""
    e = [{'ContextKeyName': 'aws:RequestedRegion', 'ContextKeyType': 'string',
          'ContextKeyValues': [region]}]
    if boundary:
        e.append({'ContextKeyName': 'iam:PermissionsBoundary',
                  'ContextKeyType': 'string', 'ContextKeyValues': [boundary]})
    if passed_to:
        e.append({'ContextKeyName': 'iam:PassedToService',
                  'ContextKeyType': 'string', 'ContextKeyValues': [passed_to]})
    return e


def simulate(policies, boundary_docs, action, resource, **kw):
    payload = {'PolicyInputList': policies, 'ActionNames': [action],
               'ResourceArns': [resource], 'ContextEntries': context(**kw)}
    if boundary_docs:
        payload['PermissionsBoundaryPolicyInputList'] = boundary_docs
    # ReadOnlyAccess alone exceeds the Windows command-line length limit, so the
    # request goes in as a file rather than as flags.
    json.dump(payload, open(REQ, 'w'))
    p = subprocess.run(['aws', 'iam', 'simulate-custom-policy',
                        '--cli-input-json', 'file://' + REQ, '--output', 'json'],
                       capture_output=True, text=True)
    if p.returncode != 0:
        return 'ERROR: ' + p.stderr.strip().splitlines()[-1]
    return json.loads(p.stdout)['EvaluationResults'][0]['EvalDecision']


def main(plan_path):
    res = load_plan(plan_path)
    # Role ARNs are "known after apply", so the account id comes from STS and the
    # project prefix from the boundary policy's name — both of which are literal
    # in the plan. locals.tf builds the boundary ARN the same way and for the
    # same reason (a policy that forbids its own modification cannot reference
    # its own resource without a cycle).
    acct = aws_json('sts', 'get-caller-identity')['Account']
    bnd_name = res['aws_iam_policy.permissions_boundary']['name']
    name = bnd_name.rsplit('-permissions-boundary', 1)[0]
    boundary_arn = f'arn:aws:iam::{acct}:policy/{bnd_name}'

    R = f'arn:aws:iam::{acct}:role/'
    BND = boundary_arn
    STATE = f'arn:aws:s3:::talon-tfstate-{acct}'
    LOCK = f'arn:aws:dynamodb:us-east-1:{acct}:table/talon-tfstate-lock'
    POOL = f'arn:aws:cognito-idp:us-east-1:{acct}:userpool/us-east-1_abcdEFGH'

    def doc(addr):
        return res[addr]['policy']

    boundary = [doc('aws_iam_policy.permissions_boundary')]
    deploy = [managed('arn:aws:iam::aws:policy/PowerUserAccess'),
              doc('aws_iam_role_policy.github_deploy_iam_addendum'),
              doc('aws_iam_role_policy.github_deploy_guardrails')]
    plan = [managed('arn:aws:iam::aws:policy/ReadOnlyAccess'),
            doc('aws_iam_role_policy.github_plan_state'),
            doc('aws_iam_role_policy.github_plan_guardrails')]
    child = [json.dumps({'Version': '2012-10-17', 'Statement': [
        {'Effect': 'Allow', 'Action': '*', 'Resource': '*'}]})]
    # The operator: PowerUserAccess + IAMFullAccess, no permissions boundary —
    # a boundary constrains only the principal it is attached to.
    admin = [managed('arn:aws:iam::aws:policy/PowerUserAccess'),
             managed('arn:aws:iam::aws:policy/IAMFullAccess')]

    P = {'deploy': (deploy, boundary), 'plan': (plan, boundary),
         'child': (child, boundary), 'admin': (admin, None)}

    rows = [
        # --- BL-1: the escalation, as a boundary-carrying child --------------
        ('BL-1 escalation (child holds inline *:*, boundary attached)', [
            ('child', 'iam:UpdateAssumeRolePolicy', R + f'{name}-github-deploy', {}, 'explicitDeny'),
            ('child', 'iam:PutRolePolicy', R + f'{name}-github-deploy', {'boundary': BND}, 'explicitDeny'),
            ('child', 'iam:DetachRolePolicy', R + f'{name}-github-deploy', {}, 'explicitDeny'),
            ('child', 'cognito-idp:DeleteUserPool', POOL, {}, 'explicitDeny'),
            ('child', 'rds:DeleteDBCluster', f'arn:aws:rds:us-east-1:{acct}:cluster:{name}-pg', {}, 'explicitDeny'),
            ('child', 'iam:PassRole', R + f'{name}-ecs-task', {'passed_to': 'ec2.amazonaws.com'}, 'explicitDeny'),
            ('child', 'dynamodb:DeleteTable', LOCK, {}, 'explicitDeny'),
            ('child', 'ec2:RunInstances', f'arn:aws:ec2:ap-south-1:{acct}:instance/*', {'region': 'ap-south-1'}, 'explicitDeny'),
            # RESIDUAL, spec 002 §4.10b. Not closable here: the ECS task role
            # carries the same right and the boundary binds it too, so a deny
            # would take the scanner down with the presign path. Closed by the
            # per-service task-role split, open question 2.
            ('child', 's3:GetObject', f'arn:aws:s3:::{name}-quarantine/resumes/x.pdf', {}, 'allowed'),
        ]),
        # --- unchanged, must keep holding for a child ------------------------
        ('Fixed points a child must not reach', [
            ('child', 'iam:CreateAccessKey', f'arn:aws:iam::{acct}:user/anyone', {}, 'explicitDeny'),
            ('child', 'iam:CreateRole', R + f'{name}-x', {}, 'explicitDeny'),
            ('child', 'iam:CreateRole', R + 'someone-else', {'boundary': BND}, 'explicitDeny'),
            ('child', 'iam:CreatePolicyVersion', BND, {}, 'explicitDeny'),
            ('child', 'iam:DeleteRolePermissionsBoundary', R + f'{name}-x', {}, 'explicitDeny'),
        ]),
        # --- the deploy role's own guardrails --------------------------------
        ('Deploy-role guardrails', [
            ('deploy', 'iam:UpdateAssumeRolePolicy', R + f'{name}-github-deploy', {}, 'explicitDeny'),
            ('deploy', 'iam:PutRolePolicy', R + f'{name}-anything', {}, 'explicitDeny'),
            ('deploy', 'iam:CreateRole', R + f'{name}-anything', {}, 'explicitDeny'),
            ('deploy', 'iam:CreateRole', R + f'{name}-anything',
             {'boundary': f'arn:aws:iam::{acct}:policy/someone-elses'}, 'explicitDeny'),
            ('deploy', 'iam:DeleteRole', R + f'{name}-github-plan', {}, 'explicitDeny'),
            ('deploy', 'iam:DeleteRolePermissionsBoundary', R + f'{name}-github-deploy', {}, 'explicitDeny'),
            ('deploy', 'iam:CreatePolicyVersion', BND, {}, 'explicitDeny'),
            # implicitDeny before the boundary mirrored the PassRole scoping.
            ('deploy', 'iam:PassRole', R + f'{name}-ecs-task', {'passed_to': 'glue.amazonaws.com'}, 'explicitDeny'),
            ('deploy', 'cognito-idp:DeleteUserPool', POOL, {}, 'explicitDeny'),
            ('deploy', 'rds:DeleteDBCluster', f'arn:aws:rds:us-east-1:{acct}:cluster:{name}-pg', {}, 'explicitDeny'),
            ('deploy', 'iam:UpdateRole', R + f'{name}-github-deploy', {}, 'explicitDeny'),
            ('deploy', 'iam:TagRole', R + f'{name}-github-plan', {}, 'explicitDeny'),
            ('deploy', 'iam:CreateRole', R + f'{name}-github-evil', {'boundary': BND}, 'explicitDeny'),
            ('deploy', 'iam:PassRole', R + f'{name}-ecs-task', {'passed_to': 'ec2.amazonaws.com'}, 'explicitDeny'),
            ('deploy', 'ec2:RunInstances', f'arn:aws:ec2:ap-south-1:{acct}:instance/*', {'region': 'ap-south-1'}, 'explicitDeny'),
            ('deploy', 'dynamodb:DeleteTable', LOCK, {}, 'explicitDeny'),
        ]),
        # --- the plan role ----------------------------------------------------
        ('Plan role: object bodies and object names', [
            ('plan', 's3:GetObject', f'arn:aws:s3:::{name}-quarantine/resumes/x.pdf', {}, 'explicitDeny'),
            ('plan', 's3:GetObject', f'arn:aws:s3:::{name}-uploads/resumes/x.pdf', {}, 'explicitDeny'),
            ('plan', 's3:GetObject', f'arn:aws:s3:::{name}-some-future-bucket/o', {}, 'explicitDeny'),
            ('plan', 's3:ListBucket', f'arn:aws:s3:::{name}-quarantine', {}, 'explicitDeny'),
            ('plan', 's3:ListBucket', f'arn:aws:s3:::{name}-uploads', {}, 'explicitDeny'),
        ]),
        # --- a guardrail that blocks the deploy is not a fix -------------------
        ('The stack still deploys', [
            ('deploy', 'ecs:UpdateService', f'arn:aws:ecs:us-east-1:{acct}:service/{name}/api', {}, 'allowed'),
            ('deploy', 's3:PutObject', STATE + '/iam/terraform.tfstate', {}, 'allowed'),
            ('deploy', 'iam:CreateRole', R + f'{name}-future', {'boundary': BND}, 'allowed'),
            ('deploy', 'iam:PutRolePolicy', R + f'{name}-future', {'boundary': BND}, 'allowed'),
            ('deploy', 'iam:PassRole', R + f'{name}-ecs-task', {'passed_to': 'ecs-tasks.amazonaws.com'}, 'allowed'),
            # The §4.7b naming contract: the NAT instance role still reaches EC2.
            ('deploy', 'iam:PassRole', R + f'{name}-ec2-nat', {'passed_to': 'ec2.amazonaws.com'}, 'allowed'),
            ('deploy', 'iam:CreateServiceLinkedRole', R + 'aws-service-role/ecs.amazonaws.com/AWSServiceRoleForECS', {}, 'allowed'),
            ('deploy', 'secretsmanager:GetSecretValue', f'arn:aws:secretsmanager:us-east-1:{acct}:secret:{name}/db-AbCdEf', {}, 'allowed'),
            ('deploy', 'ec2:CreateVpc', f'arn:aws:ec2:us-east-1:{acct}:vpc/*', {}, 'allowed'),
            ('plan', 's3:GetObject', STATE + '/iam/terraform.tfstate', {}, 'allowed'),
            ('plan', 's3:ListBucket', STATE, {}, 'allowed'),
            ('plan', 'dynamodb:PutItem', LOCK, {}, 'allowed'),
            ('plan', 'ec2:DescribeVpcs', '*', {}, 'allowed'),
        ]),
        # --- the IAM reads `terraform plan` makes during refresh ---------------
        #
        # ReadIamForRefresh used to be one statement on `resources = ["*"]`.
        # Splitting it is the only way to stop a CI run reading another team's
        # inline policies on this shared account (CKV_AWS_356) — and the whole
        # risk of splitting it is that `plan` then fails to refresh, which looks
        # like a permissions bug at the worst possible moment. Every row in the
        # first block is an API call the AWS provider makes while refreshing a
        # resource this stack manages; if one of them is not `allowed`, the
        # split is too tight. The second block is what the split BUYS.
        ('Refresh still works: the deploy role can read its own IAM', [
            # aws_iam_role.* — GetRole, then ListRoleTags for the tag map.
            ('deploy', 'iam:GetRole', R + f'{name}-github-deploy', {}, 'allowed'),
            ('deploy', 'iam:ListRoleTags', R + f'{name}-github-deploy', {}, 'allowed'),
            # aws_iam_role_policy.* — the inline addendum and guardrails.
            ('deploy', 'iam:GetRolePolicy', R + f'{name}-github-deploy', {}, 'allowed'),
            ('deploy', 'iam:ListRolePolicies', R + f'{name}-ecs-task', {}, 'allowed'),
            # aws_iam_role_policy_attachment.* — authorized against the ROLE,
            # which is why the "AWS-managed ARNs cannot match a prefix" argument
            # never applied to this call.
            ('deploy', 'iam:ListAttachedRolePolicies', R + f'{name}-github-deploy', {}, 'allowed'),
            ('deploy', 'iam:ListInstanceProfilesForRole', R + f'{name}-ec2-nat', {}, 'allowed'),
            # aws_iam_policy.permissions_boundary — project-prefixed.
            ('deploy', 'iam:GetPolicy', f'arn:aws:iam::{acct}:policy/{bnd_name}', {}, 'allowed'),
            ('deploy', 'iam:GetPolicyVersion', f'arn:aws:iam::{acct}:policy/{bnd_name}', {}, 'allowed'),
            ('deploy', 'iam:ListPolicyVersions', f'arn:aws:iam::{acct}:policy/{bnd_name}', {}, 'allowed'),
            # The AWS-managed namespace the old comment was actually about.
            ('deploy', 'iam:GetPolicy', 'arn:aws:iam::aws:policy/PowerUserAccess', {}, 'allowed'),
            ('deploy', 'iam:GetPolicyVersion', 'arn:aws:iam::aws:policy/ReadOnlyAccess', {}, 'allowed'),
            # aws_iam_instance_profile (§9.6's NAT instance) and the OIDC provider.
            ('deploy', 'iam:GetInstanceProfile',
             f'arn:aws:iam::{acct}:instance-profile/{name}-ec2-nat', {}, 'allowed'),
            ('deploy', 'iam:GetOpenIDConnectProvider',
             f'arn:aws:iam::{acct}:oidc-provider/token.actions.githubusercontent.com', {}, 'allowed'),
            # The four collection reads. IAM has no resource-level permission for
            # any of them, so `*` is the only Resource that works at all.
            ('deploy', 'iam:ListRoles', '*', {}, 'allowed'),
            ('deploy', 'iam:ListPolicies', '*', {}, 'allowed'),
            ('deploy', 'iam:ListInstanceProfiles', '*', {}, 'allowed'),
            ('deploy', 'iam:ListOpenIDConnectProviders', '*', {}, 'allowed'),
        ]),
        # This is the finding, not the lint. §9.5: one shared company account.
        # `implicitDeny` rather than `explicitDeny` is correct and sufficient —
        # there is simply no Allow that reaches these ARNs any more. Every row
        # here was `allowed` before the split.
        ('And no longer read another team\'s IAM', [
            ('deploy', 'iam:GetRolePolicy', R + 'someone-elses-role', {}, 'implicitDeny'),
            ('deploy', 'iam:GetRole', R + 'someone-elses-role', {}, 'implicitDeny'),
            ('deploy', 'iam:ListRolePolicies', R + 'someone-elses-role', {}, 'implicitDeny'),
            ('deploy', 'iam:ListAttachedRolePolicies', R + 'someone-elses-role', {}, 'implicitDeny'),
            ('deploy', 'iam:ListRoleTags', R + 'someone-elses-role', {}, 'implicitDeny'),
            ('deploy', 'iam:GetPolicy', f'arn:aws:iam::{acct}:policy/someone-elses', {}, 'implicitDeny'),
            ('deploy', 'iam:GetPolicyVersion', f'arn:aws:iam::{acct}:policy/someone-elses', {}, 'implicitDeny'),
            ('deploy', 'iam:GetInstanceProfile',
             f'arn:aws:iam::{acct}:instance-profile/someone-elses', {}, 'implicitDeny'),
        ]),
        # --- the operator is not locked out of the next apply ------------------
        ('The operator can still apply and destroy this stack', [
            ('admin', 'iam:CreateRole', R + f'{name}-github-deploy', {'boundary': BND}, 'allowed'),
            ('admin', 'iam:CreatePolicy', BND, {}, 'allowed'),
            ('admin', 'iam:PutRolePolicy', R + f'{name}-github-deploy', {'boundary': BND}, 'allowed'),
            ('admin', 'iam:AttachRolePolicy', R + f'{name}-github-deploy', {'boundary': BND}, 'allowed'),
            ('admin', 'iam:TagRole', R + f'{name}-github-deploy', {}, 'allowed'),
            # The two load-bearing rows: the new mirrors must not stop the
            # operator changing the boundary or the CI roles on a later apply.
            ('admin', 'iam:CreatePolicyVersion', BND, {}, 'allowed'),
            ('admin', 'iam:UpdateAssumeRolePolicy', R + f'{name}-github-deploy', {}, 'allowed'),
            ('admin', 'iam:PassRole', R + f'{name}-ecs-task', {'passed_to': 'ec2.amazonaws.com'}, 'allowed'),
            ('admin', 'iam:CreateOpenIDConnectProvider', '*', {}, 'allowed'),
            ('admin', 'iam:DeleteRole', R + f'{name}-github-deploy', {}, 'allowed'),
        ]),
    ]

    failures = 0
    total = 0
    for title, group in rows:
        print('\n### ' + title)
        for principal, action, resource, kw, expected in group:
            policies, bnd = P[principal]
            got = simulate(policies, bnd, action, resource, **kw)
            ok = got == expected
            failures += not ok
            total += 1
            print(f'{"PASS" if ok else "FAIL"}  {principal:<6} {action:<38} '
                  f'expected={expected:<13} got={got}')
    if os.path.exists(REQ):
        os.remove(REQ)
    print(f'\n{total} assertions, {failures} failures')
    return 1 if failures else 0


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    sys.exit(main(sys.argv[1]))
