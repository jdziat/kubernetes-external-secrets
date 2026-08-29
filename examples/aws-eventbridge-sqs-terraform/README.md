# Event-driven sync infrastructure (EventBridge → SNS → SQS)

Provisions the AWS side of kubernetes-external-secrets event-driven sync for
one or more clusters in an account:

```
Secrets Manager "Secret Label Updated" event (AWSCURRENT moved)
  → EventBridge rule
    → SNS topic
      → one SQS queue per cluster (with DLQ + alarms)
        → controller long-polls its queue
```

The rule matches the native `Secret Label Updated` event, which Secrets
Manager publishes to the default EventBridge bus whenever the `AWSCURRENT`
staging label moves to a new version — i.e. whenever the active secret value
changes, whether by manual update or completed rotation. It is enabled by
default for every secret and **requires no CloudTrail trail**.

## Prerequisites

- Each cluster's controller runs with an IRSA role you can attach a policy to.

## Usage

```hcl
module "kes_events" {
  source        = "./examples/aws-eventbridge-sqs-terraform"
  cluster_names = ["prod-us-west-2", "staging-us-west-2"]
  alarm_actions = [aws_sns_topic.oncall.arn] # optional
}
```

Then, per cluster:

1. Attach `consumer_policy_arns[<cluster>]` to the controller's IRSA role.
2. Set `AWS_SQS_QUEUE_URL` to `queue_urls[<cluster>]` in the controller's env
   (Helm: `env.AWS_SQS_QUEUE_URL`).
3. Raise the fallback interval, e.g. `env.POLLER_INTERVAL_MILLISECONDS: "3600000"`.

EventBridge rules are regional: repeat this stack in every region whose
secrets you sync.

## Operability

Silent event-flow failure is the failure mode to watch: the controller keeps
running and the fallback poller masks a stall for up to an hour. Included:

- A queue-age alarm per cluster (`ApproximateAgeOfOldestMessage > 10m`) —
  fires when events arrive but nothing consumes them. Pair it with the
  controller's `kubernetes_external_secrets_sqs_consumer_running` gauge.
- A DLQ alarm per cluster — fires when messages dead-letter after five
  failed deliveries.

Wire both to `alarm_actions`.

## Notes

- SNS subscriptions use `raw_message_delivery = true`; the controller also
  understands the enveloped form if you subscribe without it.
- Queue retention is one hour — the controller's fallback poller covers
  missed or older events, so longer retention adds nothing.
- The event carries the secret's friendly name and ARN but never the secret
  value; the controller fetches the value itself via `GetSecretValue`.
- `.terraform.lock.hcl` is tracked for reference; when this directory is used
  as a called module, the root module's lock file is what Terraform honors.
