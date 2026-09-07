# ============================================================================
# Pravah CDN — Multi-Region EKS Architecture Variables
# ============================================================================

variable "environment" {
  description = "Deployment environment (e.g. production, staging)"
  type        = string
  default     = "production"
}

variable "cluster_name_prefix" {
  description = "Prefix for all regional EKS clusters and resources"
  type        = string
  default     = "pravah"
}

variable "kubernetes_version" {
  description = "Kubernetes control plane version across all EKS clusters"
  type        = string
  default     = "1.30"
}

# --- AWS Regions ---
variable "mumbai_region" {
  description = "Primary Hub Region for Origin Core, DBs, Transcoders & APAC Edge"
  type        = string
  default     = "ap-south-1"
}

variable "virginia_region" {
  description = "Spoke Region for Americas Edge CDN"
  type        = string
  default     = "us-east-1"
}

variable "frankfurt_region" {
  description = "Spoke Region for Europe & EMEA Edge CDN"
  type        = string
  default     = "eu-central-1"
}

# --- Instance Sizing ---
variable "core_instance_type" {
  description = "EC2 Instance type for Central Core Origin & DB nodes"
  type        = string
  default     = "t3.xlarge"
}

variable "edge_instance_type" {
  description = "EC2 Instance type for High-Throughput Edge Caching nodes"
  type        = string
  default     = "c6i.xlarge"
}

variable "transcoder_instance_type" {
  description = "EC2 Instance type for FFmpeg Transcoder compute nodes"
  type        = string
  default     = "c6i.2xlarge"
}

# --- Scaling Limits ---
variable "core_min_capacity" {
  description = "Minimum nodes in Core Stateful node group"
  type        = number
  default     = 2
}

variable "core_max_capacity" {
  description = "Maximum nodes in Core Stateful node group"
  type        = number
  default     = 10
}

variable "core_desired_capacity" {
  description = "Desired nodes in Core Stateful node group"
  type        = number
  default     = 2
}

variable "edge_min_capacity" {
  description = "Minimum nodes in Edge node group per region"
  type        = number
  default     = 2
}

variable "edge_max_capacity" {
  description = "Maximum nodes in Edge node group per region for 100k+ RPS"
  type        = number
  default     = 50
}

variable "edge_desired_capacity" {
  description = "Desired nodes in Edge node group per region"
  type        = number
  default     = 3
}

# --- Load Generator Benchmarking ---
variable "enable_load_generator" {
  description = "Deploy a dedicated high-bandwidth EC2 instance with k6 for 100k RPS testing"
  type        = bool
  default     = true
}

variable "load_generator_instance_type" {
  description = "Instance type for the k6 load generator (e.g. c6i.4xlarge, c6i.8xlarge)"
  type        = string
  default     = "c6i.4xlarge"
}
