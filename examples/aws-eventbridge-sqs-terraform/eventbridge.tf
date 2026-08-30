# Secrets Manager publishes the native "Secret Label Updated" event to the
# default EventBridge bus whenever a staging label moves — on manual updates
# (PutSecretValue/UpdateSecret) and when rotation completes. It is enabled by
# default for all secrets and requires no CloudTrail trail. Matching
# AWSCURRENT means "the active secret value changed", which is exactly the
# signal the controller needs.
# https://docs.aws.amazon.com/secretsmanager/latest/userguide/secret-event-notifications.html
resource "aws_cloudwatch_event_rule" "secrets_manager_changes" {
  name        = "${var.name_prefix}-rule"
  description = "Secrets Manager active-value changes for kubernetes-external-secrets event-driven sync"
  tags        = var.tags

  event_pattern = jsonencode({
    source      = ["aws.secretsmanager"]
    detail-type = ["Secret Label Updated"]
    detail = merge(
      { labelUpdated = ["AWSCURRENT"] },
      # Narrowing to your secrets' name prefixes shrinks both the metadata
      # fan-out and the event volume every cluster has to absorb.
      length(var.secret_name_prefixes) > 0
      ? { name = [for p in var.secret_name_prefixes : { prefix = p }] }
      : {}
    )
  })
}

resource "aws_cloudwatch_event_target" "to_sns" {
  rule = aws_cloudwatch_event_rule.secrets_manager_changes.name
  arn  = aws_sns_topic.secrets_manager_changes.arn
}
