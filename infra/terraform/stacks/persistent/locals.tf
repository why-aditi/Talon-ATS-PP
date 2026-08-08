locals {
  name = "${var.name_prefix}-${var.env}"

  tags = merge(
    {
      Project   = "talon"
      Env       = var.env
      ManagedBy = "terraform"
      Stack     = "persistent"
    },
    var.tags,
  )

  partition  = data.aws_partition.current.partition
  account_id = data.aws_caller_identity.current.account_id

  adopting = var.adopt_user_pool != null

  # ARCHITECTURE §9.4 writes the pool as `talon-${var.env}`, so that is the
  # computed default. When adopting, the name comes from the object — see the
  # comment on var.adopt_user_pool for why the two cannot be set independently.
  user_pool_name = coalesce(
    var.user_pool_name != "" ? var.user_pool_name : null,
    local.adopting ? var.adopt_user_pool.name : null,
    local.name,
  )

  user_pool_client_name = coalesce(
    var.user_pool_client_name != "" ? var.user_pool_client_name : null,
    local.adopting ? var.adopt_user_pool.client_name : null,
    "${local.name}-api",
  )

  # OAuth stays off until callbacks exist. Cognito rejects
  # allowed_oauth_flows_user_pool_client = true with an empty callback list, and
  # more to the point: turning it on with no callbacks would change the client's
  # behaviour for the password flow the API uses today. Spec 003 supplies these.
  oauth_enabled = length(var.oauth_callback_urls) > 0
}
