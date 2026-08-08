# Terraform state bootstrap

This local-state root module creates the versioned, encrypted S3 bucket and
DynamoDB lock table used by every other Terraform stack. It intentionally has
no remote backend: the backend cannot be used before it exists, and these
global resources are never part of routine teardown.

Use `scripts/up.sh --bootstrap-only` (or `scripts/up.ps1 -BootstrapOnly`) rather
than applying this directory by hand. The scripts detect and import an existing
bucket/table, apply the desired security settings, and initialize the `iam` and
`persistent` stacks against distinct state keys.

`prevent_destroy` is intentional here. Unlike application resources, the state
backend is not included in `down.sh --all`; deleting it destroys the recovery
history for every stack.
