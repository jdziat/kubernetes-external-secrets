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
