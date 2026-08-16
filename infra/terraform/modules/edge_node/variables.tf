variable "region" {
  description = "AWS region where this Edge Node is deployed"
  type        = string
}

variable "edge_node_id" {
  description = "Unique Identifier for this Edge Node (e.g., edge-node-02)"
  type        = string
}

variable "edge_region" {
  description = "Geographic region code for CDN routing (e.g., us-east-1, eu-central-1)"
  type        = string
}

variable "instance_type" {
  description = "EC2 instance type for Edge Node (Data Plane + RAM Cache)"
  type        = string
  default     = "t3.small"
}

variable "key_name" {
  description = "AWS Key Pair name for SSH access"
  type        = string
}

variable "core_public_ip" {
  description = "Public IP address of the Central Pravah Core instance"
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR block for the Edge VPC"
  type        = string
  default     = "10.1.0.0/16"
}

variable "subnet_cidr" {
  description = "CIDR block for the Edge public subnet"
  type        = string
  default     = "10.1.1.0/24"
}

variable "github_repo_url" {
  description = "GitHub repository URL to clone Pravah CDN"
  type        = string
  default     = "https://github.com/SyncWithRaj/pravah.git"
}

variable "allowed_ssh_cidr" {
  description = "CIDR block allowed to SSH into the Edge instance"
  type        = string
  default     = "0.0.0.0/0"
}
