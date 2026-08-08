terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }

  # Deliberately local. This stack creates the remote backend used by every
  # other stack, so pointing it at that backend would recreate the bootstrap
  # cycle. Existing resources can be adopted through import.tf.
}
