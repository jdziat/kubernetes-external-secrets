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

variable "tags" {
  description = "Tags applied to all created resources."
  type        = map(string)
  default     = {}
}
