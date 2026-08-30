# Account/region-level event source, shared by every cluster:
# Secrets Manager's native "Secret Label Updated" event -> EventBridge -> SNS.
# Enabled by default for all secrets; no CloudTrail trail required.
# https://docs.aws.amazon.com/secretsmanager/latest/userguide/secret-event-notifications.html
resource "aws_cloudwatch_event_rule" "secrets_manager_changes" {
  name        = "${var.name_prefix}-rule"
  description = "Secrets Manager active-value changes for kubernetes-external-secrets event-driven sync"
  tags        = var.tags

  event_pattern = jsonencode({
    source      = ["aws.secretsmanager"]
    detail-type = ["Secret Label Updated"]
    detail = merge(
      { labelUpdated = ["AWSCURRENT"] },
      # Narrowing to your secrets' name prefixes shrinks both the metadata
      # fan-out and the event volume every cluster has to absorb.
      length(var.secret_name_prefixes) > 0
      ? { name = [for p in var.secret_name_prefixes : { prefix = p }] }
      : {}
    )
  })
}

resource "aws_sns_topic" "secrets_manager_changes" {
  name = "${var.name_prefix}-topic"
  tags = var.tags
}

data "aws_iam_policy_document" "sns_topic_policy" {
  statement {
    sid     = "AllowEventBridgePublish"
    effect  = "Allow"
    actions = ["sns:Publish"]

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }

    resources = [aws_sns_topic.secrets_manager_changes.arn]

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_event_rule.secrets_manager_changes.arn]
    }
  }
}

resource "aws_sns_topic_policy" "secrets_manager_changes" {
  arn    = aws_sns_topic.secrets_manager_changes.arn
  policy = data.aws_iam_policy_document.sns_topic_policy.json
}

resource "aws_cloudwatch_event_target" "to_sns" {
  rule = aws_cloudwatch_event_rule.secrets_manager_changes.name
  arn  = aws_sns_topic.secrets_manager_changes.arn
}
