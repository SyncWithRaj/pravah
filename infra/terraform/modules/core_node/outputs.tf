output "public_ip" {
  description = "Public IP address of the Pravah Core server"
  value       = aws_eip.core_eip.public_ip
}

output "public_dns" {
  description = "Public DNS name of the Pravah Core Elastic IP"
  value       = aws_eip.core_eip.public_dns
}

output "instance_id" {
  description = "EC2 Instance ID of the Pravah Core server"
  value       = aws_instance.core_server.id
}

output "core_api_url" {
  description = "Direct URL for the Core Control Plane API"
  value       = "http://${aws_eip.core_eip.public_ip}:3000"
}

output "grafana_url" {
  description = "Direct URL for the Grafana Dashboard"
  value       = "http://${aws_eip.core_eip.public_ip}:3002"
}

output "dashboard_url" {
  description = "Direct URL for the Pravah Control Center Dashboard UI"
  value       = "http://${aws_eip.core_eip.public_ip}:8080"
}

output "jaeger_url" {
  description = "Direct URL for the Jaeger Distributed Tracing UI"
  value       = "http://${aws_eip.core_eip.public_ip}:16686"
}
