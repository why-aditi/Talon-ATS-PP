# ---------------------------------------------------------------------------
# Adopting a pool that was created outside Terraform.
#
# WHY THIS EXISTS. A user pool was created by hand with the AWS CLI before this
# stack was written. It holds real sign-ins, so it cannot simply be replaced by
# the pool this stack would create — but while Terraform does not know about it,
# none of the protections CLAUDE.md §4 requires apply to it: no
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
# variable is a single object rather than four scalars — the id cannot be
# supplied without the name — and why README.md says to put the value in a
# checked-in `terraform.tfvars` rather than on the command line. A value that
# has to be remembered on every invocation is a value that will be forgotten
# once, and once is enough.
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
