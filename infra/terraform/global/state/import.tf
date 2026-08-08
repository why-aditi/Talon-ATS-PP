# A clean clone has no local bootstrap state, but the global resources may
# already exist. The orchestration scripts probe AWS and turn these imports on,
# making the bootstrap idempotent across machines rather than only on the
# machine that retained terraform.tfstate.
import {
  for_each = var.adopt_state_bucket ? toset(["state"]) : toset([])
  to       = aws_s3_bucket.state
  id       = local.bucket_name
}

import {
  for_each = var.adopt_state_lock_table ? toset(["locks"]) : toset([])
  to       = aws_dynamodb_table.locks
  id       = local.lock_table_name
}
