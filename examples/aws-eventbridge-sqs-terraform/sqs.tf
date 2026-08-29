resource "aws_sqs_queue" "dlq" {
  for_each = toset(var.cluster_names)

  name                      = "${var.name_prefix}-${each.key}-dlq"
  message_retention_seconds = 1209600 # 14 days
  sqs_managed_sse_enabled   = true
  tags                      = var.tags
}

resource "aws_sqs_queue" "cluster" {
  for_each = toset(var.cluster_names)

  name                       = "${var.name_prefix}-${each.key}"
  visibility_timeout_seconds = 30
  # The controller's fallback poller covers missed events, so long retention
  # adds nothing.
  message_retention_seconds = 3600
  sqs_managed_sse_enabled   = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq[each.key].arn
    maxReceiveCount     = 5
  })

  tags = var.tags
}

resource "aws_sns_topic_subscription" "cluster" {
  for_each = toset(var.cluster_names)

  topic_arn = aws_sns_topic.secrets_manager_changes.arn
  protocol  = "sqs"
  endpoint  = aws_sqs_queue.cluster[each.key].arn

  # Deliver the EventBridge event directly, without the SNS envelope. The
  # controller tolerates both, but raw delivery keeps messages smaller.
  raw_message_delivery = true
}

data "aws_iam_policy_document" "queue_policy" {
  for_each = toset(var.cluster_names)

  statement {
    sid     = "AllowSnsSendMessage"
    effect  = "Allow"
    actions = ["sqs:SendMessage"]

    principals {
      type        = "Service"
      identifiers = ["sns.amazonaws.com"]
    }

    resources = [aws_sqs_queue.cluster[each.key].arn]

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_sns_topic.secrets_manager_changes.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "cluster" {
  for_each = toset(var.cluster_names)

  queue_url = aws_sqs_queue.cluster[each.key].id
  policy    = data.aws_iam_policy_document.queue_policy[each.key].json
}
