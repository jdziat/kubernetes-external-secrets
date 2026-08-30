# IRSA: an IAM role only the controller's Kubernetes service account can
# assume, via the cluster's OIDC provider.
locals {
  # arn:aws:iam::<acct>:oidc-provider/oidc.eks.<region>.amazonaws.com/id/XXXX
  # -> oidc.eks.<region>.amazonaws.com/id/XXXX
  oidc_issuer = replace(var.oidc_provider_arn, "/^.*oidc-provider//", "")
}

data "aws_iam_policy_document" "assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [var.oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.oidc_issuer}:sub"
      values   = ["system:serviceaccount:${var.namespace}:${var.service_account_name}"]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.oidc_issuer}:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "controller" {
  name               = "${var.name_prefix}-${var.cluster_name}-controller"
  assume_role_policy = data.aws_iam_policy_document.assume_role.json
  tags               = var.tags
}

data "aws_iam_policy_document" "queue_consume" {
  statement {
    sid    = "AllowQueueConsume"
    effect = "Allow"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
    ]
    resources = [aws_sqs_queue.cluster.arn]
  }
}

resource "aws_iam_role_policy" "queue_consume" {
  name   = "queue-consume"
  role   = aws_iam_role.controller.id
  policy = data.aws_iam_policy_document.queue_consume.json
}

data "aws_iam_policy_document" "secrets_read" {
  statement {
    sid       = "AllowSecretsRead"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = var.secret_arns
  }
}

resource "aws_iam_role_policy" "secrets_read" {
  name   = "secrets-read"
  role   = aws_iam_role.controller.id
  policy = data.aws_iam_policy_document.secrets_read.json
}
