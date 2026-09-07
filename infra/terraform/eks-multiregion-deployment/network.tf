# ============================================================================
# Multi-Region VPC Networking (Mumbai: 10.10.0.0/16, Virginia: 10.20.0.0/16, Frankfurt: 10.30.0.0/16)
# ============================================================================

# ----------------------------------------------------------------------------
# 1. 🇮🇳 MUMBAI REGION NETWORKING (Hub - ap-south-1)
# ----------------------------------------------------------------------------
data "aws_availability_zones" "mumbai" {
  provider = aws.mumbai
  state    = "available"
}

resource "aws_vpc" "mumbai" {
  provider             = aws.mumbai
  cidr_block           = "10.10.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name                                                      = "${var.cluster_name_prefix}-vpc-mumbai"
    "kubernetes.io/cluster/${var.cluster_name_prefix}-mumbai" = "shared"
  }
}

resource "aws_internet_gateway" "mumbai" {
  provider = aws.mumbai
  vpc_id   = aws_vpc.mumbai.id

  tags = {
    Name = "${var.cluster_name_prefix}-igw-mumbai"
  }
}

resource "aws_subnet" "mumbai_public" {
  provider                = aws.mumbai
  count                   = 2
  vpc_id                  = aws_vpc.mumbai.id
  cidr_block              = cidrsubnet(aws_vpc.mumbai.cidr_block, 8, count.index + 1)
  availability_zone       = data.aws_availability_zones.mumbai.names[count.index]
  map_public_ip_on_launch = true

  tags = {
    Name                                                      = "${var.cluster_name_prefix}-mumbai-public-${count.index + 1}"
    "kubernetes.io/cluster/${var.cluster_name_prefix}-mumbai" = "shared"
    "kubernetes.io/role/elb"                                  = "1"
  }
}

resource "aws_subnet" "mumbai_private" {
  provider          = aws.mumbai
  count             = 2
  vpc_id            = aws_vpc.mumbai.id
  cidr_block        = cidrsubnet(aws_vpc.mumbai.cidr_block, 8, count.index + 10)
  availability_zone = data.aws_availability_zones.mumbai.names[count.index]

  tags = {
    Name                                                      = "${var.cluster_name_prefix}-mumbai-private-${count.index + 1}"
    "kubernetes.io/cluster/${var.cluster_name_prefix}-mumbai" = "shared"
    "kubernetes.io/role/internal-elb"                         = "1"
  }
}

resource "aws_eip" "mumbai_nat" {
  provider = aws.mumbai
  domain   = "vpc"

  tags = {
    Name = "${var.cluster_name_prefix}-mumbai-nat-eip"
  }
}

resource "aws_nat_gateway" "mumbai" {
  provider      = aws.mumbai
  allocation_id = aws_eip.mumbai_nat.id
  subnet_id     = aws_subnet.mumbai_public[0].id

  tags = {
    Name = "${var.cluster_name_prefix}-mumbai-nat-gw"
  }
}

resource "aws_route_table" "mumbai_public" {
  provider = aws.mumbai
  vpc_id   = aws_vpc.mumbai.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.mumbai.id
  }

  tags = {
    Name = "${var.cluster_name_prefix}-mumbai-public-rt"
  }
}

resource "aws_route_table" "mumbai_private" {
  provider = aws.mumbai
  vpc_id   = aws_vpc.mumbai.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.mumbai.id
  }

  tags = {
    Name = "${var.cluster_name_prefix}-mumbai-private-rt"
  }
}

resource "aws_route_table_association" "mumbai_public" {
  provider       = aws.mumbai
  count          = 2
  subnet_id      = aws_subnet.mumbai_public[count.index].id
  route_table_id = aws_route_table.mumbai_public.id
}

resource "aws_route_table_association" "mumbai_private" {
  provider       = aws.mumbai
  count          = 2
  subnet_id      = aws_subnet.mumbai_private[count.index].id
  route_table_id = aws_route_table.mumbai_private.id
}

# ----------------------------------------------------------------------------
# 2. 🇺🇸 VIRGINIA REGION NETWORKING (Spoke - us-east-1)
# ----------------------------------------------------------------------------
data "aws_availability_zones" "virginia" {
  provider = aws.virginia
  state    = "available"
}

resource "aws_vpc" "virginia" {
  provider             = aws.virginia
  cidr_block           = "10.20.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name                                                        = "${var.cluster_name_prefix}-vpc-virginia"
    "kubernetes.io/cluster/${var.cluster_name_prefix}-virginia" = "shared"
  }
}

resource "aws_internet_gateway" "virginia" {
  provider = aws.virginia
  vpc_id   = aws_vpc.virginia.id

  tags = {
    Name = "${var.cluster_name_prefix}-igw-virginia"
  }
}

resource "aws_subnet" "virginia_public" {
  provider                = aws.virginia
  count                   = 2
  vpc_id                  = aws_vpc.virginia.id
  cidr_block              = cidrsubnet(aws_vpc.virginia.cidr_block, 8, count.index + 1)
  availability_zone       = data.aws_availability_zones.virginia.names[count.index]
  map_public_ip_on_launch = true

  tags = {
    Name                                                        = "${var.cluster_name_prefix}-virginia-public-${count.index + 1}"
    "kubernetes.io/cluster/${var.cluster_name_prefix}-virginia" = "shared"
    "kubernetes.io/role/elb"                                    = "1"
  }
}

resource "aws_subnet" "virginia_private" {
  provider          = aws.virginia
  count             = 2
  vpc_id            = aws_vpc.virginia.id
  cidr_block        = cidrsubnet(aws_vpc.virginia.cidr_block, 8, count.index + 10)
  availability_zone = data.aws_availability_zones.virginia.names[count.index]

  tags = {
    Name                                                        = "${var.cluster_name_prefix}-virginia-private-${count.index + 1}"
    "kubernetes.io/cluster/${var.cluster_name_prefix}-virginia" = "shared"
    "kubernetes.io/role/internal-elb"                           = "1"
  }
}

resource "aws_eip" "virginia_nat" {
  provider = aws.virginia
  domain   = "vpc"

  tags = {
    Name = "${var.cluster_name_prefix}-virginia-nat-eip"
  }
}

resource "aws_nat_gateway" "virginia" {
  provider      = aws.virginia
  allocation_id = aws_eip.virginia_nat.id
  subnet_id     = aws_subnet.virginia_public[0].id

  tags = {
    Name = "${var.cluster_name_prefix}-virginia-nat-gw"
  }
}

resource "aws_route_table" "virginia_public" {
  provider = aws.virginia
  vpc_id   = aws_vpc.virginia.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.virginia.id
  }

  tags = {
    Name = "${var.cluster_name_prefix}-virginia-public-rt"
  }
}

resource "aws_route_table" "virginia_private" {
  provider = aws.virginia
  vpc_id   = aws_vpc.virginia.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.virginia.id
  }

  tags = {
    Name = "${var.cluster_name_prefix}-virginia-private-rt"
  }
}

resource "aws_route_table_association" "virginia_public" {
  provider       = aws.virginia
  count          = 2
  subnet_id      = aws_subnet.virginia_public[count.index].id
  route_table_id = aws_route_table.virginia_public.id
}

resource "aws_route_table_association" "virginia_private" {
  provider       = aws.virginia
  count          = 2
  subnet_id      = aws_subnet.virginia_private[count.index].id
  route_table_id = aws_route_table.virginia_private.id
}

# ----------------------------------------------------------------------------
# 3. 🇩🇪 FRANKFURT REGION NETWORKING (Spoke - eu-central-1)
# ----------------------------------------------------------------------------
data "aws_availability_zones" "frankfurt" {
  provider = aws.frankfurt
  state    = "available"
}

resource "aws_vpc" "frankfurt" {
  provider             = aws.frankfurt
  cidr_block           = "10.30.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name                                                         = "${var.cluster_name_prefix}-vpc-frankfurt"
    "kubernetes.io/cluster/${var.cluster_name_prefix}-frankfurt" = "shared"
  }
}

resource "aws_internet_gateway" "frankfurt" {
  provider = aws.frankfurt
  vpc_id   = aws_vpc.frankfurt.id

  tags = {
    Name = "${var.cluster_name_prefix}-igw-frankfurt"
  }
}

resource "aws_subnet" "frankfurt_public" {
  provider                = aws.frankfurt
  count                   = 2
  vpc_id                  = aws_vpc.frankfurt.id
  cidr_block              = cidrsubnet(aws_vpc.frankfurt.cidr_block, 8, count.index + 1)
  availability_zone       = data.aws_availability_zones.frankfurt.names[count.index]
  map_public_ip_on_launch = true

  tags = {
    Name                                                         = "${var.cluster_name_prefix}-frankfurt-public-${count.index + 1}"
    "kubernetes.io/cluster/${var.cluster_name_prefix}-frankfurt" = "shared"
    "kubernetes.io/role/elb"                                     = "1"
  }
}

resource "aws_subnet" "frankfurt_private" {
  provider          = aws.frankfurt
  count             = 2
  vpc_id            = aws_vpc.frankfurt.id
  cidr_block        = cidrsubnet(aws_vpc.frankfurt.cidr_block, 8, count.index + 10)
  availability_zone = data.aws_availability_zones.frankfurt.names[count.index]

  tags = {
    Name                                                         = "${var.cluster_name_prefix}-frankfurt-private-${count.index + 1}"
    "kubernetes.io/cluster/${var.cluster_name_prefix}-frankfurt" = "shared"
    "kubernetes.io/role/internal-elb"                            = "1"
  }
}

resource "aws_eip" "frankfurt_nat" {
  provider = aws.frankfurt
  domain   = "vpc"

  tags = {
    Name = "${var.cluster_name_prefix}-frankfurt-nat-eip"
  }
}

resource "aws_nat_gateway" "frankfurt" {
  provider      = aws.frankfurt
  allocation_id = aws_eip.frankfurt_nat.id
  subnet_id     = aws_subnet.frankfurt_public[0].id

  tags = {
    Name = "${var.cluster_name_prefix}-frankfurt-nat-gw"
  }
}

resource "aws_route_table" "frankfurt_public" {
  provider = aws.frankfurt
  vpc_id   = aws_vpc.frankfurt.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.frankfurt.id
  }

  tags = {
    Name = "${var.cluster_name_prefix}-frankfurt-public-rt"
  }
}

resource "aws_route_table" "frankfurt_private" {
  provider = aws.frankfurt
  vpc_id   = aws_vpc.frankfurt.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.frankfurt.id
  }

  tags = {
    Name = "${var.cluster_name_prefix}-frankfurt-private-rt"
  }
}

resource "aws_route_table_association" "frankfurt_public" {
  provider       = aws.frankfurt
  count          = 2
  subnet_id      = aws_subnet.frankfurt_public[count.index].id
  route_table_id = aws_route_table.frankfurt_public.id
}

resource "aws_route_table_association" "frankfurt_private" {
  provider       = aws.frankfurt
  count          = 2
  subnet_id      = aws_subnet.frankfurt_private[count.index].id
  route_table_id = aws_route_table.frankfurt_private.id
}
