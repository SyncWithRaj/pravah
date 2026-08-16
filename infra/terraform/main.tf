terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# ==============================================================================
# Multi-Region AWS Providers
# ==============================================================================

# 1. Primary Region: Asia Pacific (Mumbai - ap-south-1)
provider "aws" {
  alias  = "mumbai"
  region = "ap-south-1"
}

# 2. Global Edge Region: US East (N. Virginia - us-east-1)
provider "aws" {
  alias  = "us_east"
  region = "us-east-1"
}

# 3. Global Edge Region: Europe (Frankfurt - eu-central-1)
provider "aws" {
  alias  = "eu_central"
  region = "eu-central-1"
}

# ==============================================================================
# Central Core Control Plane (Mumbai - ap-south-1)
# ==============================================================================

module "core_node" {
  source = "./modules/core_node"

  providers = {
    aws = aws.mumbai
  }

  region           = "ap-south-1"
  instance_type    = var.core_instance_type
  key_name         = var.aws_key_name
  vpc_cidr         = "10.0.0.0/16"
  subnet_cidr      = "10.0.1.0/24"
  github_repo_url  = var.github_repo_url
  allowed_ssh_cidr = var.allowed_ssh_cidr
}

# ==============================================================================
# Multi-Region Edge Nodes (Data Plane & RAM Caching)
# ==============================================================================

# Edge Node 01: Mumbai Local Edge (ap-south-1)
module "edge_mumbai" {
  source = "./modules/edge_node"

  providers = {
    aws = aws.mumbai
  }

  region           = "ap-south-1"
  edge_node_id     = "edge-node-01"
  edge_region      = "ap-south-1"
  instance_type    = var.edge_instance_type
  key_name         = var.aws_key_name
  core_public_ip   = module.core_node.public_ip
  vpc_cidr         = "10.1.0.0/16"
  subnet_cidr      = "10.1.1.0/24"
  github_repo_url  = var.github_repo_url
  allowed_ssh_cidr = var.allowed_ssh_cidr

  depends_on = [module.core_node]
}

# Edge Node 02: North America Edge (us-east-1)
module "edge_us_east" {
  source = "./modules/edge_node"

  providers = {
    aws = aws.us_east
  }

  region           = "us-east-1"
  edge_node_id     = "edge-node-02"
  edge_region      = "us-east-1"
  instance_type    = var.edge_instance_type
  key_name         = var.aws_key_name
  core_public_ip   = module.core_node.public_ip
  vpc_cidr         = "10.2.0.0/16"
  subnet_cidr      = "10.2.1.0/24"
  github_repo_url  = var.github_repo_url
  allowed_ssh_cidr = var.allowed_ssh_cidr

  depends_on = [module.core_node]
}

# Edge Node 03: Europe Edge (eu-central-1)
module "edge_eu_central" {
  source = "./modules/edge_node"

  providers = {
    aws = aws.eu_central
  }

  region           = "eu-central-1"
  edge_node_id     = "edge-node-03"
  edge_region      = "eu-central-1"
  instance_type    = var.edge_instance_type
  key_name         = var.aws_key_name
  core_public_ip   = module.core_node.public_ip
  vpc_cidr         = "10.3.0.0/16"
  subnet_cidr      = "10.3.1.0/24"
  github_repo_url  = var.github_repo_url
  allowed_ssh_cidr = var.allowed_ssh_cidr

  depends_on = [module.core_node]
}
