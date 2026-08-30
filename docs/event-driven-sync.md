# Event-driven sync for AWS Secrets Manager

This document is the complete reference for the event-driven sync feature:
why it exists, how it works, how to deploy it, how to operate it, and the
design decisions behind it. For a quick start, the
[README section](../README.md#event-driven-sync-aws-secrets-manager--eventbridge--sqs)
covers the essentials.

- [Motivation](#motivation)
- [Architecture](#architecture)
- [How a sync happens](#how-a-sync-happens)
- [Setup](#setup)
- [Configuration reference](#configuration-reference)
- [Observability](#observability)
- [Failure modes and runbook](#failure-modes-and-runbook)
- [Design decisions](#design-decisions)
- [Scale characteristics](#scale-characteristics)
- [Rollout checklist](#rollout-checklist)

## Motivation

By default the controller polls every backend secret every
`POLLER_INTERVAL_MILLISECONDS` (10s). For AWS Secrets Manager that means one
billed `GetSecretValue` call per key per poll — roughly **$1.30 per key per
month** at the default interval ($0.05 per 10,000 calls × ~259k calls/month),
plus a Kubernetes API round-trip storm: every poll reads the namespace, reads
the Secret, and writes the ExternalSecret status.

Event-driven sync inverts the model: the controller learns about changes
instead of asking about them. With the poller relaxed to an hourly reconcile,
the AWS bill for reads drops by ~99% while freshness *improves* — a rotated
secret propagates in seconds instead of within a poll interval.

## Architecture

```
                        AWS account (per region)
  ┌──────────────────────────────────────────────────────────────┐
  │  Secrets Manager                                             │
  │      │  "Secret Label Updated" native event                  │
  │      │  (AWSCURRENT moved to a new version)                  │
  │      ▼                                                       │
  │  EventBridge rule ──► SNS topic ──┬─► SQS queue (cluster A)  │
  │                                   ├─► SQS queue (cluster B)  │
  │                                   └─► SQS queue (cluster N)  │
  └───────────────────────────────────────────│──────────────────┘
                                              │ long-poll (20s)
                                              ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  kubernetes-external-secrets controller (one per cluster)    │
  │                                                              │
  │  SqsConsumer ──► reverse name index ──► Poller.triggerSync() │
  │  (lib/sqs-consumer.js)  (lib/daemon.js)   (lib/poller.js)    │
  │                                              │               │
  │                       GetSecretValue(AWSCURRENT) + diff      │
  │                                              │               │
  │                                     k8s Secret upsert        │
  └──────────────────────────────────────────────────────────────┘
```

The event source is the
[`Secret Label Updated` native EventBridge event](https://docs.aws.amazon.com/secretsmanager/latest/userguide/secret-event-notifications.html),
matched with `detail.labelUpdated: ["AWSCURRENT"]`. It fires whenever the
active secret value changes — manual `PutSecretValue`/`UpdateSecret` and
completed rotations alike — is **enabled by default for every secret**, and
requires **no CloudTrail trail**. The consumer also understands
CloudTrail-derived EventBridge events (`requestParameters.secretId`,
`responseElements.arn`/`aRN`, `additionalEventData.SecretId`) and both raw
and SNS-enveloped delivery, should you route your own events.

The fan-out is one EventBridge rule and one SNS topic per region, with one
SQS queue per cluster. Each controller pulls from its own queue, so no
ingress into any cluster is needed, a down cluster just accumulates messages
(1h retention), and adding a cluster is a queue + subscription + IAM policy.

## How a sync happens

Events are **hints, not commands** — the system is level-triggered:

1. The consumer long-polls its queue (`WaitTimeSeconds` 20 by default) and
   extracts candidate secret identifiers from each message. Messages are
   always deleted after processing, matched or not; the fallback poller is
   the correctness backstop, so redelivery has no value.
2. Candidates are matched against a reverse index of every `secretsManager`
   ExternalSecret's keys, maintained by the daemon as ExternalSecrets come
   and go. Matching is by **name**: ARNs additionally match with their random
   `-XXXXXX` suffix stripped, while plain names are taken literally (so
   `app/creds-master` never also matches `app/creds`).
3. A **rate floor** allows at most one event-triggered sync per
   ExternalSecret per `EVENT_SYNC_MIN_INTERVAL_MILLISECONDS` (default 10s).
   A suppressed event is not dropped — it is **deferred to the window's
   end**, so a burst that stops mid-window still converges without waiting
   for the fallback poll.
4. `triggerSync()` debounces 500ms (bursts within one SQS batch collapse
   into one poll) and then runs a normal poll: fetch `GetSecretValue` with
   `VersionStage: AWSCURRENT`, diff against the live k8s Secret, and write
   only if something changed.

Because the fetch always reads whatever is current *at fetch time*, ordering
and duplicate delivery — both permitted by SQS standard queues — cost
nothing: five reordered stale events all collapse into "read AWSCURRENT",
which returns the newest value. No version bookkeeping is needed for
correctness; versions are recorded purely for observability (see below).

**The fallback poller stays on.** Events can be delayed or missed, and they
say nothing about changes made while the controller was down. Do not set
`DISABLE_POLLING`; raise the interval instead so polling becomes a cheap
reconcile loop:

```yaml
env:
  AWS_SQS_QUEUE_URL: "https://sqs.us-west-2.amazonaws.com/123456789012/kes-secrets-events-mycluster"
  POLLER_INTERVAL_MILLISECONDS: "3600000"   # hourly reconcile; events handle freshness
```

## Setup

### 1. Terraform (the batteries-included path)

The Terraform modules in
[`examples/aws-eventbridge-sqs-terraform`](../examples/aws-eventbridge-sqs-terraform)
provision the entire stack: the shared event bus (`modules/event-bus`:
EventBridge rule + SNS topic, optionally narrowed with
`secret_name_prefixes`), and per cluster (`modules/cluster`) the SQS queue +
DLQ + CloudWatch alarms, an IRSA role with least-privilege SQS and
Secrets Manager policies, and the helm chart itself — wired together.

```hcl
module "event_bus" {
  source               = "./modules/event-bus"
  secret_name_prefixes = ["prod/"]   # optional but recommended
}

module "cluster" {
  source            = "./modules/cluster"
  cluster_name      = "prod-us-west-2"
  sns_topic_arn     = module.event_bus.sns_topic_arn
  oidc_provider_arn = "arn:aws:iam::111111111111:oidc-provider/..."
  secret_arns       = ["arn:aws:secretsmanager:us-west-2:111111111111:secret:prod/*"]
  alarm_actions     = [aws_sns_topic.oncall.arn]
}
```

With that in place, steps 2 and 3 below are already done for you — they
document what the module wires up, for anyone provisioning by other means.
`secret_name_prefixes` is strongly recommended in shared accounts: without
it every label change in the account/region fans out to every cluster queue
(names and ARNs only, never values). EventBridge rules are regional: repeat
the stack in every region whose secrets you sync.

### 2. Controller IAM

Attach the per-cluster policy from the Terraform outputs to the controller's
IRSA role, or grant equivalently:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["sqs:ReceiveMessage", "sqs:DeleteMessage"],
    "Resource": "arn:aws:sqs:<region>:<account>:<queue-name>"
  }]
}
```

### 3. Controller configuration

Set `env.AWS_SQS_QUEUE_URL` (Helm) to that cluster's queue URL and raise
`env.POLLER_INTERVAL_MILLISECONDS` — see the example above. All env values
in the chart must be quoted strings. The feature is entirely inert until
`AWS_SQS_QUEUE_URL` is set, and rollback is unsetting it.

The SQS client's region is derived from the queue URL itself, so a queue in
another region than `AWS_REGION` works without extra configuration.

## Configuration reference

| Env var | Description | Default |
| ------- | ----------- | ------- |
| `AWS_SQS_QUEUE_URL` | Queue to long-poll for change events; **enables the feature when set** | unset |
| `AWS_SQS_WAIT_TIME_SECONDS` | Long-poll wait per `ReceiveMessage`, clamped to 1–20 (empty/invalid input keeps the default) | `20` |
| `AWS_SQS_ENDPOINT` | Custom SQS endpoint (FIPS / VPC endpoint) | unset |
| `EVENT_SYNC_MIN_INTERVAL_MILLISECONDS` | Rate floor: minimum interval between event-triggered syncs of the same ExternalSecret; explicit `"0"` opts out, empty/invalid input keeps the default | `10000` |
| `POLLER_INTERVAL_MILLISECONDS` | Fallback reconcile interval; recommended `"3600000"` when the queue is enabled | `10000` |

Matching scope and exclusions:

- Only `backendType: secretsManager` (and the legacy `secretManager` alias)
  ExternalSecrets participate; other backends are unaffected.
- Entries pinned with `versionId` are never event-synced — a change event
  cannot alter what a pinned version resolves to. (`versionStage`-pinned
  entries such as `AWSPREVIOUS` still work: that label moves exactly when
  `AWSCURRENT` does.)
- Deleting or restoring a secret publishes no native event; the fallback
  poller reconciles those changes.

## Observability

### Metrics

| Metric | Type | Meaning |
| ------ | ---- | ------- |
| `kubernetes_external_secrets_sqs_consumer_running` | Gauge | 1 while the consumer is healthy; 0 when the loop has died **or receives have failed continuously** (backoff maxed out, ~63s of failures) |
| `kubernetes_external_secrets_sqs_messages_received_total` | Counter | Messages consumed from the queue |
| `kubernetes_external_secrets_sqs_receive_errors_total` | Counter | Failed `ReceiveMessage` calls |
| `kubernetes_external_secrets_event_triggered_syncs_total{name,namespace}` | Counter | Syncs triggered by events, per ExternalSecret |

Recommended alerts:

```
kubernetes_external_secrets_sqs_consumer_running == 0        # event sync is down
rate(kubernetes_external_secrets_sqs_receive_errors_total[10m]) > 0   # early warning
```

The Terraform stack adds the AWS-side complements: a per-cluster queue-age
alarm (`ApproximateAgeOfOldestMessage > 10m` — events arriving but nobody
consuming) and a DLQ-not-empty alarm. Note the queue-age alarm can
auto-resolve once the 1-hour retention expires the backlog, which is exactly
why it must be paired with the `sqs_consumer_running` gauge.

### Which secret version is this cluster running?

After every successful sync, the ExternalSecret's status records the
Secrets Manager `VersionId` each backend key resolved to:

```console
$ kubectl get externalsecret demo-credentials -o jsonpath='{.status.observedVersions}'
{"demo-service/credentials":"73837eac-ad0a-447b-a02a-d69848a0d3c7"}
```

`status.lastSync` tells you *when* the cluster last synced;
`status.observedVersions` tells you *what* it synced. During a rotation
incident, comparing `observedVersions` against
`aws secretsmanager describe-secret` answers immediately whether a cluster
has picked up the new version. The field is only written on success, so an
error never erases the last known-good versions.

## Failure modes and runbook

| Symptom | Likely cause | What happens meanwhile | Action |
| ------- | ------------ | ---------------------- | ------ |
| `sqs_consumer_running == 0`, `sqs_receive_errors_total` climbing | Bad IAM, wrong queue URL, blocked proxy, deleted queue | Fallback poll keeps secrets correct at up to `POLLER_INTERVAL` staleness | Check the controller log for the receive error; verify IRSA policy and queue URL |
| Queue-age alarm firing, gauge is 1 | Controller not consuming *this* queue (wrong URL — consuming another queue — or wrong cluster's URL configured) | Events pile up 1h, then expire | Compare `AWS_SQS_QUEUE_URL` against the Terraform output for this cluster |
| DLQ alarm firing | Messages failing delivery 5× (malformed by an upstream producer, or a consumer crash-loop mid-batch) | Affected events lost to the DLQ; fallback poll reconciles | Inspect a DLQ message body; if it's a shape the consumer should parse, file a bug with the payload |
| Secret rotated but cluster stale, no alarms | Event never produced (secret in an unmatched region, or `secret_name_prefixes` filter excludes it) | Fallback poll reconciles within the interval | Check the EventBridge rule's region and `detail.name` prefixes cover the secret |
| Controller restarts frequently | Unrelated crash — event sync is supervised and cannot take the process down, but every restart re-syncs everything | Boot re-sync (fast; see scale numbers) | Debug the crash cause from logs |

Degradation is always *graceful*: every failure mode above falls back to the
polling behavior this controller has always had. The alerts exist because
that fallback is silent — without them, "events are broken" looks identical
to "nothing changed lately".

## Design decisions

These are settled tradeoffs, documented so they aren't re-litigated by
accident:

- **Level-triggered, not edge-triggered.** Events only ever mean "go read
  AWSCURRENT now". The fetched value is authoritative; event payloads never
  are. This makes reordering, duplication, and loss individually harmless.
- **Always delete messages**, matched or not. Unmatched events are the
  common case in a shared account, redelivery cannot fix a parse failure,
  and the poller is the correctness backstop.
- **Name-only matching, ignoring region/account.** A same-named secret
  elsewhere causes at most a spurious re-sync that fetches identical data
  and writes nothing. Erring toward freshness beats missing a rotation.
- **ARN-only suffix stripping.** Only ARN-derived identifiers get the random
  `-XXXXXX` suffix stripped. Plain names are literal — common human suffixes
  (`-master`, `-config`, …) must not cross-match, since every false positive
  is amplification fuel.
- **Rate floor with trailing-edge deferral.** Account-wide churn on the
  shared queue must not amplify into unbounded kube-apiserver load (each
  sync costs ~5 API calls). The floor caps it at parity with the old
  10s-poll ceiling; deferral (not dropping) preserves convergence when a
  burst ends inside the window.
- **Single replica.** SQS splits messages across consumers, so a second
  replica would see only half the events. The chart already declares
  multiple replicas unsupported; the fallback poll covers the gap
  regardless.
- **SNS `raw_message_delivery = true`** in the Terraform, to skip the
  envelope — but the consumer tolerates both forms.
- **Version tracking is observability, not correctness.** `observedVersions`
  is recorded from `GetSecretValue` responses; the consumer never skips a
  fetch based on a version comparison, because a false skip is worse than a
  redundant read the rate floor already bounds.

## Scale characteristics

Measured on a 2,500-ExternalSecret kind + LocalStack stress test (mixed
plain/`dataFrom`/templated specs, a 50-ES hot shared secret, and a 3-minute
storm of 3,920 rotations + events at 5s/30s/one-shot cadences):

- Boot storm: 2,500 ExternalSecrets synced in **38s**, exactly one sync
  each, zero errors.
- Rotation wave: 100 rotated secrets propagated **<1s** after their events.
- Hot burst: 300 events for one secret referenced by 50 ExternalSecrets held
  to the rate-floor ceiling — 150 syncs vs ~15,000 unbounded — with ~7ms
  metrics-endpoint latency throughout.
- Storm: ~22 events/s sustained, 0 errors, 0 lost messages (3,920/3,920
  consumed, 441 deferred by the rate floor), flat RSS (~635MB for 2,500
  pollers), full convergence in every cadence tier.
- Churn: ExternalSecrets deleted while events for them were in flight;
  controller survives (a delete-during-poll crash was found by this test
  and fixed), recreated ExternalSecrets re-sync fresh values.

## Rollout checklist

1. Apply the Terraform stack; attach the per-cluster IAM policy to the
   controller's IRSA role.
2. Set `env.AWS_SQS_QUEUE_URL` — and nothing else yet. The controller now
   consumes events *in addition to* its normal fast polling.
3. **Rotate one staging secret and watch
   `kubernetes_external_secrets_event_triggered_syncs_total` increment
   within seconds.** This is the one step that verifies real
   EventBridge→SNS→SQS delivery end-to-end; every other layer has been
   verified against AWS's published event schema and LocalStack, but not
   live traffic. Do not skip it.
4. Wire the two Prometheus alerts and the CloudWatch alarm actions.
5. Only then raise `env.POLLER_INTERVAL_MILLISECONDS` (e.g. `"3600000"`).
   The order matters: until the interval is raised, a broken event pipeline
   costs nothing; after, it costs freshness — which is why step 3 comes
   first.
