resource "aws_kms_key" "application" {
  description             = "Talon ${var.env} application data encryption"
  deletion_window_in_days = var.kms_deletion_window_days
  enable_key_rotation     = true

  tags = {
    Name = "${local.name}-application"
  }
}

resource "aws_kms_alias" "application" {
  name          = "alias/${local.name}-application"
  target_key_id = aws_kms_key.application.key_id
}

resource "aws_s3_bucket" "data" {
  for_each = local.data_buckets

  bucket        = each.value
  force_destroy = var.force_destroy_persistent_data
}

resource "aws_s3_bucket_public_access_block" "data" {
  for_each = aws_s3_bucket.data

  bucket = each.value.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "data" {
  for_each = aws_s3_bucket.data

  bucket = each.value.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "data" {
  for_each = aws_s3_bucket.data

  bucket = each.value.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "data" {
  for_each = aws_s3_bucket.data

  bucket = each.value.id

  rule {
    bucket_key_enabled = true

    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.application.arn
      sse_algorithm     = "aws:kms"
    }
  }
}

data "aws_iam_policy_document" "data_bucket" {
  for_each = aws_s3_bucket.data

  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]
    resources = [
      each.value.arn,
      "${each.value.arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "data" {
  for_each = aws_s3_bucket.data

  bucket = each.value.id
  policy = data.aws_iam_policy_document.data_bucket[each.key].json
}

# Browser uploads go directly to a short-lived presigned URL. CORS only lets the
# browser send that signed request; it grants no S3 permission and the bucket remains
# fully private. Origins are intentionally broad because dev, preview and production
# hosts all use the same API-generated signature and none are known to this stack.
resource "aws_s3_bucket_cors_configuration" "quarantine" {
  bucket = aws_s3_bucket.data["quarantine"].id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["PUT"]
    allowed_origins = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 900
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "quarantine" {
  bucket = aws_s3_bucket.data["quarantine"].id

  depends_on = [aws_s3_bucket_versioning.data]

  rule {
    id     = "expire-quarantine"
    status = "Enabled"

    filter {}

    expiration {
      days = 7
    }

    noncurrent_version_expiration {
      noncurrent_days = 7
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "uploads" {
  bucket = aws_s3_bucket.data["uploads"].id

  depends_on = [aws_s3_bucket_versioning.data]

  rule {
    id     = "archive-uploads"
    status = "Enabled"

    filter {}

    transition {
      days          = 90
      storage_class = "STANDARD_IA"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "exports" {
  bucket = aws_s3_bucket.data["exports"].id

  depends_on = [aws_s3_bucket_versioning.data]

  rule {
    id     = "expire-exports"
    status = "Enabled"

    filter {}

    expiration {
      days = 7
    }

    noncurrent_version_expiration {
      noncurrent_days = 7
    }
  }
}
