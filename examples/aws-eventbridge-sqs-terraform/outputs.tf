output "queue_url" {
  description = "The cluster's SQS queue URL."
  value       = module.cluster.queue_url
}

output "role_arn" {
  description = "IRSA role the controller runs as."
  value       = module.cluster.role_arn
}

output "sns_topic_arn" {
  description = "Shared SNS topic for additional cluster subscriptions."
  value       = module.event_bus.sns_topic_arn
}
