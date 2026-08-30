output "sns_topic_arn" {
  description = "SNS topic per-cluster queues subscribe to."
  value       = aws_sns_topic.secrets_manager_changes.arn
}

output "event_rule_arn" {
  description = "EventBridge rule matching Secrets Manager active-value changes."
  value       = aws_cloudwatch_event_rule.secrets_manager_changes.arn
}
