terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}

# Fetch latest Ubuntu 24.04 LTS AMI for the target region
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

# 1. Dedicated VPC for Pravah Core Stack
resource "aws_vpc" "core_vpc" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name        = "pravah-core-vpc"
    Environment = "production"
    Project     = "pravah-cdn"
  }
}

# 2. Internet Gateway
resource "aws_internet_gateway" "core_igw" {
  vpc_id = aws_vpc.core_vpc.id

  tags = {
    Name    = "pravah-core-igw"
    Project = "pravah-cdn"
  }
}

# 3. Public Subnet
resource "aws_subnet" "core_public_subnet" {
  vpc_id                  = aws_vpc.core_vpc.id
  cidr_block              = var.subnet_cidr
  map_public_ip_on_launch = true
  availability_zone       = "${var.region}a"

  tags = {
    Name    = "pravah-core-public-subnet"
    Project = "pravah-cdn"
  }
}

# 4. Route Table
resource "aws_route_table" "core_public_rt" {
  vpc_id = aws_vpc.core_vpc.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.core_igw.id
  }

  tags = {
    Name    = "pravah-core-public-rt"
    Project = "pravah-cdn"
  }
}

resource "aws_route_table_association" "core_rta" {
  subnet_id      = aws_subnet.core_public_subnet.id
  route_table_id = aws_route_table.core_public_rt.id
}

# 5. Core Security Group
resource "aws_security_group" "core_sg" {
  name        = "pravah-core-security-group"
  description = "Security group for Pravah Core Control Plane, Storage & Observability"
  vpc_id      = aws_vpc.core_vpc.id

  # SSH
  ingress {
    description = "SSH Access"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.allowed_ssh_cidr]
  }

  # Pravah Core Control Plane API
  ingress {
    description = "Pravah Core API"
    from_port   = 3000
    to_port     = 3000
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # MinIO S3 API & Console
  ingress {
    description = "MinIO Object Storage S3 API"
    from_port   = 9000
    to_port     = 9000
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "MinIO Web Console"
    from_port   = 9001
    to_port     = 9001
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Redpanda / Kafka Distributed Event Broker (for Edge Replication)
  ingress {
    description = "Kafka Broker (Outside Access for Edges)"
    from_port   = 19092
    to_port     = 19092
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Observability Ports
  ingress {
    description = "Grafana Dashboard"
    from_port   = 3002
    to_port     = 3002
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "Prometheus Metrics"
    from_port   = 9090
    to_port     = 9090
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "Jaeger Distributed Tracing UI"
    from_port   = 16686
    to_port     = 16686
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "OpenTelemetry OTLP Receiver (HTTP & gRPC)"
    from_port   = 4317
    to_port     = 4318
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
    Name    = "pravah-core-sg"
    Project = "pravah-cdn"
  }
}

# 6. Core EC2 Instance
resource "aws_instance" "core_server" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  key_name               = var.key_name
  subnet_id              = aws_subnet.core_public_subnet.id
  vpc_security_group_ids = [aws_security_group.core_sg.id]

  root_block_device {
    volume_size           = 30
    volume_type           = "gp3"
    delete_on_termination = true
  }

  user_data = templatefile("${path.module}/scripts/user_data.sh", {
    github_repo_url = var.github_repo_url
  })

  tags = {
    Name    = "pravah-core-server"
    Role    = "control-plane"
    Project = "pravah-cdn"
  }
}

# 7. Static Elastic IP for Pravah Core
resource "aws_eip" "core_eip" {
  instance = aws_instance.core_server.id
  domain   = "vpc"

  tags = {
    Name    = "pravah-core-eip"
    Project = "pravah-cdn"
  }
}
