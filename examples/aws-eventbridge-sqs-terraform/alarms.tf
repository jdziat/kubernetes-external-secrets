# Silent event-flow failure is the operational risk of this design: the
# controller keeps running and the fallback poller hides the gap for up to an
# hour. These alarms make a stall visible.
resource "aws_cloudwatch_metric_alarm" "queue_age" {
  for_each = toset(var.cluster_names)

  alarm_name          = "${var.name_prefix}-${each.key}-queue-age"
  alarm_description   = "Events for ${each.key} are not being consumed; check the kubernetes-external-secrets SQS consumer (kubernetes_external_secrets_sqs_consumer_running metric)."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  dimensions          = { QueueName = aws_sqs_queue.cluster[each.key].name }
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
  for_each = toset(var.cluster_names)

  alarm_name          = "${var.name_prefix}-${each.key}-dlq-not-empty"
  alarm_description   = "Messages for ${each.key} were dead-lettered after repeated delivery failures."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.dlq[each.key].name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions
  tags                = var.tags
}
