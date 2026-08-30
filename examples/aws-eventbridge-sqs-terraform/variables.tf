variable "aws_region" {
  description = "AWS region to provision the event infrastructure in."
  type        = string
  default     = "us-west-2"
}

variable "cluster_name" {
  description = "Cluster name; used in queue, role, and alarm names."
  type        = string
}

variable "oidc_provider_arn" {
  description = "IAM OIDC provider ARN of the EKS cluster, for the controller's IRSA role."
  type        = string
}

variable "kubeconfig_path" {
  description = "Path to the kubeconfig used by the helm provider."
  type        = string
  default     = "~/.kube/config"
}

variable "kubeconfig_context" {
  description = "Kubeconfig context of the target cluster (empty uses the current context)."
  type        = string
  default     = null
}

variable "name_prefix" {
  description = "Prefix for all created resources."
  type        = string
  default     = "kes-secrets-events"
}

variable "secret_name_prefixes" {
  description = "Optional secret-name prefixes to filter events on (detail.name)."
  type        = list(string)
  default     = []
}

variable "secret_arns" {
  description = "Secrets Manager ARNs the controller may read; narrow from the all-secrets default."
  type        = list(string)
  default     = ["*"]
}

variable "alarm_actions" {
  description = "ARNs notified when the queue-age or DLQ alarms fire."
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Tags applied to all created AWS resources."
  type        = map(string)
  default     = {}
}
