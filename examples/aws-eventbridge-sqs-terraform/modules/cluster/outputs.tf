output "queue_url" {
  description = "This cluster's SQS queue URL (wired into the controller as AWS_SQS_QUEUE_URL)."
  value       = aws_sqs_queue.cluster.url
}

output "queue_arn" {
  description = "This cluster's SQS queue ARN."
  value       = aws_sqs_queue.cluster.arn
}

output "dlq_arn" {
  description = "This cluster's dead-letter queue ARN."
  value       = aws_sqs_queue.dlq.arn
}

output "role_arn" {
  description = "IRSA role the controller runs as."
  value       = aws_iam_role.controller.arn
}
