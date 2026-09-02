output "public_ip" {
  description = "Public IP address of the Edge Node"
  value       = aws_eip.edge_eip.public_ip
}

output "public_dns" {
  description = "Public DNS name of the Edge Node Elastic IP"
  value       = aws_eip.edge_eip.public_dns
}

output "instance_id" {
  description = "EC2 Instance ID of the Edge server"
  value       = aws_instance.edge_server.id
}

output "edge_content_url" {
  description = "Base Content Delivery URL for this Edge Node"
  value       = "http://${aws_eip.edge_eip.public_ip}:3001"
}

output "edge_node_id" {
  description = "Identifier of the Edge Node"
  value       = var.edge_node_id
}

output "edge_region" {
  description = "Region of the Edge Node"
  value       = var.edge_region
}
