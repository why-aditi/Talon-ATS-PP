locals {
  account_id      = data.aws_caller_identity.current.account_id
  partition       = data.aws_partition.current.partition
  bucket_name     = var.state_bucket_name != "" ? var.state_bucket_name : "${var.name_prefix}-tfstate-${local.account_id}"
  lock_table_name = var.state_lock_table_name != "" ? var.state_lock_table_name : "${var.name_prefix}-tfstate-lock"

  tags = merge(
    var.tags,
    {
      Project   = var.name_prefix
      Env       = "global"
      ManagedBy = "terraform"
      Stack     = "state"
    },
  )
}
