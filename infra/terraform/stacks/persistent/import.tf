# ---------------------------------------------------------------------------
# Adopting a pool that was created outside Terraform.
#
# THE DECISION IS: CREATE FRESH. DO NOT ADOPT. This path is not taken.
#
# `var.adopt_user_pool` defaults to null, so these blocks do not exist, and the
# only path CI or `up.sh` can reach is a fresh `talon-dev` pool. The pool that
# prompted this file — `talon-throwaway-spec002` — holds six seeded demo users
# that `up.sh` stage 7 recreates, and adopting it would pin that name forever
# because Cognito pool names are immutable. Spec 002 §4a.6.
#
# The mechanism stays because it is proven, gated and cheap to keep, and because
# a pool with REAL users will eventually need it. Two rules for that day:
# supply the value as a `-var` on a human-run plan, and never from a checked-in
# `terraform.tfvars` (`*.tfvars` is gitignored for exactly this reason). A tfvars
# file makes adoption the silent default for every invocation including CI's, and
# the day it drifts or is deleted, Terraform computes `name = "talon-dev"`
# against a state entry named `talon-throwaway-spec002` and plans to destroy a
# pool with users in it.
#
# WHY THIS EXISTS AT ALL. A user pool was created by hand with the AWS CLI before
# this stack was written — while Terraform does not know about a pool, none of
# the protections CLAUDE.md §4 requires apply to it: no
# `ignore_changes = [schema]`, no deletion protection, and nothing for the CI
# plan check to check.
#
# HOW IT IS GATED. `for_each` over a variable that defaults to null, so on a
# clean account these blocks do not exist and `terraform plan` creates a fresh,
# correctly-named pool. That matters: ARCHITECTURE §9.5a's acceptance test is
# "tear everything down, run it again from nothing, sign in", and a stack whose
# default path is "import something that must already exist" fails it.
#
# THE HAZARD, STATED PLAINLY. Adoption pins `local.user_pool_name` to the live
# pool's name FOREVER. The name is immutable in Cognito and ForceNew in the
# provider, so the day someone runs a plan without `var.adopt_user_pool` set,
# Terraform proposes to destroy that pool and every user in it. That is why the
# variable is a single object rather than four scalars: the id cannot be supplied
# without the name, so the specific mistake that plans a replacement is
# unrepresentable. The remaining hazard — forgetting the flag entirely — is not
# solved by writing the value into a file, only moved; it is caught by
# check-plan.py, which fails the plan and names `forced by: name`.
#
# `terraform import` was NOT used, deliberately. `import` blocks are visible in
# `terraform plan` before anything is written, so the "no replacement" claim can
# be reviewed rather than discovered after the state file has already changed.
# ---------------------------------------------------------------------------

import {
  for_each = local.adopting ? { pool = var.adopt_user_pool } : {}

  to = aws_cognito_user_pool.main
  id = each.value.id
}

import {
  for_each = local.adopting ? { client = var.adopt_user_pool } : {}

  # The client's import id is `<user_pool_id>/<client_id>`, not the client id on
  # its own — an app client is not addressable outside its pool.
  to = aws_cognito_user_pool_client.api
  id = "${each.value.id}/${each.value.client_id}"
}
