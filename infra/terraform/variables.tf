variable "core_region" {
  description = "AWS region for Pravah Central Core Control Plane (Storage Origin & Metadata DB)"
  type        = string
  default     = "ap-south-1"
}

variable "core_instance_type" {
  description = "EC2 instance type for Core Control Plane (Control Plane + DB + MinIO + Redpanda)"
  type        = string
  default     = "t3.medium"
}

variable "edge_instance_type" {
  description = "EC2 instance type for Global Edge Nodes (Data Plane + RAM Cache)"
  type        = string
  default     = "t3.small"
}

variable "aws_key_name" {
  description = "Name of the AWS EC2 Key Pair to attach to all instances for SSH access"
  type        = string
  default     = "pravah-key"
}

variable "github_repo_url" {
  description = "GitHub repository URL to clone and deploy Pravah CDN"
  type        = string
  default     = "https://github.com/SyncWithRaj/pravah.git"
}

variable "allowed_ssh_cidr" {
  description = "CIDR block allowed to SSH into all instances"
  type        = string
  default     = "0.0.0.0/0"
}
