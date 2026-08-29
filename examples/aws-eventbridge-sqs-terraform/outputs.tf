output "queue_urls" {
  description = "Per-cluster SQS queue URL; set as AWS_SQS_QUEUE_URL on that cluster's controller."
  value       = { for name in var.cluster_names : name => aws_sqs_queue.cluster[name].url }
}

output "consumer_policy_arns" {
  description = "Per-cluster IAM policy ARN to attach to the controller's IRSA role."
  value       = { for name in var.cluster_names : name => aws_iam_policy.consumer[name].arn }
}
