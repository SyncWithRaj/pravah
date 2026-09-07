# ============================================================================
# ECR — Container Registries for Pravah Docker Images (Mumbai Hub)
# ============================================================================

resource "aws_ecr_repository" "core_app" {
  provider             = aws.mumbai
  name                 = "pravah-core-app"
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = false
  }

  tags = {
    Name = "pravah-core-app"
    Role = "Container-Registry"
  }
}

resource "aws_ecr_repository" "edge_app" {
  provider             = aws.mumbai
  name                 = "pravah-edge-app"
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = false
  }

  tags = {
    Name = "pravah-edge-app"
    Role = "Container-Registry"
  }
}

resource "aws_ecr_repository" "dashboard_app" {
  provider             = aws.mumbai
  name                 = "pravah-dashboard"
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = false
  }

  tags = {
    Name = "pravah-dashboard"
    Role = "Container-Registry"
  }
}

output "ecr_repository_urls" {
  description = "ECR Repository URLs for docker tag & push"
  value = {
    core      = aws_ecr_repository.core_app.repository_url
    edge      = aws_ecr_repository.edge_app.repository_url
    dashboard = aws_ecr_repository.dashboard_app.repository_url
  }
}
