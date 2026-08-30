# Install the controller chart, wired to the queue and the IRSA role.
# Extra/overriding configuration goes in var.extra_values (later entries win).
resource "helm_release" "kubernetes_external_secrets" {
  count = var.install_chart ? 1 : 0

  name      = var.release_name
  namespace = var.namespace

  repository = "oci://ghcr.io/jdziat/charts"
  chart      = "kubernetes-external-secrets"
  version    = var.chart_version

  values = concat([
    yamlencode({
      securityContext = { fsGroup = 65534 } # required for IRSA
      serviceAccount = {
        create = true
        name   = var.service_account_name
        annotations = {
          "eks.amazonaws.com/role-arn" = aws_iam_role.controller.arn
        }
      }
      env = {
        AWS_REGION                   = data.aws_region.current.name
        AWS_SQS_QUEUE_URL            = aws_sqs_queue.cluster.url
        POLLER_INTERVAL_MILLISECONDS = var.poller_interval_milliseconds
      }
    })
  ], var.extra_values)
}
