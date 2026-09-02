variable "region" {
  description = "AWS region for the Core Control Plane node"
  type        = string
  default     = "ap-south-1"
}

variable "instance_type" {
  description = "EC2 instance type for Core Control Plane (Control Plane + DB + MinIO + Redpanda)"
  type        = string
  default     = "t3.medium"
}

variable "key_name" {
  description = "AWS Key Pair name for SSH access"
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR block for the Core VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "subnet_cidr" {
  description = "CIDR block for the Core public subnet"
  type        = string
  default     = "10.0.1.0/24"
}

variable "github_repo_url" {
  description = "GitHub repository URL to clone Pravah CDN"
  type        = string
  default     = "https://github.com/SyncWithRaj/pravah.git"
}

variable "allowed_ssh_cidr" {
  description = "CIDR block allowed to SSH into the instance"
  type        = string
  default     = "0.0.0.0/0"
}
