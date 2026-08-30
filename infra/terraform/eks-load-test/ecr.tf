# ============================================================================
# ECR — Container Registry for Pravah Docker Images
# ============================================================================

resource "aws_ecr_repository" "core_app" {
  name                 = "pravah-core-app"
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = false
  }

  tags = {
    Name = "pravah-core-app"
  }
}

resource "aws_ecr_repository" "edge_app" {
  name                 = "pravah-edge-app"
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = false
  }

  tags = {
    Name = "pravah-edge-app"
  }
}
