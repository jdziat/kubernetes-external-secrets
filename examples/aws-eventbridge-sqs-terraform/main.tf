# Example composition: one shared event bus, one fully-deployed cluster.
# For additional clusters, add a helm provider alias per cluster and another
# module "cluster" block passing `providers = { helm = helm.<alias> }` —
# Terraform providers cannot be created per for_each, which is why the
# cluster module is instantiated once per cluster.

terraform {
  required_version = ">= 1.3"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 3.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

provider "helm" {
  kubernetes = {
    config_path    = var.kubeconfig_path
    config_context = var.kubeconfig_context
  }
}

module "event_bus" {
  source = "./modules/event-bus"

  name_prefix          = var.name_prefix
  secret_name_prefixes = var.secret_name_prefixes
  tags                 = var.tags
}

module "cluster" {
  source = "./modules/cluster"

  cluster_name      = var.cluster_name
  name_prefix       = var.name_prefix
  sns_topic_arn     = module.event_bus.sns_topic_arn
  oidc_provider_arn = var.oidc_provider_arn
  secret_arns       = var.secret_arns
  alarm_actions     = var.alarm_actions
  tags              = var.tags
}
