# ============================================================================
# AWS Multi-Region Providers (Hub: Mumbai, Spokes: Virginia & Frankfurt)
# ============================================================================

# Primary Provider (Mumbai Hub - ap-south-1)
provider "aws" {
  region = var.mumbai_region
  alias  = "mumbai"

  default_tags {
    tags = {
      Project     = "Pravah"
      Environment = var.environment
      ManagedBy   = "Terraform"
      Region      = "Mumbai-ap-south-1"
      Role        = "Hub-Origin"
    }
  }
}

# Default Provider pointing to Mumbai
provider "aws" {
  region = var.mumbai_region

  default_tags {
    tags = {
      Project     = "Pravah"
      Environment = var.environment
      ManagedBy   = "Terraform"
    }
  }
}

# Americas Spoke Provider (North Virginia - us-east-1)
provider "aws" {
  region = var.virginia_region
  alias  = "virginia"

  default_tags {
    tags = {
      Project     = "Pravah"
      Environment = var.environment
      ManagedBy   = "Terraform"
      Region      = "Virginia-us-east-1"
      Role        = "Spoke-Americas-Edge"
    }
  }
}

# EMEA Spoke Provider (Frankfurt - eu-central-1)
provider "aws" {
  region = var.frankfurt_region
  alias  = "frankfurt"

  default_tags {
    tags = {
      Project     = "Pravah"
      Environment = var.environment
      ManagedBy   = "Terraform"
      Region      = "Frankfurt-eu-central-1"
      Role        = "Spoke-EMEA-Edge"
    }
  }
}
