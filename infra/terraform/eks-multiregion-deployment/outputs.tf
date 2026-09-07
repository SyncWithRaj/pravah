# ============================================================================
# Pravah CDN — Multi-Region EKS Architecture Outputs
# ============================================================================

# --- 1. 🇮🇳 Mumbai Hub Outputs ---
output "mumbai_cluster_name" {
  description = "Mumbai EKS Cluster Name"
  value       = aws_eks_cluster.mumbai.name
}

output "mumbai_cluster_endpoint" {
  description = "Mumbai EKS Control Plane Endpoint"
  value       = aws_eks_cluster.mumbai.endpoint
}

output "mumbai_kubeconfig_command" {
  description = "Command to connect kubectl to Mumbai Hub Cluster"
  value       = "aws eks update-kubeconfig --region ${var.mumbai_region} --name ${aws_eks_cluster.mumbai.name} --alias pravah-mumbai"
}

# --- 2. 🇺🇸 Virginia Spoke Outputs ---
output "virginia_cluster_name" {
  description = "Virginia EKS Cluster Name"
  value       = aws_eks_cluster.virginia.name
}

output "virginia_cluster_endpoint" {
  description = "Virginia EKS Control Plane Endpoint"
  value       = aws_eks_cluster.virginia.endpoint
}

output "virginia_kubeconfig_command" {
  description = "Command to connect kubectl to Virginia Americas Spoke Cluster"
  value       = "aws eks update-kubeconfig --region ${var.virginia_region} --name ${aws_eks_cluster.virginia.name} --alias pravah-virginia"
}

# --- 3. 🇩🇪 Frankfurt Spoke Outputs ---
output "frankfurt_cluster_name" {
  description = "Frankfurt EKS Cluster Name"
  value       = aws_eks_cluster.frankfurt.name
}

output "frankfurt_cluster_endpoint" {
  description = "Frankfurt EKS Control Plane Endpoint"
  value       = aws_eks_cluster.frankfurt.endpoint
}

output "frankfurt_kubeconfig_command" {
  description = "Command to connect kubectl to Frankfurt EMEA Spoke Cluster"
  value       = "aws eks update-kubeconfig --region ${var.frankfurt_region} --name ${aws_eks_cluster.frankfurt.name} --alias pravah-frankfurt"
}

# --- 4. ⚡ Load Generator Outputs ---
output "load_generator_public_ip" {
  description = "Public IP address of the dedicated k6 load generator instance"
  value       = var.enable_load_generator ? aws_instance.load_generator[0].public_ip : "Disabled"
}

output "load_generator_ssh_command" {
  description = "SSH connection command for the k6 load generator"
  value       = var.enable_load_generator ? "ssh -i loadgen-key.pem ec2-user@${aws_instance.load_generator[0].public_ip}" : "Disabled"
}

output "benchmark_run_command" {
  description = "Command to execute the 100k RPS benchmark from the load generator"
  value       = var.enable_load_generator ? "ssh -i loadgen-key.pem ec2-user@${aws_instance.load_generator[0].public_ip} 'TARGET_URL=http://<YOUR_ALB_ENDPOINT> k6 run pravah_100k_benchmark.js'" : "Disabled"
}
