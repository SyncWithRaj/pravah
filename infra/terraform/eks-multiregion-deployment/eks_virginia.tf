# ============================================================================
# 🇺🇸 North Virginia Spoke EKS Cluster (Americas Edge CDN - us-east-1)
# ============================================================================

# --- IAM Roles for Virginia EKS Control Plane ---
resource "aws_iam_role" "virginia_cluster" {
  provider = aws.virginia
  name     = "${var.cluster_name_prefix}-virginia-cluster-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "eks.amazonaws.com"
      }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "virginia_cluster_policy" {
  provider   = aws.virginia
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
  role       = aws_iam_role.virginia_cluster.name
}

resource "aws_iam_role_policy_attachment" "virginia_vpc_resource_controller" {
  provider   = aws.virginia
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSVPCResourceController"
  role       = aws_iam_role.virginia_cluster.name
}

# --- Virginia EKS Control Plane ---
resource "aws_eks_cluster" "virginia" {
  provider = aws.virginia
  name     = "${var.cluster_name_prefix}-virginia"
  version  = var.kubernetes_version
  role_arn = aws_iam_role.virginia_cluster.arn

  vpc_config {
    subnet_ids              = concat(aws_subnet.virginia_public[*].id, aws_subnet.virginia_private[*].id)
    endpoint_private_access = true
    endpoint_public_access  = true
  }

  depends_on = [
    aws_iam_role_policy_attachment.virginia_cluster_policy,
    aws_iam_role_policy_attachment.virginia_vpc_resource_controller,
  ]

  tags = {
    Name = "${var.cluster_name_prefix}-virginia"
    Role = "Spoke-Americas-Edge"
  }
}

# --- IAM Role for Virginia Edge Worker Nodes ---
resource "aws_iam_role" "virginia_node_group" {
  provider = aws.virginia
  name     = "${var.cluster_name_prefix}-virginia-nodegroup-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "ec2.amazonaws.com"
      }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "virginia_worker_node" {
  provider   = aws.virginia
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy"
  role       = aws_iam_role.virginia_node_group.name
}

resource "aws_iam_role_policy_attachment" "virginia_cni" {
  provider   = aws.virginia
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy"
  role       = aws_iam_role.virginia_node_group.name
}

resource "aws_iam_role_policy_attachment" "virginia_registry" {
  provider   = aws.virginia
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
  role       = aws_iam_role.virginia_node_group.name
}

# --- Virginia Edge Managed Node Group (Auto-Scaling for Americas) ---
resource "aws_eks_node_group" "virginia_edge" {
  provider        = aws.virginia
  cluster_name    = aws_eks_cluster.virginia.name
  node_group_name = "${var.cluster_name_prefix}-virginia-edge-nodes"
  node_role_arn   = aws_iam_role.virginia_node_group.arn
  subnet_ids      = aws_subnet.virginia_private[*].id
  instance_types  = [var.edge_instance_type]
  ami_type        = "AL2023_x86_64_STANDARD"

  scaling_config {
    desired_size = var.edge_desired_capacity
    max_size     = var.edge_max_capacity
    min_size     = var.edge_min_capacity
  }

  update_config {
    max_unavailable = 1
  }

  labels = {
    "role"      = "edge-node"
    "region"    = var.virginia_region
    "component" = "data-plane"
  }

  depends_on = [
    aws_iam_role_policy_attachment.virginia_worker_node,
    aws_iam_role_policy_attachment.virginia_cni,
    aws_iam_role_policy_attachment.virginia_registry,
  ]

  tags = {
    Name = "${var.cluster_name_prefix}-virginia-edge-nodes"
  }
}
