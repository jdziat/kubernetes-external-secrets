# Per-cluster deployment: SQS queue + DLQ + alarms, an IRSA role the
# controller runs as, and (optionally) the helm chart itself.
data "aws_region" "current" {}

resource "aws_sqs_queue" "dlq" {
  name                      = "${var.name_prefix}-${var.cluster_name}-dlq"
  message_retention_seconds = 1209600 # 14 days
  sqs_managed_sse_enabled   = true
  tags                      = var.tags
}

resource "aws_sqs_queue" "cluster" {
  name                       = "${var.name_prefix}-${var.cluster_name}"
  visibility_timeout_seconds = 30
  # The controller's fallback poller covers missed events, so long retention
  # adds nothing.
  message_retention_seconds = 3600
  sqs_managed_sse_enabled   = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = 5
  })

  tags = var.tags
}

resource "aws_sns_topic_subscription" "cluster" {
  topic_arn = var.sns_topic_arn
  protocol  = "sqs"
  endpoint  = aws_sqs_queue.cluster.arn

  # Deliver the EventBridge event directly, without the SNS envelope. The
  # controller tolerates both, but raw delivery keeps messages smaller.
  raw_message_delivery = true
}

data "aws_iam_policy_document" "queue_policy" {
  statement {
    sid     = "AllowSnsSendMessage"
    effect  = "Allow"
    actions = ["sqs:SendMessage"]

    principals {
      type        = "Service"
      identifiers = ["sns.amazonaws.com"]
    }

    resources = [aws_sqs_queue.cluster.arn]

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [var.sns_topic_arn]
    }
  }
}

resource "aws_sqs_queue_policy" "cluster" {
  queue_url = aws_sqs_queue.cluster.id
  policy    = data.aws_iam_policy_document.queue_policy.json
}

# Silent event-flow failure is the operational risk of this design: the
# controller keeps running and the fallback poller hides the gap. These
# alarms make a stall visible; pair them with an alert on the controller's
# kubernetes_external_secrets_sqs_consumer_running gauge.
resource "aws_cloudwatch_metric_alarm" "queue_age" {
  alarm_name          = "${var.name_prefix}-${var.cluster_name}-queue-age"
  alarm_description   = "Events for ${var.cluster_name} are not being consumed; check the kubernetes-external-secrets SQS consumer (kubernetes_external_secrets_sqs_consumer_running metric)."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  dimensions          = { QueueName = aws_sqs_queue.cluster.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 3
  threshold           = 600
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions
  tags                = var.tags
}

resource "aws_cloudwatch_metric_alarm" "dlq_messages" {
  alarm_name          = "${var.name_prefix}-${var.cluster_name}-dlq-not-empty"
  alarm_description   = "Messages for ${var.cluster_name} were dead-lettered after repeated delivery failures."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.dlq.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions
  tags                = var.tags
}
