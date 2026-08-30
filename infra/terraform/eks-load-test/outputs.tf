# ============================================================================
# Outputs — Connection details for EKS, ECR, and Load Generator
# ============================================================================

output "eks_cluster_name" {
  description = "EKS Cluster Name"
  value       = aws_eks_cluster.pravah.name
}

output "eks_cluster_endpoint" {
  description = "EKS Cluster API Endpoint"
  value       = aws_eks_cluster.pravah.endpoint
}

output "eks_cluster_ca_cert" {
  description = "EKS Cluster Certificate Authority"
  value       = aws_eks_cluster.pravah.certificate_authority[0].data
  sensitive   = true
}

output "ecr_core_repo_url" {
  description = "ECR Repository URL for Core App"
  value       = aws_ecr_repository.core_app.repository_url
}

output "ecr_edge_repo_url" {
  description = "ECR Repository URL for Edge App"
  value       = aws_ecr_repository.edge_app.repository_url
}

output "load_generator_public_ip" {
  description = "Public IP of the k6 Load Generator EC2 instance"
  value       = aws_instance.load_generator.public_ip
}

output "load_generator_ssh" {
  description = "SSH command to connect to the load generator"
  value       = "ssh -i ${path.module}/loadgen-key.pem ec2-user@${aws_instance.load_generator.public_ip}"
}

output "kubeconfig_command" {
  description = "Command to configure kubectl for this EKS cluster"
  value       = "aws eks update-kubeconfig --name ${var.cluster_name} --region ${var.aws_region}"
}

output "vpc_id" {
  description = "VPC ID"
  value       = aws_vpc.pravah.id
}
