# ============================================================================
# 🇮🇳 Mumbai Hub EKS Cluster (Origin Core, DBs, Transcoder & APAC Edge)
# ============================================================================

# --- IAM Roles for Mumbai EKS Control Plane ---
resource "aws_iam_role" "mumbai_cluster" {
  provider = aws.mumbai
  name     = "${var.cluster_name_prefix}-mumbai-cluster-role"

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

resource "aws_iam_role_policy_attachment" "mumbai_cluster_policy" {
  provider   = aws.mumbai
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
  role       = aws_iam_role.mumbai_cluster.name
}

resource "aws_iam_role_policy_attachment" "mumbai_vpc_resource_controller" {
  provider   = aws.mumbai
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSVPCResourceController"
  role       = aws_iam_role.mumbai_cluster.name
}

# --- Mumbai EKS Control Plane ---
resource "aws_eks_cluster" "mumbai" {
  provider = aws.mumbai
  name     = "${var.cluster_name_prefix}-mumbai"
  version  = var.kubernetes_version
  role_arn = aws_iam_role.mumbai_cluster.arn

  vpc_config {
    subnet_ids              = concat(aws_subnet.mumbai_public[*].id, aws_subnet.mumbai_private[*].id)
    endpoint_private_access = true
    endpoint_public_access  = true
  }

  depends_on = [
    aws_iam_role_policy_attachment.mumbai_cluster_policy,
    aws_iam_role_policy_attachment.mumbai_vpc_resource_controller,
  ]

  tags = {
    Name = "${var.cluster_name_prefix}-mumbai"
    Role = "Hub-Origin"
  }
}

# --- IAM Role for Mumbai Worker Node Groups ---
resource "aws_iam_role" "mumbai_node_group" {
  provider = aws.mumbai
  name     = "${var.cluster_name_prefix}-mumbai-nodegroup-role"

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

resource "aws_iam_role_policy_attachment" "mumbai_worker_node" {
  provider   = aws.mumbai
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy"
  role       = aws_iam_role.mumbai_node_group.name
}

resource "aws_iam_role_policy_attachment" "mumbai_cni" {
  provider   = aws.mumbai
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy"
  role       = aws_iam_role.mumbai_node_group.name
}

resource "aws_iam_role_policy_attachment" "mumbai_registry" {
  provider   = aws.mumbai
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
  role       = aws_iam_role.mumbai_node_group.name
}

resource "aws_iam_role_policy_attachment" "mumbai_ebs_csi" {
  provider   = aws.mumbai
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy"
  role       = aws_iam_role.mumbai_node_group.name
}

# --- Node Group 1: Core Stateful Nodes (Postgres, MinIO, Kafka, Redis, API) ---
resource "aws_eks_node_group" "mumbai_core" {
  provider        = aws.mumbai
  cluster_name    = aws_eks_cluster.mumbai.name
  node_group_name = "${var.cluster_name_prefix}-mumbai-core-nodes"
  node_role_arn   = aws_iam_role.mumbai_node_group.arn
  subnet_ids      = aws_subnet.mumbai_private[*].id
  instance_types  = [var.core_instance_type]

  scaling_config {
    desired_size = var.core_desired_capacity
    max_size     = var.core_max_capacity
    min_size     = var.core_min_capacity
  }

  update_config {
    max_unavailable = 1
  }

  labels = {
    "role"      = "core-origin"
    "component" = "control-plane"
  }

  depends_on = [
    aws_iam_role_policy_attachment.mumbai_worker_node,
    aws_iam_role_policy_attachment.mumbai_cni,
    aws_iam_role_policy_attachment.mumbai_registry,
  ]

  tags = {
    Name = "${var.cluster_name_prefix}-mumbai-core-nodes"
  }
}

# --- Node Group 2: FFmpeg Transcoder Workers (Compute-Optimized c6i) ---
resource "aws_eks_node_group" "mumbai_transcoder" {
  provider        = aws.mumbai
  cluster_name    = aws_eks_cluster.mumbai.name
  node_group_name = "${var.cluster_name_prefix}-mumbai-transcoder-nodes"
  node_role_arn   = aws_iam_role.mumbai_node_group.arn
  subnet_ids      = aws_subnet.mumbai_private[*].id
  instance_types  = [var.transcoder_instance_type]

  scaling_config {
    desired_size = 1
    max_size     = 10
    min_size     = 0
  }

  labels = {
    "role"      = "transcoder"
    "component" = "compute-worker"
  }

  depends_on = [
    aws_iam_role_policy_attachment.mumbai_worker_node,
    aws_iam_role_policy_attachment.mumbai_cni,
    aws_iam_role_policy_attachment.mumbai_registry,
  ]

  tags = {
    Name = "${var.cluster_name_prefix}-mumbai-transcoder-nodes"
  }
}

# --- Node Group 3: APAC Edge Node Group (In-Memory HLS Delivery) ---
resource "aws_eks_node_group" "mumbai_edge" {
  provider        = aws.mumbai
  cluster_name    = aws_eks_cluster.mumbai.name
  node_group_name = "${var.cluster_name_prefix}-mumbai-edge-nodes"
  node_role_arn   = aws_iam_role.mumbai_node_group.arn
  subnet_ids      = aws_subnet.mumbai_private[*].id
  instance_types  = [var.edge_instance_type]

  scaling_config {
    desired_size = var.edge_desired_capacity
    max_size     = var.edge_max_capacity
    min_size     = var.edge_min_capacity
  }

  labels = {
    "role"      = "edge-node"
    "region"    = var.mumbai_region
    "component" = "data-plane"
  }

  depends_on = [
    aws_iam_role_policy_attachment.mumbai_worker_node,
    aws_iam_role_policy_attachment.mumbai_cni,
    aws_iam_role_policy_attachment.mumbai_registry,
  ]

  tags = {
    Name = "${var.cluster_name_prefix}-mumbai-edge-nodes"
  }
}

# --- EBS CSI Driver Addon (for persistent storage claims in Mumbai) ---
resource "aws_eks_addon" "mumbai_ebs_csi" {
  provider     = aws.mumbai
  cluster_name = aws_eks_cluster.mumbai.name
  addon_name   = "aws-ebs-csi-driver"

  depends_on = [aws_eks_node_group.mumbai_core]
}
