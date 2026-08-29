variable "cluster_names" {
  description = "Kubernetes cluster names; one SQS queue is created per cluster. Duplicates are collapsed."
  type        = list(string)

  validation {
    # 80-char SQS queue name cap minus the default prefix, separator and
    # "-dlq" suffix leaves 57 chars for the cluster name.
    condition     = alltrue([for name in var.cluster_names : can(regex("^[a-zA-Z0-9_-]{1,57}$", name))])
    error_message = "Cluster names must be 1-57 chars of [a-zA-Z0-9_-] so derived SQS queue names stay within the 80-char limit."
  }
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
