# ============================================================================
# High-Scale Load Generator Instance (k6 100k RPS Stress Testing)
# ============================================================================

data "aws_ami" "amazon_linux_2023_mumbai" {
  provider    = aws.mumbai
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-*-x86_64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

resource "aws_security_group" "load_generator" {
  provider    = aws.mumbai
  count       = var.enable_load_generator ? 1 : 0
  name_prefix = "${var.cluster_name_prefix}-loadgen-sg-"
  vpc_id      = aws_vpc.mumbai.id

  # SSH Ingress
  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.cluster_name_prefix}-loadgen-sg"
  }
}

resource "tls_private_key" "load_generator" {
  count     = var.enable_load_generator ? 1 : 0
  algorithm = "RSA"
  rsa_bits  = 4096
}

resource "aws_key_pair" "load_generator" {
  provider   = aws.mumbai
  count      = var.enable_load_generator ? 1 : 0
  key_name   = "${var.cluster_name_prefix}-loadgen-key"
  public_key = tls_private_key.load_generator[0].public_key_openssh
}

resource "local_file" "load_generator_pem" {
  count           = var.enable_load_generator ? 1 : 0
  content         = tls_private_key.load_generator[0].private_key_pem
  filename        = "${path.module}/loadgen-key.pem"
  file_permission = "0400"
}

resource "aws_instance" "load_generator" {
  provider                    = aws.mumbai
  count                       = var.enable_load_generator ? 1 : 0
  ami                         = data.aws_ami.amazon_linux_2023_mumbai.id
  instance_type               = var.load_generator_instance_type
  key_name                    = aws_key_pair.load_generator[0].key_name
  subnet_id                   = aws_subnet.mumbai_public[0].id
  vpc_security_group_ids      = [aws_security_group.load_generator[0].id]
  associate_public_ip_address = true

  root_block_device {
    volume_size = 50
    volume_type = "gp3"
  }

  user_data = <<-USERDATA
    #!/bin/bash
    set -e

    # 1. High-Performance Kernel & Socket Tuning for 100k Concurrent Connections
    cat << 'SYSCTL' >> /etc/sysctl.conf
    fs.file-max = 2097152
    net.core.somaxconn = 65535
    net.ipv4.tcp_max_syn_backlog = 65535
    net.ipv4.ip_local_port_range = 1024 65535
    net.ipv4.tcp_tw_reuse = 1
    net.ipv4.tcp_fin_timeout = 15
    net.core.netdev_max_backlog = 100000
    net.core.rmem_max = 16777216
    net.core.wmem_max = 16777216
    SYSCTL
    sysctl -p

    cat << 'LIMITS' >> /etc/security/limits.conf
    * soft nofile 1048576
    * hard nofile 1048576
    * soft nproc 1048576
    * hard nproc 1048576
    LIMITS

    # 2. Install k6 load testing engine
    dnf install -y https://dl.k6.io/rpm/repo.rpm || true
    dnf install -y k6 || {
      curl -sL https://github.com/grafana/k6/releases/download/v0.52.0/k6-v0.52.0-linux-amd64.tar.gz | tar xz
      mv k6-v0.52.0-linux-amd64/k6 /usr/local/bin/k6
    }

    # 3. Install kubectl & AWS CLI
    curl -Lo /usr/local/bin/kubectl "https://dl.k8s.io/release/v1.30.0/bin/linux/amd64/kubectl"
    chmod +x /usr/local/bin/kubectl

    # 4. Create 100k RPS k6 Test Script
    cat > /home/ec2-user/pravah_100k_benchmark.js << 'K6SCRIPT'
    import http from 'k6/http';
    import { check } from 'k6';
    import { Rate, Trend } from 'k6/metrics';

    const errorRate = new Rate('errors');
    const edgeLatency = new Trend('edge_latency_ms', true);

    const TARGET_URL = __ENV.TARGET_URL || 'http://localhost:3001';

    export const options = {
      scenarios: {
        ramp_to_100k: {
          executor: 'ramping-arrival-rate',
          startRate: 1000,
          timeUnit: '1s',
          preAllocatedVUs: 2000,
          maxVUs: 10000,
          stages: [
            { duration: '15s', target: 10000 },   // Warm-up: 10k RPS
            { duration: '20s', target: 50000 },   // Ramp: 50k RPS
            { duration: '30s', target: 100000 },  // 🚀 PEAK: 100,000 RPS Sustained
            { duration: '15s', target: 50000 },   // Ramp-down: 50k RPS
            { duration: '10s', target: 5000 },    // Cool-down
          ],
        },
      },
      thresholds: {
        http_req_duration: ['p(95)<30', 'p(99)<75'],
        errors: ['rate<0.01'],
      },
    };

    export default function () {
      const res = http.get(`$${TARGET_URL}/health`, {
        headers: { 'Connection': 'keep-alive' },
      });

      const success = check(res, {
        'status is 200': (r) => r.status === 200,
      });

      errorRate.add(!success);
      edgeLatency.add(res.timings.duration);
    }
    K6SCRIPT

    chown -R ec2-user:ec2-user /home/ec2-user/
  USERDATA

  tags = {
    Name = "${var.cluster_name_prefix}-load-generator"
  }
}
