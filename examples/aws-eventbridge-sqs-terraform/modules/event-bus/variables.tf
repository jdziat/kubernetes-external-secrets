variable "name_prefix" {
  description = "Prefix for all created resources."
  type        = string
  default     = "kes-secrets-events"

  validation {
    condition     = length(var.name_prefix) <= 18
    error_message = "name_prefix must be 18 chars or fewer so per-cluster queue names derived from it stay within the 80-char SQS limit."
  }
}

variable "secret_name_prefixes" {
  description = "Optional secret-name prefixes to filter events on (detail.name). Empty means all label changes in the account/region fan out to every subscribed queue."
  type        = list(string)
  default     = []
}

variable "kms_key_arn" {
  description = "Customer-managed KMS key ARN to encrypt the SNS topic. Its key policy must grant events.amazonaws.com kms:GenerateDataKey* and kms:Decrypt; the AWS-managed alias/aws/sns key cannot be used with EventBridge. Null leaves the topic unencrypted (events carry secret names/ARNs, never values)."
  type        = string
  default     = null
}

variable "tags" {
  description = "Tags applied to all created resources."
  type        = map(string)
  default     = {}
}
