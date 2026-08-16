# ==============================================================================
# Pravah Core Control Plane Outputs
# ==============================================================================

output "core_public_ip" {
  description = "Public IP of the Pravah Central Core Control Plane"
  value       = module.core_node.public_ip
}

output "core_api_url" {
  description = "Central Core Control Plane API endpoint"
  value       = module.core_node.core_api_url
}

output "grafana_dashboard_url" {
  description = "Grafana Observability Dashboard URL"
  value       = module.core_node.grafana_url
}

output "jaeger_tracing_url" {
  description = "Jaeger Distributed Request Waterfall UI URL"
  value       = module.core_node.jaeger_url
}

output "minio_console_url" {
  description = "MinIO Object Storage Console URL"
  value       = "http://${module.core_node.public_ip}:9001"
}

# ==============================================================================
# Global Multi-Region Edge Node Outputs
# ==============================================================================

output "edge_mumbai_url" {
  description = "Edge Node 01 (Mumbai - ap-south-1) Content Delivery URL"
  value       = module.edge_mumbai.edge_content_url
}

output "edge_us_east_url" {
  description = "Edge Node 02 (Virginia - us-east-1) Content Delivery URL"
  value       = module.edge_us_east.edge_content_url
}

output "edge_eu_central_url" {
  description = "Edge Node 03 (Frankfurt - eu-central-1) Content Delivery URL"
  value       = module.edge_eu_central.edge_content_url
}

# ==============================================================================
# Quick Verification Summary
# ==============================================================================

output "deployment_summary" {
  description = "Deployment summary and curl test instructions"
  value       = <<-EOT
    ====================================================================
    Pravah Distributed CDN — Production AWS Deployment Ready!
    ====================================================================
    Control Plane (Mumbai):  ${module.core_node.core_api_url}
    Grafana Dashboard:       ${module.core_node.grafana_url}
    Jaeger Tracing UI:       ${module.core_node.jaeger_url}
    
    Global Edge Nodes:
      • Asia (Mumbai):       ${module.edge_mumbai.edge_content_url}
      • US East (Virginia):  ${module.edge_us_east.edge_content_url}
      • Europe (Frankfurt):  ${module.edge_eu_central.edge_content_url}
    ====================================================================
  EOT
}
