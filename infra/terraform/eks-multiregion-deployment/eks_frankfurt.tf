# ============================================================================
# 🇩🇪 Frankfurt Spoke EKS Cluster (EMEA Europe Edge CDN - eu-central-1)
# ============================================================================

# --- IAM Roles for Frankfurt EKS Control Plane ---
resource "aws_iam_role" "frankfurt_cluster" {
  provider = aws.frankfurt
  name     = "${var.cluster_name_prefix}-frankfurt-cluster-role"

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

resource "aws_iam_role_policy_attachment" "frankfurt_cluster_policy" {
  provider   = aws.frankfurt
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
  role       = aws_iam_role.frankfurt_cluster.name
}

resource "aws_iam_role_policy_attachment" "frankfurt_vpc_resource_controller" {
  provider   = aws.frankfurt
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSVPCResourceController"
  role       = aws_iam_role.frankfurt_cluster.name
}

# --- Frankfurt EKS Control Plane ---
resource "aws_eks_cluster" "frankfurt" {
  provider = aws.frankfurt
  name     = "${var.cluster_name_prefix}-frankfurt"
  version  = var.kubernetes_version
  role_arn = aws_iam_role.frankfurt_cluster.arn

  vpc_config {
    subnet_ids              = concat(aws_subnet.frankfurt_public[*].id, aws_subnet.frankfurt_private[*].id)
    endpoint_private_access = true
    endpoint_public_access  = true
  }

  depends_on = [
    aws_iam_role_policy_attachment.frankfurt_cluster_policy,
    aws_iam_role_policy_attachment.frankfurt_vpc_resource_controller,
  ]

  tags = {
    Name = "${var.cluster_name_prefix}-frankfurt"
    Role = "Spoke-EMEA-Edge"
  }
}

# --- IAM Role for Frankfurt Edge Worker Nodes ---
resource "aws_iam_role" "frankfurt_node_group" {
  provider = aws.frankfurt
  name     = "${var.cluster_name_prefix}-frankfurt-nodegroup-role"

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

resource "aws_iam_role_policy_attachment" "frankfurt_worker_node" {
  provider   = aws.frankfurt
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy"
  role       = aws_iam_role.frankfurt_node_group.name
}

resource "aws_iam_role_policy_attachment" "frankfurt_cni" {
  provider   = aws.frankfurt
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy"
  role       = aws_iam_role.frankfurt_node_group.name
}

resource "aws_iam_role_policy_attachment" "frankfurt_registry" {
  provider   = aws.frankfurt
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
  role       = aws_iam_role.frankfurt_node_group.name
}

# --- Frankfurt Edge Managed Node Group (Auto-Scaling for Europe) ---
resource "aws_eks_node_group" "frankfurt_edge" {
  provider        = aws.frankfurt
  cluster_name    = aws_eks_cluster.frankfurt.name
  node_group_name = "${var.cluster_name_prefix}-frankfurt-edge-nodes"
  node_role_arn   = aws_iam_role.frankfurt_node_group.arn
  subnet_ids      = aws_subnet.frankfurt_private[*].id
  instance_types  = [var.edge_instance_type]

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
    "region"    = var.frankfurt_region
    "component" = "data-plane"
  }

  depends_on = [
    aws_iam_role_policy_attachment.frankfurt_worker_node,
    aws_iam_role_policy_attachment.frankfurt_cni,
    aws_iam_role_policy_attachment.frankfurt_registry,
  ]

  tags = {
    Name = "${var.cluster_name_prefix}-frankfurt-edge-nodes"
  }
}
