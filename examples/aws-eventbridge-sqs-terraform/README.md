# Terraform: full event-driven sync deployment

Provisions everything kubernetes-external-secrets event-driven sync needs —
AWS event infrastructure, per-cluster queues, IRSA roles, and the helm chart
itself:

```
Secrets Manager "Secret Label Updated" event (AWSCURRENT moved)
  → EventBridge rule → SNS topic            [modules/event-bus, one per region]
    → SQS queue + DLQ + alarms              ┐
    → IRSA role (SQS consume + secrets read)│ [modules/cluster, one per cluster]
    → helm_release of the controller chart  ┘
```

## Modules

### `modules/event-bus` — one per AWS account/region

EventBridge rule matching the native `Secret Label Updated` event
(`labelUpdated = AWSCURRENT` — fires on manual updates and completed
rotations, enabled by default for every secret, **no CloudTrail required**),
publishing to an SNS topic that every cluster queue subscribes to.
Optionally narrowed with `secret_name_prefixes`.

### `modules/cluster` — one per cluster

- SQS queue (SSE, 1h retention) + DLQ (redrive after 5 failed receives),
  subscribed to the topic with `raw_message_delivery`.
- CloudWatch alarms: queue-age (`ApproximateAgeOfOldestMessage > 10m`) and
  DLQ-not-empty. Pair with an alert on the controller's
  `kubernetes_external_secrets_sqs_consumer_running` gauge — the queue-age
  alarm can auto-resolve once the 1h retention expires the backlog.
- IRSA role trusted only by the controller's service account
  (`system:serviceaccount:<namespace>:<service_account_name>` via the
  cluster's OIDC provider), with inline least-privilege policies:
  `sqs:ReceiveMessage`/`DeleteMessage` on this queue, and
  `secretsmanager:GetSecretValue` on `secret_arns` (**narrow this from the
  all-secrets default**).
- `helm_release` installing the chart from
  `oci://ghcr.io/jdziat/charts/kubernetes-external-secrets`, wired up with
  the IRSA annotation, `fsGroup: 65534`, `AWS_SQS_QUEUE_URL`, and an hourly
  fallback `POLLER_INTERVAL_MILLISECONDS`. Set `install_chart = false` for
  AWS-side resources only; add chart config through `extra_values`.

## Usage

The root of this directory is a working single-cluster composition:

```bash
terraform apply \
  -var cluster_name=prod-us-west-2 \
  -var oidc_provider_arn=arn:aws:iam::111111111111:oidc-provider/oidc.eks.us-west-2.amazonaws.com/id/EXAMPLE \
  -var 'secret_name_prefixes=["prod/"]' \
  -var 'secret_arns=["arn:aws:secretsmanager:us-west-2:111111111111:secret:prod/*"]'
```

For multiple clusters, instantiate `modules/cluster` once per cluster.
Terraform cannot create providers per `for_each`, so each cluster needs its
own aliased helm provider:

```hcl
provider "helm" {
  alias = "staging"
  kubernetes = {
    config_path    = "~/.kube/config"
    config_context = "staging-us-west-2"
  }
}

module "cluster_staging" {
  source    = "./modules/cluster"
  providers = { helm = helm.staging }

  cluster_name      = "staging-us-west-2"
  sns_topic_arn     = module.event_bus.sns_topic_arn
  oidc_provider_arn = "arn:aws:iam::111111111111:oidc-provider/..."

  extra_values = [yamlencode({
    env = { LOG_LEVEL = "debug" }
  })]
}
```

EventBridge rules are regional: repeat the `event-bus` module (and the
cluster queues) in every region whose secrets you sync.

## Rollout order

Per the [rollout checklist](../../docs/event-driven-sync.md#rollout-checklist):
the module defaults `POLLER_INTERVAL_MILLISECONDS` to hourly, so before
relying on it in production, **rotate one staging secret and watch
`kubernetes_external_secrets_event_triggered_syncs_total` increment** to
verify live EventBridge→SNS→SQS delivery end-to-end. To stage the rollout
conservatively, set `extra_values` with a fast
`POLLER_INTERVAL_MILLISECONDS` first and raise it after the verification.

## Notes

- The event carries the secret's friendly name and ARN but never the secret
  value; the controller fetches values itself via `GetSecretValue`.
- Every cluster's queue receives events for **all** matching label changes
  in the account/region, so controllers see the names/ARNs of secrets
  belonging to other clusters (values never leave AWS). Use
  `secret_name_prefixes` to narrow at the source.
- `install_chart = false` plus the `role_arn`/`queue_url` outputs supports
  clusters where helm runs elsewhere (e.g. Argo CD) — annotate the service
  account with `role_arn` and set `env.AWS_SQS_QUEUE_URL` to `queue_url`.
