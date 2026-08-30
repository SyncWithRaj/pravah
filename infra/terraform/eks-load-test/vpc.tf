# ============================================================================
# VPC — Isolated network for Pravah CDN EKS Load Test
# ============================================================================

data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "pravah" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name = "${var.cluster_name}-vpc"
  }
}

# Public Subnets (2 AZs for EKS requirement)
resource "aws_subnet" "public" {
  count = 2

  vpc_id                  = aws_vpc.pravah.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true

  tags = {
    Name                                        = "${var.cluster_name}-public-${count.index}"
    "kubernetes.io/cluster/${var.cluster_name}" = "shared"
    "kubernetes.io/role/elb"                    = "1"
  }
}

# Private Subnets (for worker nodes)
resource "aws_subnet" "private" {
  count = 2

  vpc_id            = aws_vpc.pravah.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index + 10)
  availability_zone = data.aws_availability_zones.available.names[count.index]

  tags = {
    Name                                        = "${var.cluster_name}-private-${count.index}"
    "kubernetes.io/cluster/${var.cluster_name}" = "shared"
    "kubernetes.io/role/internal-elb"           = "1"
  }
}

# Internet Gateway
resource "aws_internet_gateway" "pravah" {
  vpc_id = aws_vpc.pravah.id

  tags = {
    Name = "${var.cluster_name}-igw"
  }
}

# Elastic IP for NAT Gateway
resource "aws_eip" "nat" {
  domain = "vpc"

  tags = {
    Name = "${var.cluster_name}-nat-eip"
  }
}

# NAT Gateway (for private subnet internet access)
resource "aws_nat_gateway" "pravah" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id

  tags = {
    Name = "${var.cluster_name}-nat"
  }

  depends_on = [aws_internet_gateway.pravah]
}

# Public Route Table
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.pravah.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.pravah.id
  }

  tags = {
    Name = "${var.cluster_name}-public-rt"
  }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# Private Route Table
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.pravah.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.pravah.id
  }

  tags = {
    Name = "${var.cluster_name}-private-rt"
  }
}

resource "aws_route_table_association" "private" {
  count          = 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}
