# One IAM policy per cluster granting the kubernetes-external-secrets
# controller access to its queue. Attach it to the controller's IRSA role
# for that cluster.
data "aws_iam_policy_document" "consumer" {
  for_each = toset(var.cluster_names)

  statement {
    sid    = "AllowQueueConsume"
    effect = "Allow"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
    ]
    resources = [aws_sqs_queue.cluster[each.key].arn]
  }
}

resource "aws_iam_policy" "consumer" {
  for_each = toset(var.cluster_names)

  name   = "${var.name_prefix}-${each.key}-consumer"
  policy = data.aws_iam_policy_document.consumer[each.key].json
  tags   = var.tags
}
