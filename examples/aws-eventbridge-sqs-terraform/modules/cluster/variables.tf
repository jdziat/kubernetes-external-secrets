variable "cluster_name" {
  description = "Cluster name; used in queue, role, and alarm names."
  type        = string

  validation {
    # 80-char SQS queue name cap minus the default prefix, separator and
    # "-dlq" suffix leaves 57 chars for the cluster name.
    condition     = can(regex("^[a-zA-Z0-9_-]{1,57}$", var.cluster_name))
    error_message = "cluster_name must be 1-57 chars of [a-zA-Z0-9_-] so derived SQS queue names stay within the 80-char limit."
  }
}

variable "name_prefix" {
  description = "Prefix for all created resources; must match the event-bus module's."
  type        = string
  default     = "kes-secrets-events"

  validation {
    condition     = length(var.name_prefix) <= 18
    error_message = "name_prefix must be 18 chars or fewer so derived queue names stay within the 80-char SQS limit."
  }
}

variable "sns_topic_arn" {
  description = "SNS topic from the event-bus module that this cluster's queue subscribes to."
  type        = string
}

variable "oidc_provider_arn" {
  description = "IAM OIDC provider ARN of the EKS cluster (aws_iam_openid_connect_provider / EKS module output), used for the IRSA trust policy."
  type        = string
}

variable "namespace" {
  description = "Kubernetes namespace the controller runs in."
  type        = string
  default     = "kube-system"
}

variable "service_account_name" {
  description = "Service account name the chart creates and the IRSA trust policy is scoped to."
  type        = string
  default     = "kubernetes-external-secrets"
}

variable "secret_arns" {
  description = "Secrets Manager secret ARNs the controller may read. Narrow this to your secrets' ARNs or prefix patterns; the default allows all secrets in the account."
  type        = list(string)
  default     = ["*"]
}

variable "install_chart" {
  description = "Install the helm chart. Disable to provision only the AWS-side resources (queue, alarms, IRSA role)."
  type        = bool
  default     = true
}

variable "release_name" {
  description = "Helm release name."
  type        = string
  default     = "kubernetes-external-secrets"
}

variable "chart_version" {
  description = "Chart version to install from oci://ghcr.io/jdziat/charts."
  type        = string
  default     = "8.6.0"
}

variable "poller_interval_milliseconds" {
  description = "Fallback reconcile interval for the controller. Events handle freshness; keep this long. Must be a string for the chart's env plumbing."
  type        = string
  default     = "3600000"
}

variable "extra_values" {
  description = "Additional raw YAML values documents merged into the helm release (later entries win over the module's generated values)."
  type        = list(string)
  default     = []
}

variable "alarm_actions" {
  description = "ARNs (e.g. SNS topics) notified when the queue-age or DLQ alarms fire."
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Tags applied to all created AWS resources."
  type        = map(string)
  default     = {}
}
