variable "cluster_names" {
  description = "Kubernetes cluster names; one SQS queue is created per cluster."
  type        = list(string)
}

variable "name_prefix" {
  description = "Prefix for all created resources."
  type        = string
  default     = "kes-secrets-events"
}

variable "alarm_actions" {
  description = "ARNs (e.g. SNS topics) notified when the queue-age or DLQ alarms fire."
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Tags applied to all created resources."
  type        = map(string)
  default     = {}
}
