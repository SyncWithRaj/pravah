terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}

# Fetch latest Ubuntu 24.04 LTS AMI for the target Edge region
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# 1. Dedicated VPC for Edge Node
resource "aws_vpc" "edge_vpc" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name        = "pravah-${var.edge_node_id}-vpc"
    Environment = "production"
    Region      = var.edge_region
    Project     = "pravah-cdn"
  }
}

# 2. Internet Gateway
resource "aws_internet_gateway" "edge_igw" {
  vpc_id = aws_vpc.edge_vpc.id

  tags = {
    Name    = "pravah-${var.edge_node_id}-igw"
    Project = "pravah-cdn"
  }
}

# 3. Public Subnet
resource "aws_subnet" "edge_public_subnet" {
  vpc_id                  = aws_vpc.edge_vpc.id
  cidr_block              = var.subnet_cidr
  map_public_ip_on_launch = true
  availability_zone       = "${var.region}a"

  tags = {
    Name    = "pravah-${var.edge_node_id}-public-subnet"
    Project = "pravah-cdn"
  }
}

# 4. Route Table
resource "aws_route_table" "edge_public_rt" {
  vpc_id = aws_vpc.edge_vpc.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.edge_igw.id
  }

  tags = {
    Name    = "pravah-${var.edge_node_id}-public-rt"
    Project = "pravah-cdn"
  }
}

resource "aws_route_table_association" "edge_rta" {
  subnet_id      = aws_subnet.edge_public_subnet.id
  route_table_id = aws_route_table.edge_public_rt.id
}

# 5. Edge Security Group
resource "aws_security_group" "edge_sg" {
  name        = "pravah-${var.edge_node_id}-sg"
  description = "Security group for Pravah Edge Node (Sub-10ms CDN delivery)"
  vpc_id      = aws_vpc.edge_vpc.id

  # SSH
  ingress {
    description = "SSH Access"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.allowed_ssh_cidr]
  }

  # Pravah Edge Content API (Fast Data Plane Delivery)
  ingress {
    description = "Pravah Edge Content Delivery API"
    from_port   = 3001
    to_port     = 3001
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Outbound to all
  egress {
    description = "Allow all outbound traffic"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name    = "pravah-${var.edge_node_id}-sg"
    Project = "pravah-cdn"
  }
}

# 6. Edge EC2 Instance (t3.small)
resource "aws_instance" "edge_server" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  key_name               = var.key_name
  subnet_id              = aws_subnet.edge_public_subnet.id
  vpc_security_group_ids = [aws_security_group.edge_sg.id]

  root_block_device {
    volume_size           = 20
    volume_type           = "gp3"
    delete_on_termination = true
  }

  user_data = templatefile("${path.module}/scripts/user_data.sh", {
    github_repo_url = var.github_repo_url
    edge_node_id    = var.edge_node_id
    edge_region     = var.edge_region
    core_public_ip  = var.core_public_ip
  })

  tags = {
    Name    = "pravah-${var.edge_node_id}-server"
    Role    = "edge-node"
    Region  = var.edge_region
    Project = "pravah-cdn"
  }
}

# 7. Static Elastic IP for Edge Node
resource "aws_eip" "edge_eip" {
  instance = aws_instance.edge_server.id
  domain   = "vpc"

  tags = {
    Name    = "pravah-${var.edge_node_id}-eip"
    Project = "pravah-cdn"
  }
}
